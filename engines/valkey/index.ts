import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  getDefaultUsername,
  loadCredentials,
  saveCredentials,
} from '../../core/credential-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { valkeyBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  VALKEY_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { getValkeyCliPath, VALKEY_CLI_NOT_FOUND_ERROR } from './cli-utils'
import {
  Engine,
  type Platform,
  type Arch,
  type ContainerConfig,
  type ProgressCallback,
  type BackupFormat,
  type BackupOptions,
  type BackupResult,
  type RestoreResult,
  type DumpResult,
  type StatusResult,
  type QueryResult,
  type QueryOptions,
  type CreateUserOptions,
  type UserCredentials,
} from '../../types'
import { parseRedisResult } from '../../core/query-parser'
import { getLibraryEnv, detectLibraryError } from '../../core/library-env'

const ENGINE = 'valkey'

type ValkeyCliAuth = {
  username?: string
  password?: string
}

function shouldPassValkeyCliUsername(
  username?: string,
): username is string {
  if (!username) {
    return false
  }

  const trimmed = username.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

function buildValkeyCliEnv(
  libraryEnv: Record<string, string | undefined> = {},
  password?: string,
): Record<string, string | undefined> {
  const env = { ...process.env, ...libraryEnv }
  if (password) {
    env.REDISCLI_AUTH = password
  } else {
    delete env.REDISCLI_AUTH
  }
  return env
}

function getValkeyCliBaseDir(valkeyCli: string): string {
  return dirname(dirname(valkeyCli))
}

function getResolvedValkeyCliLibraryEnv(
  valkeyCli: string,
): Record<string, string> | undefined {
  return getLibraryEnv(getValkeyCliBaseDir(valkeyCli))
}

function getLocalCliHost(container: ContainerConfig): string {
  return container.bindAddress ?? '127.0.0.1'
}

async function runValkeyCliCommand(
  valkeyCli: string,
  args: string[],
  options: {
    password?: string
    timeout?: number
    libraryEnv?: Record<string, string | undefined>
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(valkeyCli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildValkeyCliEnv(options.libraryEnv, options.password),
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutId: NodeJS.Timeout | undefined
    let timeoutError: Error | null = null

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (error) {
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    }

    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timeoutError = new Error(
          `valkey-cli 命令超时，超过 ${options.timeout}ms`,
        )
        proc.kill()
      }, options.timeout)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      finish(error)
    })

    proc.on('close', (code) => {
      if (timeoutError) {
        finish(timeoutError)
        return
      }
      if (code === 0) {
        finish()
        return
      }
      finish(new Error(stderr || `valkey-cli 退出码: ${code}`))
    })
  })
}

/**
 * 转义 Valkey 键以供 CLI 命令使用。
 * 转义反斜杠、双引号和控制字符，以防止命令注入
 * 并确保键被 CLI 正确解析。
 */
