import { spawn, exec, execFile, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { redisBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  REDIS_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { getRedisCliPath, REDIS_CLI_NOT_FOUND_ERROR } from './cli-utils'
import { Engine } from '../../types'
import {
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

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const ENGINE = 'redis'

/**
 * 对 CLI 命令中使用的 Redis 键进行转义。
 * 转义反斜杠、双引号和控制字符，以防止命令注入，
 * 并确保 CLI 正确解析键名。
 */
function escapeKeyForCommand(key: string): string {
  return key
    .replace(/\\/g, '\\\\') // 先转义反斜杠，防止双重转义
    .replace(/"/g, '\\"')   // 转义双引号
    .replace(/\n/g, '\\n')  // 转义换行符
    .replace(/\r/g, '\\r')  // 转义回车符
    .replace(/\t/g, '\\t')  // 转义制表符
}
const engineDef = getEngineDefaults(ENGINE)

/**
 * 构建 redis-cli 执行时的环境变量
 * 如果提供了密码，通过 REDISCLI_AUTH 环境变量传递
 */
function buildRedisCliEnv(
  password?: string,
): NodeJS.ProcessEnv {
  return password
    ? { ...process.env, REDISCLI_AUTH: password }
    : { ...process.env }
}

/**
 * 潜在的 Shell 命令注入特征的元字符模式
 * 这些模式不应出现在合法的 Redis 命令中
 */
const SHELL_INJECTION_PATTERNS = [
  /;\s*\S/,  // 命令链接：分号后跟随另一条命令
  /\$\(/,    // 命令替换：$(...)
  /\$\{/,    // 变量替换：${...}
  /`/,       // 反引号命令替换
  /&&/,      // 逻辑与链接
  /\|\|/,    // 逻辑或链接
  /\|\s*\S/, // 管道到另一命令
]

/** 验证命令不包含 Shell 注入特征 */
function validateCommand(command: string): void {
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `命令包含 Shell 元字符，这些字符在 Redis 命令中无效。` +
          `如需执行复杂命令，请改用脚本文件。`,
      )
    }
  }
}

/**
 * 判断是否需要向 redis-cli 传递用户名参数
 */
export function shouldPassRedisCliUsername(
  username?: string,
): username is string {
  if (!username) {
    return false
  }

  const trimmed = username.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

/**
 * 将 Windows 路径转换为 Cygwin 路径格式。
 * Redis Windows 二进制文件（来自 redis-windows）基于 MSYS2/Cygwin 运行时构建，
 * 在作为命令行参数传递时需要 /cygdrive/c/... 格式的路径。
 *
 * 示例：C:\Users\foo\config.conf -> /cygdrive/c/Users/foo/config.conf
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
 * 解析 Redis 连接字符串
 * 支持的协议方案：
 * - redis://   （明文，无 TLS）
 * - rediss://  （启用 TLS）
 *
 * 格式：scheme://[user:password@]host[:port][/database]
 *
 * 示例：
 * - redis://localhost:6379
 * - rediss://secure.host:6379/0  （TLS）
 * - redis://:password@localhost:6379/0
 * - redis://user:password@remote.host:6380/5
 */
function parseRedisConnectionString(connectionString: string): {
  host: string
  port: number
  username: string | undefined
  password: string | undefined
  database: number
  tls: boolean
} {
  let url: URL

  const normalized = connectionString.trim()

  // 检查是否为合法协议方案
  const validSchemes = ['redis://', 'rediss://']
  const hasValidScheme = validSchemes.some((scheme) =>
    normalized.startsWith(scheme),
  )

  if (!hasValidScheme) {
    throw new Error(
      `无效的 Redis 连接字符串: ${connectionString}\n` +
        '期望格式: scheme://[user:password@]host:port[/database]\n' +
        '支持的协议: redis://, rediss://\n' +
        '（使用 rediss:// 进行 TLS 连接）',
    )
  }

  try {
    url = new URL(normalized)
  } catch {
    throw new Error(
      `无效的 Redis 连接字符串: ${connectionString}\n` +
        '期望格式: scheme://[user:password@]host:port[/database]',
    )
  }

  // 根据协议方案判断是否启用 TLS
  const tls = normalized.startsWith('rediss://')

  const host = url.hostname || 'localhost'
  const port = parseInt(url.port, 10) || 6379

  // Redis 6.0+ 支持基于 ACL 的用户名认证
  // 格式：redis://username:password@host:port/db
  const username = url.username || undefined
  const password = url.password || undefined

  // 数据库编号位于路径中（如 /5 表示数据库 5）
  let database = 0
  if (url.pathname && url.pathname !== '/') {
    const dbNum = parseInt(url.pathname.replace('/', ''), 10)
    if (!isNaN(dbNum)) {
      if (dbNum < 0 || dbNum > 15) {
        throw new RangeError(
          `无效的 Redis 数据库编号: ${dbNum}（来自路径 "${url.pathname}"）。\n` +
            'Redis 数据库默认为 0-15。\n' +
            '如果您的服务器通过 "databases" 设置配置了更多数据库，\n' +
            '可能需要在服务器配置中提高上限。',
        )
      }
      database = dbNum
    }
  }

  return { host, port, username, password, database, tls }
}

/** 构建用于内联命令执行的 redis-cli 命令 */
export function buildRedisCliCommand(
  redisCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  // 验证命令不包含 Shell 注入特征
  validateCommand(command)

  const db = options?.database || '0'
  // 所有平台统一转义双引号，防止 Shell 解析问题
  const escaped = command.replace(/"/g, '\\"')
  return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
}

/** 生成 Redis 配置文件内容 */
function generateRedisConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
  bindAddress?: string
}): string {
  // Windows 上的 Redis 不原生支持 daemonize，改用 detached spawn
  const daemonizeValue = options.daemonize ?? true
  const bindAddress = options.bindAddress ?? '127.0.0.1'

  // Redis 配置要求即使是在 Windows 上也要使用正斜杠
  const normalizePathForRedis = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB 生成的 Redis 配置
port ${options.port}
bind ${bindAddress}
dir ${normalizePathForRedis(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForRedis(options.logFile)}
pidfile ${normalizePathForRedis(options.pidFile)}

# 持久化 — RDB 快照
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# 仅追加文件（本地开发环境下禁用）
appendonly no

# 抑制 ARM64 上的写时复制警告（透明大页相关）。
# 当 ARM64 上启用 THP 时，Redis 会拒绝启动，除非设置此项。
# 在本地开发环境（SpinDB 的使用场景）下是安全的。
ignore-warnings ARM64-COW-BUG
`
}

/** 基于已有配置内容进行补丁式覆盖 */
function patchRedisConfig(
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
  const normalizePathForRedis = (p: string) => p.replace(/\\/g, '/')
  let config = existingConfig
  config = config.replace(/^port \d+/m, `port ${options.port}`)
  config = config.replace(
    /^dir .+/m,
    `dir ${normalizePathForRedis(options.dataDir)}`,
  )
  config = config.replace(
    /^logfile .+/m,
    `logfile ${normalizePathForRedis(options.logFile)}`,
  )
  config = config.replace(
    /^pidfile .+/m,
    `pidfile ${normalizePathForRedis(options.pidFile)}`,
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

export class RedisEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Redis'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  /** 获取平台信息（用于二进制文件操作） */
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  /** 从 hostdb 获取可用版本（动态获取或从缓存/回退中读取） */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  /** 从 hostdb 获取二进制文件下载 URL */
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  /** 将版本字符串解析为完整版本号（如 '8' -> '8.4.0'） */
  resolveFullVersion(version: string): string {
    // 检查是否已是完整版本号（至少两个点）
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // 是主版本号，通过版本映射表解析
    return REDIS_VERSION_MAP[version] || `${version}.0.0`
  }

  /** 获取指定版本二进制文件的安装路径 */
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  /** 验证 Redis 二进制文件是否可用 */
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `redis-server${ext}`)
    return existsSync(serverPath)
  }

  /** 检查指定 Redis 版本是否已安装（已下载） */
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return redisBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 Redis 二进制文件可用
   * 如果尚未安装，从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await redisBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 将二进制文件路径注册到配置中
    const ext = platformService.getExecutableExtension()
    const tools = ['redis-server', 'redis-cli'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 Redis 数据目录
   * 创建目录并生成 redis.conf
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
    const pidFile = join(containerDir, 'redis.pid')
    const port = (options.port as number) || engineDef.defaultPort

    // 如果数据目录还不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 Redis 数据目录: ${dataDir}`)
    }

    // 生成 redis.conf
    const configPath = join(containerDir, 'redis.conf')
    const configContent = generateRedisConfig({
      port,
      dataDir,
      logFile,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`已生成 Redis 配置: ${configPath}`)

    return dataDir
  }

  /** 获取指定版本的 redis-server 路径 */
  async getRedisServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `redis-server${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Redis ${version} 尚未安装。请运行: spindb engines download redis ${version}`,
    )
  }

  /** 获取指定版本的 redis-cli 路径 */
  override async getRedisCliPath(version?: string): Promise<string> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('redis-cli')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，使用已下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'redis',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const cliPath = join(binPath, 'bin', `redis-cli${ext}`)
      if (existsSync(cliPath)) {
        return cliPath
      }
    }

    throw new Error(
      '未找到 redis-cli。请运行: spindb engines download redis <版本号>',
    )
  }

  /**
   * 启动 Redis 服务器
   * CLI 包装器: redis-server /path/to/redis.conf
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

    // 优先使用容器创建时存储的二进制文件路径
    // 确保版本一致性 — 容器使用创建时所用的同一二进制文件
    let redisServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath 是目录（如 ~/.spindb/bin/redis-8.4.0-linux-arm64）
      // 需要构造 redis-server 的完整路径
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `redis-server${ext}`)
      if (existsSync(serverPath)) {
        redisServer = serverPath
        logDebug(`使用已存储的二进制文件路径: ${redisServer}`)
      }
    }

    // 如果上面没找到，回退到普通路径
    if (!redisServer) {
      // 从已下载的 hostdb 二进制文件中获取
      try {
        redisServer = await this.getRedisServerPath(version)
      } catch (error) {
        // 二进制文件尚未下载 — 这是一个孤立的容器情况
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Redis ${version} 尚未安装。请运行: spindb engines download redis ${version}\n` +
            `  原始错误: ${originalMessage}`,
        )
      }
    }

    logDebug(`为版本 ${version} 使用 redis-server: ${redisServer}`)

    // 从二进制文件目录计算库文件回退路径
    // redisServer 示例路径: /path/to/redis-8.4.0-darwin-arm64/bin/redis-server
    // 需要其父目录（去掉 /bin/redis-server）
    const binBaseDir = binaryPath || this.getBinaryPath(version)
    const libraryEnv = getLibraryEnv(binBaseDir)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'redis.conf')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    // Windows 上的 Redis 不支持原生 daemonize
    // 在 Windows 上改用 detached spawn，类似 MongoDB 的处理方式
    const useDetachedSpawn = isWindows()

    // 保留已有配置（用户可能已添加 requirepass 等设置）
    // 仅在首次启动时生成全新配置
    const bindAddress = container.bindAddress ?? '127.0.0.1'
    if (existsSync(configPath)) {
      const existingConfig = await readFile(configPath, 'utf-8')
      const patchedConfig = patchRedisConfig(existingConfig, {
        port,
        dataDir,
        logFile,
        pidFile,
        bindAddress,
        daemonize: !useDetachedSpawn,
      })
      await writeFile(configPath, patchedConfig)
    } else {
      const configContent = generateRedisConfig({
        port,
        dataDir,
        logFile,
        pidFile,
        daemonize: !useDetachedSpawn,
        bindAddress,
      })
      await writeFile(configPath, configContent)
    }

    onProgress?.({ stage: 'starting', message: '正在启动 Redis...' })

    logDebug(`正在使用配置启动 redis-server: ${configPath}`)

    /**
     * 检查日志文件中是否存在端口绑定错误
     * 如果发现错误则返回错误消息，否则返回 null
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
      // Windows：以 detached 模式启动进程，并带有适当的错误处理
      // 沿用 MySQL 在 Windows 上已验证的模式
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
          env: { ...process.env, ...libraryEnv },
        }

        // 将 Windows 路径转换为 Cygwin 格式，供 MSYS2/Cygwin 构建的二进制文件使用
        const cygwinConfigPath = toCygwinPath(configPath)
        const proc = spawn(redisServer, [cygwinConfigPath], spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        // 处理 spawn 错误（二进制文件未找到、DLL 问题等）
        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`无法启动 Redis 服务器: ${err.message}`))
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`redis-server stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`redis-server stderr: ${str}`)
        })

        // 解除进程与父进程的关联，使其在父进程退出后继续运行
        proc.unref()

        // 给 spawn 一点时间来失败（如果会的话），然后检查就绪状态
        setTimeout(async () => {
          if (settled) return

          // 验证进程确实已启动
          if (!proc.pid) {
            settled = true
            reject(new Error('Redis 服务器进程启动失败（无 PID）'))
            return
          }

          // 写入 PID 文件，与其他引擎保持一致
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // 非致命错误 — 进程已在运行，PID 文件仅为方便管理
          }

          // 等待 Redis 就绪
          const ready = await this.waitForReady(name, port, version)
          if (settled) return

          if (ready) {
            // 在 Windows 上，Cygwin 二进制文件可能会内部 fork，导致 proc.pid 过时。
            // 通过端口查找实际 PID 并更新 PID 文件（与 QuestDB 相同的处理模式）。
            try {
              const pids = await platformService.findProcessByPort(port)
              if (pids.length > 0 && pids[0] !== proc.pid) {
                logDebug(
                  `Redis 实际 PID ${pids[0]} 与 spawn PID ${proc.pid} 不一致，更新 PID 文件`,
                )
                await writeFile(pidFile, String(pids[0]))
              }
            } catch {
              // 非致命错误 — PID 文件已在此前写入 proc.pid
            }

            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true
            const portError = await checkLogForPortError()

            // 读取日志文件内容以提供更好的错误诊断
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = '（日志文件未找到或为空）'
            }

            // 首先检查库加载错误
            const libError = detectLibraryError(
              stderrOutput + logContent,
              'Redis',
            )
            if (libError) {
              reject(new Error(libError))
              return
            }

            const errorDetails = [
              portError || 'Redis 在超时时间内未能启动。',
              `二进制文件: ${redisServer}`,
              `配置文件: ${configPath}`,
              `日志文件: ${logFile}`,
              `日志内容:\n${logContent || '（空）'}`,
              stderrOutput ? `标准错误输出:\n${stderrOutput}` : '',
              stdoutOutput ? `标准输出:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, 500)
      })
    }

    // Unix：设置了 daemonize: yes 的 Redis 自行处理 fork
    return new Promise((resolve, reject) => {
      const proc = spawn(redisServer, [configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...libraryEnv },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`redis-server stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`redis-server stderr: ${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', async (code) => {
        // 设置了 daemonize: yes 的 Redis 在 fork 后立即退出
        // 退出码 0 表示父进程 fork 成功，但子进程可能仍会失败
        if (code === 0 || code === null) {
          // 给子进程一点时间启动（或失败）
          await new Promise((r) => setTimeout(r, 500))

          // 检查日志中是否有早期启动失败（如端口冲突）
          const earlyError = await checkLogForPortError()
          if (earlyError) {
            reject(new Error(earlyError))
            return
          }

          // 等待 Redis 就绪
          const ready = await this.waitForReady(name, port, version)
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

            // 附带日志内容以便 CI 调试
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = '（日志文件未找到或为空）'
            }

            // 检查库加载错误
            const libError = detectLibraryError(stderr + logContent, 'Redis')
            if (libError) {
              reject(new Error(libError))
              return
            }

            const errorDetails = [
              'Redis 在超时时间内未能启动。',
              `二进制文件: ${redisServer}`,
              `日志文件: ${logFile}`,
              `日志内容:\n${logContent || '（空）'}`,
              stderr ? `标准错误输出:\n${stderr}` : '',
              stdout ? `标准输出:\n${stdout}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        } else {
          // 非零退出码也附带日志内容
          let logContent = ''
          try {
            logContent = await readFile(logFile, 'utf-8')
          } catch {
            logContent = ''
          }

          // 检查非零退出时的库加载错误
          const libError = detectLibraryError(
            stderr + stdout + logContent,
            'Redis',
          )
          if (libError) {
            reject(new Error(libError))
            return
          }

          const errorDetails = [
            stderr || stdout || `redis-server 退出码为 ${code}`,
            logContent ? `日志内容:\n${logContent}` : '',
          ]
            .filter(Boolean)
            .join('\n')

          reject(new Error(errorDetails))
        }
      })
    })
  }

  /** 等待 Redis 准备好接受连接 */
  private async waitForReady(
    containerName: string,
    port: number,
    version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    let redisCli: string
    try {
      redisCli = await this.getRedisCliPathForVersion(version)
    } catch {
      logWarning('未找到 redis-cli，无法验证 Redis 是否就绪')
      return false
    }
    const savedCreds = await loadCredentials(
      containerName,
      Engine.Redis,
      getDefaultUsername(Engine.Redis),
    )
    const cliArgs = ['-h', '127.0.0.1', '-p', String(port)]
    if (shouldPassRedisCliUsername(savedCreds?.username)) {
      cliArgs.push('--user', savedCreds.username)
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const { stdout } = await execFileAsync(redisCli, [...cliArgs, 'PING'], {
          timeout: 5000,
          env: buildRedisCliEnv(savedCreds?.password),
        })
        if (stdout.trim() === 'PONG') {
          logDebug(`Redis 已在端口 ${port} 就绪`)
          return true
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`Redis 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 Redis 服务器
   * 通过 redis-cli 使用 SHUTDOWN SAVE 命令，在停止前持久化数据
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    logDebug(`正在停止 Redis 容器 "${name}"（端口 ${port}）`)

    // 尝试通过 redis-cli 优雅关闭
    const redisCli = await this.getRedisCliPathForVersion(version)
    if (redisCli) {
      try {
        const savedCreds = await loadCredentials(
          name,
          Engine.Redis,
          getDefaultUsername(Engine.Redis),
        )
        const args = ['-h', '127.0.0.1', '-p', String(port)]
        if (shouldPassRedisCliUsername(savedCreds?.username)) {
          args.push('--user', savedCreds.username)
        }
        args.push('SHUTDOWN', 'SAVE')
        await execFileAsync(redisCli, args, {
          timeout: 10000,
          env: buildRedisCliEnv(savedCreds?.password),
        })
        logDebug('已发送 Redis 关闭命令')
        // 等待一段时间让进程退出
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`redis-cli 关闭失败: ${error}`)
        // 继续执行基于 PID 的关闭
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
      logDebug(`正在终止 Redis 进程 ${pid}`)
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

    logDebug('Redis 已停止')
  }

  /** 获取 Redis 服务器状态 */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    // 尝试用 redis-cli ping
    const redisCli = await this.getRedisCliPathForVersion(version)
    if (redisCli) {
      try {
        const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} PING`
        const { stdout } = await execAsync(cmd, { timeout: 5000 })
        if (stdout.trim() === 'PONG') {
          return { running: true, message: 'Redis 正在运行' }
        }
      } catch {
        // 无响应，检查 PID
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
            message: `Redis 正在运行 (PID: ${pid})`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'Redis 未运行' }
  }

  /** 检测备份文件格式 */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * 重要：恢复前必须先停止 Redis
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
   * 格式：redis://127.0.0.1:PORT/DATABASE
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || '0'
    return `redis://127.0.0.1:${port}/${db}`
  }

  /**
   * 获取指定版本的 redis-cli 路径
   * @param version - 可选版本号（如 "8", "7"）。如未提供，使用缓存路径。
   * @deprecated 请改用 getRedisCliPath()
   */
  async getRedisCliPathForVersion(version?: string): Promise<string> {
    return this.getRedisCliPath(version)
  }

  /** 打开 redis-cli 交互式 Shell */
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || '0'

    const redisCli = await this.getRedisCliPathForVersion(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        redisCli,
        ['-h', '127.0.0.1', '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /** 获取 iredis（增强型 CLI）的路径（如果已安装） */
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

  /** 使用 iredis（增强型 CLI）连接 */
  async connectWithIredis(
    container: ContainerConfig,
    database?: string,
  ): Promise<void> {
    const { port } = container
    const db = database || container.database || '0'

    const iredis = await this.getIredisPath()
    if (!iredis) {
      throw new Error(
        '未找到 iredis。请通过以下方式安装：\n' +
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
        ['-h', '127.0.0.1', '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * Redis 使用编号数据库（0-15），它们始终存在
   * 这实际上是一个空操作
   */
  async createDatabase(
    _container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `无效的 Redis 数据库编号: ${database}。必须为 0-15。`,
      )
    }
    // 空操作 — Redis 数据库始终存在
    logDebug(
      `Redis 数据库 ${database} 可用（数据库 0-15 始终存在）`,
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
    const { port, version } = container
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `无效的 Redis 数据库编号: ${database}。必须为 0-15。`,
      )
    }

    const redisCli = await this.getRedisCliPathForVersion(version)

    // SELECT 数据库然后 FLUSHDB
    const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} -n ${database} FLUSHDB`

    try {
      await execAsync(cmd, { timeout: 10000 })
      logDebug(`已清空 Redis 数据库 ${database}`)
    } catch (error) {
      const err = error as Error
      logDebug(`FLUSHDB 失败: ${err.message}`)
      throw new Error(
        `清空 Redis 数据库 ${database} 失败: ${err.message}`,
      )
    }
  }

  /**
   * 获取 Redis 服务器的内存使用量（字节）
   *
   * 注意：Redis 不提供按数据库的内存统计。
   * 这里返回的是服务器总内存（来自 INFO memory 的 used_memory），
   * 而非特定编号数据库（0-15）的大小。
   * 对于 SpinDB 而言这是可以接受的，因为每个容器只运行一个 Redis 服务器。
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, version } = container

    try {
      const redisCli = await this.getRedisCliPathForVersion(version)
      // INFO memory 返回服务器级统计（数据库选择不影响结果）
      const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} INFO memory`

      const { stdout } = await execAsync(cmd, { timeout: 10000 })

      // 从 INFO 输出中解析 used_memory（服务器总内存）
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
   * 从远程 Redis 连接导出数据
   * 通过扫描远程服务器的所有键来创建文本格式备份
   *
   * 连接字符串格式：redis://[user:password@]host:port[/db]
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const redisCli = await getRedisCliPath()
    if (!redisCli) {
      throw new Error(REDIS_CLI_NOT_FOUND_ERROR)
    }

    // 解析连接字符串
    const { host, port, username, password, database, tls } =
      parseRedisConnectionString(connectionString)

    logDebug(
      `正在连接到远程 Redis: ${host}:${port}（数据库: ${database}, TLS: ${tls}）`,
    )

    // 构建远程连接的 CLI 参数（密码通过环境变量传递以保证安全）
    const buildArgs = (): string[] => {
      const args = ['-h', host, '-p', String(port)]
      // 隐式的 default 用户适用于仅密码认证（`requirepass`），
      // 并且可以避免在托管 Redis/Valkey 实例上因不期望显式 ACL 用户名而导致的 NOAUTH 失败。
      if (shouldPassRedisCliUsername(username)) {
        args.push('--user', username)
      }
      // 为 rediss:// 协议方案启用 TLS
      if (tls) {
        args.push('--tls')
      }
      // 注意：密码通过 REDISCLI_AUTH 环境变量传递，而非命令行参数
      args.push('-n', String(database))
      return args
    }

    /** 在远程服务器上执行 Redis 命令，带超时控制 */
    const execRemote = async (
      command: string,
      timeoutMs = 30000,
    ): Promise<string> => {
      return new Promise((resolve, reject) => {
        const args = buildArgs()
        // 通过 REDISCLI_AUTH 环境变量传递密码，避免在进程列表中暴露
        const env = password
          ? { ...process.env, REDISCLI_AUTH: password }
          : process.env
        const proc = spawn(redisCli, args, {
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
              `命令在 ${timeoutMs}ms 后超时: ${command.slice(0, 50)}...`,
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
          // 忽略 stderr 中与认证相关的警告（密码已通过 REDISCLI_AUTH 提供）
          if (code === 0 || code === null) {
            resolve(stdout)
          } else {
            reject(new Error(stderr || `redis-cli 退出码为 ${code}`))
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
        throw new Error(`非预期的 PING 响应: ${pingResult.trim()}`)
      }
    } catch (error) {
      throw new Error(
        `无法连接到 Redis ${host}:${port}: ${(error as Error).message}`,
      )
    }

    // 从远程键构建文本备份
    const commands: string[] = []
    commands.push('# SpinDB 生成的 Redis 备份')
    commands.push(`# 来源: ${host}:${port}`)
    commands.push(`# 日期: ${new Date().toISOString()}`)
    commands.push('')

    // 警告：KEYS * 在执行期间会阻塞 Redis 服务器。
    // 对于小数据集这是可以接受的，但在大型数据库中会导致性能问题。
    // 对于包含大型数据集的生产环境，建议改用基于 SCAN 的迭代方式。
    // TODO：替换为 SCAN 迭代器以支持大型数据集
    const keysOutput = await execRemote('KEYS *')
    const keys = keysOutput
      .trim()
      .split(/\r?\n/)
      .map((k) => k.trim())
      .filter((k) => k)

    logDebug(`在远程 Redis 上找到 ${keys.length} 个键`)

    for (const key of keys) {
      // 获取键类型
      const typeOutput = await execRemote(`TYPE "${escapeKeyForCommand(key)}"`)
      const keyType = typeOutput.trim()

      // 获取 TTL
      const ttlOutput = await execRemote(`TTL "${escapeKeyForCommand(key)}"`)
      const ttl = parseInt(ttlOutput.trim(), 10)

      // 如果键包含特殊字符，用引号包裹输出命令中的键名
      const quotedKey =
        key.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(key)
          ? `"${key.replace(/"/g, '\\"')}"`
          : key

      // Redis-cli 兼容的值双引号转义
      // 转义反斜杠和双引号，将换行符转换为 \n 序列
      // 注意：这种方式不处理二进制数据。
      // 如需二进制安全的备份，请改用 DUMP/RESTORE 命令。
      const escapeValue = (value: string): string => {
        const escaped = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
        return `"${escaped}"`
      }

      // 仅去除 execRemote 输出的尾部换行符，保留有意的前导空白
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
                `Hash ${quotedKey} 存在不完整的字段/值对，跳过最后一个字段`,
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
                `ZSet ${quotedKey} 行数为奇数，跳过不完整的条目: ${lines[lines.length - 1]}`,
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
        // TODO：添加 Redis Streams 支持（XRANGE/XADD 命令）
        // Streams 是一种复杂的数据类型，需要特殊处理消息 ID 和字段。
        // 如有需求可考虑实现。
        default:
          logWarning(`跳过键 ${key}，不支持的类型: ${keyType}`)
      }

      // 如果键有 TTL，添加 EXPIRE 命令
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
        keys.length === 0 ? ['远程 Redis 数据库为空'] : undefined,
    }
  }

  /** 创建备份 */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /** 运行 Redis 命令文件或内联命令 */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database || '0'

    const redisCli = await this.getRedisCliPathForVersion(version)

    if (options.file) {
      // 读取文件并通过 stdin 管道到 redis-cli（避免 Shell 插值问题）
      const fileContent = await readFile(options.file, 'utf-8')
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(redisCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
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
            reject(new Error(`redis-cli 退出码为 ${code}`))
          }
        })

        // 将文件内容写入 stdin 并关闭
        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // 通过管道将内联命令传入 redis-cli 的 stdin（避免 Windows 上的 Shell 引号问题）
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(redisCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
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
            reject(new Error(`redis-cli 退出码为 ${code}`))
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

  /** 执行查询并返回结果 */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version } = container
    const db = options?.database || container.database || '0'
    const host = options?.host ?? '127.0.0.1'

    const redisCli = await this.getRedisCliPathForVersion(version)
    const binBaseDir = this.getBinaryPath(version)
    const libraryEnv = getLibraryEnv(binBaseDir)

    return new Promise((resolve, reject) => {
      const args = ['-h', host, '-p', String(port), '-n', db, '--raw']

      const username = options?.username
      if (shouldPassRedisCliUsername(username)) {
        args.push('--user', username)
      }
      if (options?.ssl) {
        args.push('--tls')
      }

      // 通过 REDISCLI_AUTH 环境变量传递密码，避免在进程列表中暴露
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...libraryEnv,
      }
      if (options?.password) {
        env.REDISCLI_AUTH = options.password
      }

      const proc = spawn(redisCli, args, {
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
          resolve(parseRedisResult(stdout, query))
        } else {
          const libError = detectLibraryError(stderr, 'Redis')
          reject(
            new Error(
              libError || stderr || `redis-cli 退出码为 ${code}`,
            ),
          )
        }
      })

      // 将命令写入 stdin 并关闭
      proc.stdin?.write(query + '\n')
      proc.stdin?.end()
    })
  }

  /**
   * 列出 Redis 的数据库。
   * Redis 使用编号数据库（默认为 0-15），而非命名数据库。
   * 返回容器配置的数据库编号作为单项数组。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // Redis 使用编号数据库，而非命名数据库
    // 返回容器配置的数据库
    return [container.database]
  }

  /** 创建用户（ACL SETUSER） */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port } = container
    const db = options.database ?? container.database ?? '0'
    const redisCli = await this.getRedisCliPath(container.version)

    // 拒绝包含会破坏 ACL SETUSER 语法的字符的密码：
    // '>' 设置密码，'#' 设置哈希值，'<' 移除密码 — 这些都是 ACL 分隔符。
    // 空格和换行符会意外分割命令。
    if (/[>#<\s\n\r]/.test(password)) {
      throw new Error(
        '密码包含 Redis ACL 不允许的字符。密码不得包含 ">"、"#"、"<"、空格或换行符。',
      )
    }

    // ACL SETUSER 是幂等的 — 设置具有完全访问权限的用户
    // 通过 stdin 传递完整的 ACL 命令，避免在 argv 中暴露密码
    const connArgs = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(redisCli, connArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.stdin?.write(`ACL SETUSER ${username} on >${password} ~* &* +@all\n`)
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`创建用户失败: ${stderr}`))
      })
      proc.on('error', reject)
    })
    logDebug(`已创建 Redis 用户: ${username}`)

    const connectionString = `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

    return {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
      database: db,
    }
  }
}

export const redisEngine = new RedisEngine()