function escapeKeyForCommand(key: string): string {
  return key
    .replace(/\\/g, '\\\\') // 首先转义反斜杠，防止重复转义
    .replace(/"/g, '\\"') // 双引号
    .replace(/\n/g, '\\n') // 换行
    .replace(/\r/g, '\\r') // 回车
    .replace(/\t/g, '\\t') // 制表符
}
const engineDef = getEngineDefaults(ENGINE)

/**
 * 表示潜在命令注入的 Shell 元字符模式
 * 这些模式不应出现在有效的 Valkey 命令中
 */
const SHELL_INJECTION_PATTERNS = [
  /;\s*\S/, // 命令链接: ; 后跟另一个命令
  /\$\(/, // 命令替换: $(...)
  /\$\{/, // 变量替换: ${...}
  /`/, // 反引号命令替换
  /&&/, // 逻辑 AND 链接
  /\|\|/, // 逻辑 OR 链接
  /\|\s*\S/, // 管道到另一个命令
]

// 验证命令不包含 Shell 注入模式
function validateCommand(command: string): void {
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `命令包含在 Valkey 命令中无效的 Shell 元字符。` +
          `如果需要复杂命令，请改用脚本文件。`,
      )
    }
  }
}

/**
 * 将 Windows 路径转换为 Cygwin 路径格式。
 * Valkey Windows 二进制文件使用 Cygwin 运行时构建，当作为命令行参数传递时，
 * 期望 /cygdrive/c/... 格式的路径。
 *
 * 示例: C:\Users\foo\config.conf -> /cygdrive/c/Users/foo/config.conf
 */
function toCygwinPath(windowsPath: string): string {
  // 匹配开头的驱动器号（如 C:\ 或 D:/）
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (!driveMatch) {
    // 非 Windows 绝对路径，将反斜杠替换为正斜杠后返回
    return windowsPath.replace(/\\/g, '/')
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const restOfPath = windowsPath.slice(3).replace(/\\/g, '/')
  return `/cygdrive/${driveLetter}/${restOfPath}`
}

/**
 * 解析 Valkey 连接字符串
 * 支持的方案：
 * - redis://   （明文，无 TLS）
 * - rediss://  （启用 TLS）
 * - valkey://  （明文，无 TLS）
 * - valkeys:// （启用 TLS）
 *
 * 格式：scheme://[user:password@]host[:port][/database]
 *
 * 示例：
 * - redis://localhost:6379
 * - rediss://secure.host:6379/0  (TLS)
 * - valkey://localhost:6379
 * - valkeys://secure.host:6379   (TLS)
 */
function parseValkeyConnectionString(connectionString: string): {
  host: string
  port: number
  username: string | undefined
  password: string | undefined
  database: number
  tls: boolean
} {
  let url: URL

  const normalized = connectionString.trim()

  // 检查有效方案
  const validSchemes = ['redis://', 'rediss://', 'valkey://', 'valkeys://']
  const hasValidScheme = validSchemes.some((scheme) =>
    normalized.startsWith(scheme),
  )

  if (!hasValidScheme) {
    throw new Error(
      `无效的 Valkey 连接字符串: ${connectionString}\n` +
        '期望格式: scheme://[user:password@]host:port[/database]\n' +
        '支持的方案: redis://, rediss://, valkey://, valkeys://\n' +
        '（使用 rediss:// 或 valkeys:// 进行 TLS 连接）',
    )
  }

  // 将 valkey(s):// 标准化为 redis(s):// 以供 URL 解析
  let urlString = normalized
  if (normalized.startsWith('valkeys://')) {
    urlString = normalized.replace('valkeys://', 'rediss://')
  } else if (normalized.startsWith('valkey://')) {
    urlString = normalized.replace('valkey://', 'redis://')
  }

  try {
    url = new URL(urlString)
  } catch {
    throw new Error(
      `无效的 Valkey 连接字符串: ${connectionString}\n` +
        '期望格式: scheme://[user:password@]host:port[/database]',
    )
  }

  // 根据原始方案判断是否使用 TLS
  const tls =
    normalized.startsWith('rediss://') || normalized.startsWith('valkeys://')

  const host = url.hostname || 'localhost'
  const port = parseInt(url.port, 10) || 6379

  // Valkey 支持 ACL 及用户名（继承自 Redis 6.0+）
  // 格式: redis://username:password@host:port/db
  const username = url.username || undefined
  const password = url.password || undefined

  // 数据库编号在路径中（如 /5 表示数据库 5）
  let database = 0
  if (url.pathname && url.pathname !== '/') {
    const dbNum = parseInt(url.pathname.replace('/', ''), 10)
    if (!isNaN(dbNum)) {
      if (dbNum < 0 || dbNum > 15) {
        throw new RangeError(
          `无效的 Valkey 数据库编号: ${dbNum}（来自路径 "${url.pathname}"）。\n` +
            'Valkey 数据库编号必须为 0-15。',
        )
      }
      database = dbNum
    }
  }

  return { host, port, username, password, database, tls }
}

// 构建用于内联命令执行的 valkey-cli 命令
export function buildValkeyCliCommand(
  valkeyCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  // 验证命令不包含 Shell 注入模式
  validateCommand(command)

  const db = options?.database || '0'
  // 在所有平台上统一转义双引号，防止 Shell 解释问题
  const escaped = command.replace(/"/g, '\\"')
  return `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
}

// 生成 Valkey 配置文件内容
function generateValkeyConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
  bindAddress?: string
}): string {
  // Windows Valkey 不原生支持 daemonize，改用分离式创建进程
  const daemonizeValue = options.daemonize ?? true
  const bindAddress = options.bindAddress ?? '127.0.0.1'

  // Valkey 配置即使在 Windows 上也要求正斜杠
  const normalizePathForValkey = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB 生成的 Valkey 配置
port ${options.port}
bind ${bindAddress}
dir ${normalizePathForValkey(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForValkey(options.logFile)}
pidfile ${normalizePathForValkey(options.pidFile)}

# 持久化 —— RDB 快照
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# 增量日志文件（本地开发禁用）
appendonly no

# 抑制 ARM64 写时复制警告（透明大页相关）。
# Redis/Valkey 在启用 THP 的 ARM64 上会拒绝启动，除非设置此项。
# 本地开发环境下是安全的（SpinDB 的使用场景）。
ignore-warnings ARM64-COW-BUG
`
}

function patchValkeyConfig(
  existingConfig: string,
  options: {
    port: number
    dataDir: string
    logFile: string
    pidFile: string
    bindAddress?: string
    daemonize?: boolean
  },
): string {
  const normalizePathForValkey = (p: string) => p.replace(/\\/g, '/')
  let config = existingConfig
  config = config.replace(/^port \d+/m, `port ${options.port}`)
  config = config.replace(
    /^dir .+/m,
    `dir ${normalizePathForValkey(options.dataDir)}`,
  )
  config = config.replace(
    /^logfile .+/m,
    `logfile ${normalizePathForValkey(options.logFile)}`,
  )
  config = config.replace(
    /^pidfile .+/m,
    `pidfile ${normalizePathForValkey(options.pidFile)}`,
  )
  if (options.bindAddress !== undefined) {
    config = config.replace(/^bind\s+.*$/m, `bind ${options.bindAddress}`)
  }
  if (options.daemonize !== undefined) {
    config = config.replace(
      /^daemonize (yes|no)/m,
      `daemonize ${options.daemonize ? 'yes' : 'no'}`,
    )
  }
  return config
}

export class ValkeyEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Valkey'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  private async getLocalAuth(containerName: string): Promise<ValkeyCliAuth> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.Valkey,
      getDefaultUsername(Engine.Valkey),
    )

    return savedCreds
      ? { username: savedCreds.username, password: savedCreds.password }
      : {}
  }

  // 获取用于二进制操作的平台信息
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态或缓存/回退）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 获取 hostdb 二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（如 '8' -> '8.0.6'）
  resolveFullVersion(version: string): string {
    // 检查是否已是完整版本（至少有两个点）
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // 是大版本号，使用版本映射解析
    return VALKEY_VERSION_MAP[version] || `${version}.0.0`
  }

  // 获取指定版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 Valkey 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `valkey-server${ext}`)
    return existsSync(serverPath)
  }

  // 检查指定的 Valkey 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return valkeyBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 Valkey 二进制文件可用
   * 如果未安装则从 hostdb 下载
   * 返回 bin 目录路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await valkeyBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['valkey-server', 'valkey-cli'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 Valkey 数据目录
   * 创建目录并生成 valkey.conf
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const logFile = paths.getContainerLogPath(containerName, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')
    const port = (options.port as number) || engineDef.defaultPort

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 Valkey 数据目录: ${dataDir}`)
    }

    // 生成 valkey.conf
    const configPath = join(containerDir, 'valkey.conf')
    const configContent = generateValkeyConfig({
      port,
      dataDir,
      logFile,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`已生成 Valkey 配置: ${configPath}`)

    return dataDir
  }

  // 获取指定版本的 valkey-server 路径
  async getValkeyServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `valkey-server${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Valkey ${version} 未安装。请执行: spindb engines download valkey ${version}`,
    )
  }

  // 获取指定版本的 valkey-cli 路径
  override async getValkeyCliPath(version?: string): Promise<string> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('valkey-cli')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，使用下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'valkey',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const cliPath = join(binPath, 'bin', `valkey-cli${ext}`)
      if (existsSync(cliPath)) {
        return cliPath
      }
    }

    throw new Error(
      '未找到 valkey-cli。请执行: spindb engines download valkey <version>',
    )
  }

  /**
   * 启动 Valkey 服务器
   * CLI 封装: valkey-server /path/to/valkey.conf
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

    // 检查是否已在运行（幂等行为）
    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 使用存储的二进制文件路径（来自容器创建），如果可用的话。
    // 这确保版本一致性 —— 容器使用创建时的同一个二进制文件
    let valkeyServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath 是目录（如 ~/.spindb/bin/valkey-8.0.6-linux-arm64）
      // 我们需要构建 valkey-server 的完整路径
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `valkey-server${ext}`)
      if (existsSync(serverPath)) {
        valkeyServer = serverPath
        logDebug(`使用存储的二进制路径: ${valkeyServer}`)
      }
    }

    // 如果上面的方法没找到二进制文件，回退到正常路径
    if (!valkeyServer) {
      // 从已下载的 hostdb 二进制文件获取
      try {
        valkeyServer = await this.getValkeyServerPath(version)
      } catch (error) {
        // 二进制文件尚未下载 —— 这是孤儿容器的情况
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Valkey ${version} 未安装。请执行: spindb engines download valkey ${version}\n` +
            `  原始错误: ${originalMessage}`,
        )
      }
    }

    logDebug(`使用版本 ${version} 的 valkey-server: ${valkeyServer}`)

    // 根据二进制目录计算库文件回退路径
    const binBaseDir = binaryPath || this.getBinaryPath(version)
    const libraryEnv = getLibraryEnv(binBaseDir)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'valkey.conf')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    // Windows Valkey 不原生支持 daemonize
    // 在 Windows 上改用分离式创建进程，类似 MongoDB
    const useDetachedSpawn = isWindows()

    // 保留现有配置（用户可能已添加 requirepass 等设置）
    // 仅在首次启动时生成新配置
    const bindAddress = container.bindAddress ?? '127.0.0.1'
    if (existsSync(configPath)) {
      const existingConfig = await readFile(configPath, 'utf-8')
      const patchedConfig = patchValkeyConfig(existingConfig, {
        port,
        dataDir,
        logFile,
        pidFile,
        bindAddress,
        daemonize: !useDetachedSpawn,
      })
      await writeFile(configPath, patchedConfig)
    } else {
      const configContent = generateValkeyConfig({
        port,
        dataDir,
        logFile,
        pidFile,
        daemonize: !useDetachedSpawn,
        bindAddress,
      })
      await writeFile(configPath, configContent)
    }

    onProgress?.({ stage: 'starting', message: '正在启动 Valkey...' })

    logDebug(`使用配置启动 valkey-server: ${configPath}`)

    /**
     * 检查日志文件中是否有端口绑定错误
     * 如果找到则返回错误消息，否则返回 null
     */
    const checkLogForPortError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000) // 最后 2KB

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `端口 ${port} 已被占用（地址已在使用中）`
        }
        if (recentLog.includes('Failed listening on port')) {
          return `端口 ${port} 已被占用`
        }
      } catch {
        // 日志文件可能尚未创建
      }
      return null
    }

    if (useDetachedSpawn) {
      // Windows: 使用分离式创建进程并正确处理错误
      // 这遵循 MySQL 使用的模式，在 Windows 上可正常工作
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
          windowsHide: true,
          env: { ...process.env, ...libraryEnv },
        }

        // 将 Windows 路径转换为 Cygwin 格式以适配 Cygwin 构建的二进制文件
        const cygwinConfigPath = toCygwinPath(configPath)
        const proc = spawn(valkeyServer, [cygwinConfigPath], spawnOpts)
        let settled = false

        // 处理创建进程错误（二进制文件未找到、DLL 问题等）
        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`无法启动 Valkey 服务器: ${err.message}`))
        })

        // 分离进程以便在父进程退出后继续运行
        proc.unref()

        // 给创建过程一点时间判断是否会失败，然后检查就绪状态
        setTimeout(async () => {
          if (settled) return

          // 验证进程确实已启动
          if (!proc.pid) {
            settled = true
            reject(new Error('Valkey 服务器进程无法启动（无 PID）'))
            return
          }

          // 写入 PID 文件以与其他引擎保持一致
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // 非致命 —— 进程在运行，PID 文件仅为便利
          }

          // 等待 Valkey 就绪
          const ready = await this.waitForReady(
            name,
            port,
            version,
            bindAddress,
          )
          if (settled) return

          if (ready) {
            // 在 Windows 上，Cygwin 二进制文件可能内部 fork，使 proc.pid 过时。
            // 通过端口查找实际 PID 并更新 PID 文件（与 QuestDB 相同模式）。
            try {
              const pids = await platformService.findProcessByPort(port)
              if (pids.length > 0 && pids[0] !== proc.pid) {
                logDebug(
                  `Valkey 实际 PID ${pids[0]} 与创建 PID ${proc.pid} 不同，更新 PID 文件`,
                )
                await writeFile(pidFile, String(pids[0]))
              }
            } catch {
              // 非致命 —— PID 文件已在前面写入 proc.pid
            }

            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true
            const portError = await checkLogForPortError()

            // 读取日志文件内容以获得更好的错误诊断信息
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = '（日志文件未找到或为空）'
            }

            // 首先检查库文件加载错误
            const libError = detectLibraryError(
              logContent,
              'Valkey',
            )
            if (libError) {
              reject(new Error(libError))
              return
            }

            const errorDetails = [
              portError || 'Valkey 启动超时。',
              `二进制文件: ${valkeyServer}`,
              `配置: ${configPath}`,
              `日志文件: ${logFile}`,
              `日志内容:\n${logContent || '（空）'}`,
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, 500)
      })
    }

    // Unix: 使用 daemonize: yes 的 Valkey 自行处理 fork
    return new Promise((resolve, reject) => {
      const proc = spawn(valkeyServer, [configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...libraryEnv },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`valkey-server stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`valkey-server stderr: ${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', async (code) => {
        // 使用 daemonize: yes 的 Valkey 在 fork 后立即退出
        // 退出码 0 表示父进程 fork 成功，但子进程可能仍会失败
        if (code === 0 || code === null) {
          // 给子进程一点时间启动（或失败）
          await new Promise((r) => setTimeout(r, 500))

          // 检查日志中的早期启动失败（如端口冲突）
          const earlyError = await checkLogForPortError()
          if (earlyError) {
            reject(new Error(earlyError))
            return
          }

          // 等待 Valkey 就绪
          const ready = await this.waitForReady(
            name,
            port,
            version,
            bindAddress,
          )
          if (ready) {
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            // 如果未就绪，再次检查日志中的错误
            const portError = await checkLogForPortError()
            if (portError) {
              reject(new Error(portError))
              return
            }

            // 检查库文件加载错误
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = ''
            }
            const libError = detectLibraryError(stderr + logContent, 'Valkey')
            if (libError) {
              reject(new Error(libError))
              return
            }

            reject(
              new Error(
                `Valkey 启动超时。请查看日志: ${logFile}`,
              ),
            )
          }
        } else {
          // 检查非零退出时的库文件加载错误
          const libError = detectLibraryError(stderr || stdout, 'Valkey')
          if (libError) {
            reject(new Error(libError))
            return
          }
          reject(
            new Error(
              stderr || stdout || `valkey-server 退出码: ${code}`,
            ),
          )
        }
      })
    })
  }

  // 等待 Valkey 就绪接受连接
  // TODO - 考虑复制 mongodb 的相应逻辑
  private async waitForReady(
    containerName: string,
    port: number,
    version: string,
    bindAddress = '127.0.0.1',
    timeoutMs = 60000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    let valkeyCli: string
    try {
      valkeyCli = await this.getValkeyCliPathForVersion(version)
    } catch {
      logWarning(
        '未找到 valkey-cli，无法验证 Valkey 是否就绪。短暂等待后假定已成功。',
      )
      // 给 Valkey 一点时间启动，然后假定成功
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return true
    }
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)

    while (Date.now() - startTime < timeoutMs) {
      try {
        const auth = await this.getLocalAuth(containerName)
        const args = ['-h', bindAddress, '-p', String(port)]
        if (shouldPassValkeyCliUsername(auth.username)) {
          args.push('--user', auth.username)
        }
        args.push('PING')
        const { stdout } = await runValkeyCliCommand(valkeyCli, args, {
          timeout: 5000,
          password: auth.password,
          libraryEnv,
        })
        if (stdout.trim() === 'PONG') {
          logDebug(`Valkey 在端口 ${port} 已就绪`)
          return true
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`Valkey 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 Valkey 服务器
   * 使用 SHUTDOWN SAVE 通过 valkey-cli 在停止前持久化数据
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    logDebug(`正在停止 Valkey 容器 "${name}"，端口 ${port}`)

    // 尝试通过 valkey-cli 进行优雅关闭
    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const host = getLocalCliHost(container)
    if (valkeyCli) {
      try {
        const auth = await this.getLocalAuth(name)
        const args = ['-h', host, '-p', String(port)]
        if (shouldPassValkeyCliUsername(auth.username)) {
          args.push('--user', auth.username)
        }
        args.push('SHUTDOWN', 'SAVE')
        await runValkeyCliCommand(valkeyCli, args, {
          timeout: 10000,
          password: auth.password,
          libraryEnv,
        })
        logDebug('Valkey 关闭命令已发送')
        // 等待进程退出
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`valkey-cli 关闭失败: ${error}`)
        // 继续基于 PID 的关闭
      }
    }

    // 获取 PID，必要时强制终止
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    // 如果进程仍在运行则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 Valkey 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，正在强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
        }
      } catch (error) {
        logDebug(`进程终止错误: ${error}`)
      }
    }

    // 清理 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 忽略
      }
    }

    logDebug('Valkey 已停止')
  }

  // 获取 Valkey 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    // 尝试使用 valkey-cli 发送 PING
    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const host = getLocalCliHost(container)
    if (valkeyCli) {
      try {
        const auth = await this.getLocalAuth(name)
        const args = ['-h', host, '-p', String(port)]
        if (shouldPassValkeyCliUsername(auth.username)) {
          args.push('--user', auth.username)
        }
        args.push('PING')
        const { stdout } = await runValkeyCliCommand(valkeyCli, args, {
          timeout: 5000,
          password: auth.password,
          libraryEnv,
        })
        if (stdout.trim() === 'PONG') {
          return { running: true, message: 'Valkey 正在运行' }
        }
      } catch {
        // 未响应，检查 PID
      }
    }

    // 检查 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `Valkey 正在运行 (PID: ${pid})`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'Valkey 未运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * 重要：恢复前必须先停止 Valkey
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port } = container
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    return restoreBackup(backupPath, {
      containerName: name,
      dataDir,
      port,
      database: options.database || container.database || '0',
      flush: options.flush,
    })
  }

  /**
   * 获取连接字符串
   * 格式: redis://127.0.0.1:PORT/DATABASE
   * （为了客户端兼容性使用 redis:// 方案）
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || '0'
    return `redis://127.0.0.1:${port}/${db}`
  }

  /**
   * 获取指定版本的 valkey-cli 路径
   * @param version - 可选版本（如 "8"、"9"）。未提供则使用缓存路径。
   * @deprecated 请改用 getValkeyCliPath()
   */
  async getValkeyCliPathForVersion(version?: string): Promise<string> {
    return this.getValkeyCliPath(version)
  }

  // 打开 valkey-cli 交互式 shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { name, port, version } = container
    const db = database || container.database || '0'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const auth = await this.getLocalAuth(name)
    const host = getLocalCliHost(container)
    const args = ['-h', host, '-p', String(port), '-n', db]
    if (shouldPassValkeyCliUsername(auth.username)) {
      args.push('--user', auth.username)
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      env: buildValkeyCliEnv(libraryEnv, auth.password),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(valkeyCli, args, spawnOptions)

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  // 获取 iredis（增强型 CLI）的路径（如果已安装）
  // 注意：由于 Valkey 协议兼容，iredis 可以与 Valkey 一起使用
  private async getIredisPath(): Promise<string | null> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('iredis')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 检查系统 PATH
    const systemPath = await platformService.findToolPath('iredis')
    if (systemPath) {
      return systemPath
    }

    return null
  }

  // 使用 iredis（增强型 CLI）连接
  async connectWithIredis(
    container: ContainerConfig,
    database?: string,
  ): Promise<void> {
    const { port } = container
    const db = database || container.database || '0'
    const host = getLocalCliHost(container)

    const iredis = await this.getIredisPath()
    if (!iredis) {
      throw new Error(
        '未找到 iredis。请安装：\n' +
          '  macOS: brew install iredis\n' +
          '  pip: pip install iredis',
      )
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        iredis,
        ['-h', host, '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * Valkey 使用编号数据库（0-15），它们始终存在
   * 这实际上是一个空操作
   */
  async createDatabase(
    _container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `无效的 Valkey 数据库编号: ${database}。必须为 0-15。`,
      )
    }
    // 空操作 —— Valkey 数据库始终存在
    logDebug(
      `Valkey 数据库 ${database} 可用（数据库 0-15 始终存在）`,
    )
  }

  /**
   * 删除数据库
   * 使用 FLUSHDB 清空指定数据库中的所有键
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { name, port, version } = container
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `无效的 Valkey 数据库编号: ${database}。必须为 0-15。`,
      )
    }

    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const auth = await this.getLocalAuth(name)
    const host = getLocalCliHost(container)

    // SELECT 数据库并执行 FLUSHDB
    const args = ['-h', host, '-p', String(port), '-n', database]
    if (shouldPassValkeyCliUsername(auth.username)) {
      args.push('--user', auth.username)
    }
    args.push('FLUSHDB')

    try {
      await runValkeyCliCommand(valkeyCli, args, {
        timeout: 10000,
        password: auth.password,
        libraryEnv,
      })
      logDebug(`已清空 Valkey 数据库 ${database}`)
    } catch (error) {
      const err = error as Error
      logDebug(`FLUSHDB 失败: ${err.message}`)
      throw new Error(
        `清空 Valkey 数据库 ${database} 失败: ${err.message}`,
      )
    }
  }

  /**
   * 获取 Valkey 服务器的内存使用量（字节）
   *
   * 注意：Valkey 不提供每个数据库的内存统计信息。
   * 此方法返回服务器总内存使用量（来自 INFO memory 的 used_memory），
   * 而非特定编号数据库（0-15）的大小。
   * 这对于 SpinDB 是可以接受的，因为每个容器只运行一个 Valkey 服务器。
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { name, port, version } = container

    try {
      const valkeyCli = await this.getValkeyCliPathForVersion(version)
      const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
      const auth = await this.getLocalAuth(name)
      const host = getLocalCliHost(container)
      // INFO memory 返回服务器级统计信息（数据库选择无影响）
      const args = ['-h', host, '-p', String(port)]
      if (shouldPassValkeyCliUsername(auth.username)) {
        args.push('--user', auth.username)
      }
      args.push('INFO', 'memory')

      const { stdout } = await runValkeyCliCommand(valkeyCli, args, {
        timeout: 10000,
        password: auth.password,
        libraryEnv,
      })

      // 从 INFO 输出中解析 used_memory（服务器总内存使用量）
      const match = stdout.match(/used_memory:(\d+)/)
      if (match) {
        return parseInt(match[1], 10)
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 从远程 Valkey 连接导出数据
   * 通过扫描远程服务器的所有键来创建文本格式备份
   *
   * 连接字符串格式: redis://[user:password@]host:port[/db]
   * 注意：为了兼容性使用 redis:// 方案（Valkey 是与 Redis 兼容的）
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const valkeyCli = await getValkeyCliPath()
    if (!valkeyCli) {
      throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
    }

    // 解析连接字符串（为了兼容性使用 redis://）
    const { host, port, username, password, database, tls } =
      parseValkeyConnectionString(connectionString)

    logDebug(
      `正在连接远程 Valkey: ${host}:${port} (数据库: ${database}, TLS: ${tls})`,
    )

    // 为远程连接构建 CLI 参数（密码通过环境变量传递以确保安全）
    const buildArgs = (): string[] => {
      const args = ['-h', host, '-p', String(port)]
      // ACL: 通过 --user 标志传递用户名（继承自 Redis 6.0+）
      if (username) {
        args.push('--user', username)
      }
      // 为 rediss:// 或 valkeys:// 方案启用 TLS
      if (tls) {
        args.push('--tls')
      }
      // 注意：密码通过 REDISCLI_AUTH 环境变量传递，而非命令行参数
      args.push('-n', String(database))
      return args
    }

    // 在远程服务器上执行 Valkey 命令并设置超时
    const execRemote = async (
      command: string,
      timeoutMs = 30000,
    ): Promise<string> => {
      return new Promise((resolve, reject) => {
        const args = buildArgs()
        // 通过 REDISCLI_AUTH 环境变量传递密码，避免暴露在进程列表中
        const env = password
          ? { ...process.env, REDISCLI_AUTH: password }
          : process.env
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        })

        let stdout = ''
        let stderr = ''
        let settled = false

        // 超时处理器，防止挂起
        const timeoutId = setTimeout(() => {
          if (settled) return
          settled = true
          proc.kill()
          reject(
            new Error(
              `命令超时，超过 ${timeoutMs}ms: ${command.slice(0, 50)}...`,
            ),
          )
        }, timeoutMs)

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          reject(err)
        })

        proc.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          // 忽略 stderr 中与认证相关的警告（密码通过 REDISCLI_AUTH 提供）
          if (code === 0 || code === null) {
            resolve(stdout)
          } else {
            reject(new Error(stderr || `valkey-cli 退出码: ${code}`))
          }
        })

        proc.stdin.write(command + '\n')
        proc.stdin.end()
      })
    }

    // 测试连通性
    try {
      const pingResult = await execRemote('PING')
      if (!pingResult.trim().includes('PONG')) {
        throw new Error(`意外的 PING 响应: ${pingResult.trim()}`)
      }
    } catch (error) {
      throw new Error(
        `无法连接到 Valkey ${host}:${port}: ${(error as Error).message}`,
      )
    }

    // 从远程键构建文本备份
    const commands: string[] = []
    commands.push('# Valkey 备份 由 SpinDB 生成')
    commands.push(`# 来源: ${host}:${port}`)
    commands.push(`# 日期: ${new Date().toISOString()}`)
    commands.push('')

    // 警告：KEYS * 在执行期间会阻塞 Valkey 服务器。
    // 这对于小数据集是可以接受的，但在大型数据库上会导致性能问题。
    // 对于生产环境中的大型数据集，建议实现基于 SCAN 的迭代代替。
    // TODO: 替换为 SCAN 迭代器以支持大型数据集
    const keysOutput = await execRemote('KEYS *')
    const keys = keysOutput
      .trim()
      .split(/\r?\n/)
      .map((k) => k.trim())
      .filter((k) => k)

    logDebug(`在远程 Valkey 上找到 ${keys.length} 个键`)

    // 对可能导致性能问题的大量键进行警告
    if (keys.length > 10000) {
      logWarning(
        `检测到大量键: ${keys.length} 个键。` +
          '此操作可能较慢。建议在生产环境中使用基于 SCAN 的迭代。',
      )
    }

    // TODO: 使用管道或 Lua 脚本优化，批量获取 TYPE/TTL/值的
    // 目前执行 O(3N) 次往返，对于大量数据集来说较慢。
    // 管道方式可以在更少的往返中获取所有数据。

    for (const key of keys) {
      // 获取键类型
      const typeOutput = await execRemote(`TYPE "${escapeKeyForCommand(key)}"`)
      const keyType = typeOutput.trim()

      // 获取 TTL
      const ttlOutput = await execRemote(`TTL "${escapeKeyForCommand(key)}"`)
      const ttl = parseInt(ttlOutput.trim(), 10)

      // 如果键包含特殊字符，为输出命令中的键加引号
      const quotedKey =
        key.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(key)
          ? `"${key.replace(/"/g, '\\"')}"`
          : key

      // Redis-cli 兼容的值双引号转义
      // 转义反斜杠和双引号，将换行转换为 \n 序列
      // 注意：此方法不处理二进制数据。
      // 对于二进制安全的备份，建议改用 DUMP/RESTORE 命令。
      const escapeValue = (value: string): string => {
        const escaped = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
        return `"${escaped}"`
      }

      // 仅去除 execRemote 输出的尾部换行，保留有意义的空白
      const stripTrailingNewline = (s: string): string =>
        s.replace(/\r?\n$/, '')

      switch (keyType) {
        case 'string': {
          const value = await execRemote(`GET "${escapeKeyForCommand(key)}"`)
          commands.push(
            `SET ${quotedKey} ${escapeValue(stripTrailingNewline(value))}`,
          )
          break
        }
        case 'hash': {
          const hashData = await execRemote(
            `HGETALL "${escapeKeyForCommand(key)}"`,
          )
          const lines = stripTrailingNewline(hashData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (lines.length >= 2) {
            const pairs: string[] = []
            // 处理奇数行（不完整的字段/值对）
            const completeCount = lines.length - (lines.length % 2)
            if (lines.length % 2 !== 0) {
              logWarning(
                `哈希 ${quotedKey} 包含不完整的字段/值对，跳过最后一个字段`,
              )
            }
            for (let i = 0; i < completeCount; i += 2) {
              const field = lines[i]
              const value = lines[i + 1]
              const quotedField =
                field.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(field)
                  ? `"${field.replace(/"/g, '\\"')}"`
                  : field
              pairs.push(`${quotedField} ${escapeValue(value)}`)
            }
            if (pairs.length > 0) {
              commands.push(`HSET ${quotedKey} ${pairs.join(' ')}`)
            }
          }
          break
        }
        case 'list': {
          const listData = await execRemote(
            `LRANGE "${escapeKeyForCommand(key)}" 0 -1`,
          )
          const items = stripTrailingNewline(listData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (items.length > 0) {
            const escapedItems = items.map((item) => escapeValue(item))
            commands.push(`RPUSH ${quotedKey} ${escapedItems.join(' ')}`)
          }
          break
        }
        case 'set': {
          const setData = await execRemote(
            `SMEMBERS "${escapeKeyForCommand(key)}"`,
          )
          const members = stripTrailingNewline(setData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (members.length > 0) {
            const escapedMembers = members.map((m) => escapeValue(m))
            commands.push(`SADD ${quotedKey} ${escapedMembers.join(' ')}`)
          }
          break
        }
        case 'zset': {
          const zsetData = await execRemote(
            `ZRANGE "${escapeKeyForCommand(key)}" 0 -1 WITHSCORES`,
          )
          const lines = stripTrailingNewline(zsetData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (lines.length >= 2) {
            const pairs: string[] = []
            // 处理奇数行（不完整的成员/分值对）
            const completeCount = lines.length - (lines.length % 2)
            if (lines.length % 2 !== 0) {
              logWarning(
                `有序集合 ${quotedKey} 有奇数行，跳过不完整条目: ${lines[lines.length - 1]}`,
              )
            }
            for (let i = 0; i < completeCount; i += 2) {
              const member = lines[i]
              const score = lines[i + 1]
              pairs.push(`${score} ${escapeValue(member)}`)
            }
            if (pairs.length > 0) {
              commands.push(`ZADD ${quotedKey} ${pairs.join(' ')}`)
            }
          }
          break
        }
        default:
          logWarning(`跳过键 ${key}，不支持的类型: ${keyType}`)
      }

      // 如果键设置了 TTL，追加 EXPIRE 命令
      if (ttl > 0) {
        commands.push(`EXPIRE ${quotedKey} ${ttl}`)
      }
    }

    // 将命令写入文件
    const content = commands.join('\n') + '\n'
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        keys.length === 0 ? ['远程 Valkey 数据库为空'] : undefined,
    }
  }

  // 创建备份
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // 运行 Valkey 命令文件或内联命令
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { name, port, version } = container
    const db = options.database || container.database || '0'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const auth = await this.getLocalAuth(name)
    const host = getLocalCliHost(container)
    const args = ['-h', host, '-p', String(port), '-n', db]
    if (shouldPassValkeyCliUsername(auth.username)) {
      args.push('--user', auth.username)
    }
    const env = buildValkeyCliEnv(libraryEnv, auth.password)

    if (options.file) {
      // 读取文件并通过 stdin 管道传入 valkey-cli（避免 Shell 插值问题）
      const fileContent = await readFile(options.file, 'utf-8')

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
          env,
        })

        let rejected = false

        proc.on('error', (err) => {
          rejected = true
          reject(err)
        })

        proc.on('close', (code) => {
          if (rejected) return
          if (code === 0 || code === null) {
            resolve()
          } else {
            reject(new Error(`valkey-cli 退出码: ${code}`))
          }
        })

        // 将文件内容写入 stdin 并关闭
        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // 通过 stdin 管道运行内联命令（避免 Windows 上的 Shell 引号问题）
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
          env,
        })

        let rejected = false

        proc.on('error', (err) => {
          rejected = true
          reject(err)
        })

        proc.on('close', (code) => {
          if (rejected) return
          if (code === 0 || code === null) {
            resolve()
          } else {
            reject(new Error(`valkey-cli 退出码: ${code}`))
          }
        })

        // 将命令写入 stdin 并关闭
        proc.stdin?.write(options.sql + '\n')
        proc.stdin?.end()
      })
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port, version } = container
    const db = options?.database || container.database || '0'
    const host = options?.host ?? '127.0.0.1'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const localAuth =
      !options?.username &&
      !options?.password &&
      (host === '127.0.0.1' || host === 'localhost')
        ? await this.getLocalAuth(name)
        : null

    return new Promise((resolve, reject) => {
      const args = ['-h', host, '-p', String(port), '-n', db, '--raw']

      const username = options?.username || localAuth?.username
      if (shouldPassValkeyCliUsername(username)) {
        args.push('--user', username)
      }
      if (options?.ssl) {
        args.push('--tls')
      }

      const env = buildValkeyCliEnv(
        libraryEnv,
        options?.password ?? localAuth?.password,
      )

      const proc = spawn(valkeyCli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', reject)

      proc.on('close', (code) => {
        if (code === 0 || code === null) {
          // 使用 Redis 解析器因为 Valkey 与 Redis 兼容
          resolve(parseRedisResult(stdout, query))
        } else {
          const libError = detectLibraryError(stderr, 'Valkey')
          reject(
            new Error(
              libError || stderr || `valkey-cli 退出码: ${code}`,
            ),
          )
        }
      })

      // 将查询命令写入 stdin 并关闭
      proc.stdin?.write(query + '\n')
      proc.stdin?.end()
    })
  }

  /**
   * 列出 Valkey 的数据库。
   * Valkey 使用编号数据库（默认 0-15），而非命名的数据库。
   * 返回配置的数据库编号作为单元素数组。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // Valkey 使用编号数据库，而非命名的
    // 返回容器配置的数据库
    return [container.database]
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { name, port, version } = container
    const db = options.database ?? container.database ?? '0'
    const valkeyCli = await this.getValkeyCliPath(version)
    const libraryEnv = getResolvedValkeyCliLibraryEnv(valkeyCli)
    const auth = await this.getLocalAuth(name)
    const host = getLocalCliHost(container)

    // 拒绝包含会破坏 ACL SETUSER 语法的字符的密码：
    // '>' 设置密码，'#' 设置哈希，'<' 移除密码 —— 都是 ACL 分隔符。
    // 空格和换行会意外地将命令拆分。
    if (/[>#<\s\n\r]/.test(password)) {
      throw new Error(
        '密码包含 Valkey ACL 不允许的字符。密码不能包含 ">"、"#"、"<"、空格或换行符。',
      )
    }

    // ACL SETUSER 是幂等的 —— 设置具有完全访问权限的用户
    // 通过 stdin 发送 ACL 命令，避免密码泄露在进程参数中
    const cliArgs = ['-h', host, '-p', String(port), '-n', db]
    if (shouldPassValkeyCliUsername(auth.username)) {
      cliArgs.push('--user', auth.username)
    }

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(valkeyCli, cliArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildValkeyCliEnv(libraryEnv, auth.password),
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`创建用户失败: ${stderr}`))
      })
      proc.on('error', reject)

      proc.stdin?.write(`ACL SETUSER ${username} on >${password} ~* &* +@all\n`)
      proc.stdin?.end()
    })
    logDebug(`已创建 Valkey 用户: ${username}`)

    // Valkey 为了兼容性使用 redis:// 方案
    const connectionString = `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${db}`

    const credentials: UserCredentials = {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
      database: db,
    }
    await saveCredentials(name, Engine.Valkey, credentials)
    return credentials
  }
}

export const valkeyEngine = new ValkeyEngine()
