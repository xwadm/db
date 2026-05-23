import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, dirname } from 'path'
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
import { portManager } from '../../core/port-manager'
import { couchdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  COUCHDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  couchdbApiRequest,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USER,
} from './api-client'
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
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'couchdb'
const engineDef = getEngineDefaults(ENGINE)

type LocalCouchDBAuth = {
  username: string
  password: string
}

/**
 * 获取 CouchDB 可执行文件的正确扩展名。
 * 在 Windows 上，CouchDB 使用 .cmd 批处理文件，而不是 .exe
 */
function getCouchDBExtension(): string {
  return isWindows() ? '.cmd' : ''
}

/**
 * 生成 CouchDB local.ini 配置文件内容
 * CouchDB 3.x 要求至少有一个管理员账户才能启动
 */
function generateCouchDBConfig(options: {
  port: number
  dataDir: string
  logDir: string
  bindAddress?: string
  adminUsername?: string
  adminPassword?: string
}): string {
  const bindAddress = options.bindAddress || '127.0.0.1'
  const adminUsername = options.adminUsername || DEFAULT_ADMIN_USER
  const adminPassword = options.adminPassword || DEFAULT_ADMIN_PASSWORD

  return `; SpinDB 生成的 CouchDB 配置
[couchdb]
database_dir = ${options.dataDir}
view_index_dir = ${options.dataDir}

[chttpd]
port = ${options.port}
bind_address = ${bindAddress}
; 本地开发允许匿名访问（无需登录）
require_valid_user = false

[chttpd_auth]
; 允许匿名访问 Fauxton 仪表盘
require_valid_user = false

[log]
file = ${options.logDir}/couchdb.log
level = info

[admins]
; CouchDB 3.x 需要管理员账户才能执行特权 API 操作
${adminUsername} = ${adminPassword}
`
}

function patchCouchDBConfig(
  existingConfig: string,
  options: {
    port: number
    bindAddress?: string
    adminUsername?: string
    adminPassword?: string
  },
): string {
  let config = existingConfig
  config = config.replace(/^port = \d+/m, `port = ${options.port}`)
  if (options.bindAddress !== undefined) {
    config = config.replace(
      /^bind_address = .+/m,
      `bind_address = ${options.bindAddress}`,
    )
  }
  if (options.adminUsername && options.adminPassword) {
    const managedAdminLine = `${options.adminUsername} = ${options.adminPassword}`
    const adminsSection = `[admins]\n${managedAdminLine}`
    const adminsSectionPattern = /\[admins\][\s\S]*?(?=\n\[|$)/m
    const escapedUsername = options.adminUsername.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    )
    const managedAdminPattern = new RegExp(`^${escapedUsername}\\s*=.*$`, 'm')

    if (adminsSectionPattern.test(config)) {
      config = config.replace(adminsSectionPattern, (section) => {
        if (managedAdminPattern.test(section)) {
          return section.replace(managedAdminPattern, managedAdminLine)
        }
        return `${section.trimEnd()}\n${managedAdminLine}`
      })
    } else {
      config = `${config.trimEnd()}\n\n${adminsSection}\n`
    }
  }
  return config
}

/**
 * 生成容器专属的 vm.args，使用唯一的 Erlang 节点名。
 * 每个 CouchDB 实例需要唯一的节点名以避免冲突
 */
function generateVmArgs(port: number, _containerDir: string): string {
  // 在节点名中使用端口号以保证唯一性
  const nodeName = `couchdb_${port}@127.0.0.1`

  // 读取基础 vm.args 并替换节点名
  return `# SpinDB 生成的 CouchDB vm.args
# 基于端口号的唯一节点名，以支持多实例
-name ${nodeName}

# 分布式 Erlang 需要所有节点共享相同的魔法 Cookie 才能工作。
# -setcookie

# 节点应该监听哪些网络接口？
-kernel inet_dist_use_interface {127,0,0,1}

# 告诉 kernel 和 SASL 不要记录任何日志
-kernel error_logger silent
-sasl sasl_error_logger false

# 防止分区重叠
-kernel prevent_overlapping_partitions false

# Erlang 进程限制
+P 1048576

# 增加脏 IO 调度器池
+SDio 16

# 增加分发缓冲区大小
+zdbbl 32768

# 禁用交互式 Shell
+Bd -noinput

# 设置 SSL 会话最大生存时间
-ssl session_lifetime 300

# OS Mon 设置 - 在 Windows 上禁用所有监控，以避免 win32sysinfo 问题
-os_mon start_cpu_sup false
-os_mon start_memsup false
-os_mon start_disksup false
`
}

/**
 * 生成 Erlang sys.config，在应用启动前禁用 os_mon 功能。
 * 在 Windows 上，os_mon 尝试使用 win32sysinfo，如果端口程序
 * 缺失或损坏，可能会导致崩溃。这些设置在 os_mon 启动前生效。
 */
function generateSysConfig(): string {
  // 最小化 Erlang sys.config - 无注释，纯配置
  // os_mon 设置必须在应用启动前生效
  return `[{os_mon,[{start_cpu_sup,false},{start_disksup,false},{start_memsup,false}]}].
`
}

/**
 * 解析远程操作的 CouchDB 连接字符串
 */
function parseCouchDBConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
  database?: string
} {
  let url: URL
  let scheme = 'http'

  // 将 couchdb:// 协议转换为 http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('couchdb://')) {
    normalized = normalized.replace('couchdb://', 'http://')
  }

  // 确保存在协议
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `无效的 CouchDB 连接字符串：${connectionString}\n` +
        '期望格式：http://host:port 或 couchdb://host:port',
    )
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // 如果存在基础认证信息，则处理
  if (url.username && url.password) {
    const auth = Buffer.from(`${url.username}:${url.password}`).toString(
      'base64',
    )
    headers['Authorization'] = `Basic ${auth}`
  }

  // 构建不含认证和查询参数的基础 URL
  const port = url.port || '5984'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  // 从路径中提取数据库名
  const pathname = url.pathname || ''
  const database =
    pathname.length > 1 ? pathname.slice(1).split('/')[0] : undefined

  return { baseUrl, headers, database }
}

/**
 * 向远程 CouchDB 服务器发送 HTTP 请求
 */
async function remoteCouchDBRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ status: number; data: unknown }> {
  const url = `${baseUrl}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)

    let data: unknown
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `远程 CouchDB 请求在 ${timeoutMs / 1000}秒 后超时：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class CouchDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'CouchDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息以进行二进制操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本列表
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载地址
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '3' -> '3.5.1'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    if (COUCHDB_VERSION_MAP[version]) {
      return COUCHDB_VERSION_MAP[version]
    }
    // 标准化为精确的3段格式（例如 "3" -> "3.0.0", "3.5" -> "3.5.0"）
    const segments = version.split('.').slice(0, 3)
    while (segments.length < 3) {
      segments.push('0')
    }
    return segments.join('.')
  }

  // 获取某个版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'couchdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 CouchDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    // CouchDB 提供启动脚本而非直接的可执行文件
    // Windows 下为 .cmd，Unix 下为 'couchdb'
    const serverPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    return existsSync(serverPath)
  }

  // 检查特定版本的 CouchDB 是否已安装
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return couchdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 CouchDB 二进制文件可用
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await couchdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件路径
    const toolPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    if (existsSync(toolPath)) {
      await configManager.setBinaryPath('couchdb', toolPath, 'bundled')
    }

    return binPath
  }

  /**
   * 初始化新的 CouchDB 数据目录
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
    const port = (options.port as number) || engineDef.defaultPort

    // 创建目录
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`创建了 CouchDB 数据目录：${dataDir}`)
    }

    const logDir = join(containerDir, 'log')
    if (!existsSync(logDir)) {
      await mkdir(logDir, { recursive: true })
    }

    // 生成 local.ini 配置
    const configPath = join(containerDir, 'local.ini')
    const configContent = generateCouchDBConfig({
      port,
      dataDir,
      logDir,
    })
    await writeFile(configPath, configContent)
    logDebug(`已生成 CouchDB 配置：${configPath}`)

    // 生成容器专属 vm.args（含唯一节点名）
    const vmArgsPath = join(containerDir, 'vm.args')
    const vmArgsContent = generateVmArgs(port, containerDir)
    await writeFile(vmArgsPath, vmArgsContent)
    logDebug(`已生成 CouchDB vm.args：${vmArgsPath}`)

    return dataDir
  }

  // 获取 CouchDB 服务端路径
  async getCouchDBServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'couchdb',
      version: fullVersion,
      platform,
      arch,
    })
    const serverPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `CouchDB ${version} 未安装。请运行：spindb engines download couchdb ${version}`,
    )
  }

  // 获取 CouchDB 可执行文件路径
  async getCouchDBPath(version?: string): Promise<string> {
    const cached = await configManager.getBinaryPath('couchdb')
    if (cached && existsSync(cached)) {
      return cached
    }

    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'couchdb',
        version: fullVersion,
        platform,
        arch,
      })
      const couchdbPath = join(
        binPath,
        'bin',
        `couchdb${getCouchDBExtension()}`,
      )
      if (existsSync(couchdbPath)) {
        return couchdbPath
      }
    }

    throw new Error(
      '未找到 couchdb。请运行：spindb engines download couchdb <version>',
    )
  }

  private async getLocalAdminAuth(
    containerName: string,
  ): Promise<LocalCouchDBAuth | null> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.CouchDB,
      getDefaultUsername(Engine.CouchDB),
    )

    return savedCreds
      ? {
          username: savedCreds.username,
          password: savedCreds.password,
        }
      : null
  }

  private async getRuntimeAdminAuth(
    containerName: string,
  ): Promise<LocalCouchDBAuth> {
    return (
      (await this.getLocalAdminAuth(containerName)) ?? {
        username: DEFAULT_ADMIN_USER,
        password: DEFAULT_ADMIN_PASSWORD,
      }
    )
  }

  private async requestLocal(
    container: ContainerConfig,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
    auth?: LocalCouchDBAuth | null,
  ): Promise<{ status: number; data: unknown }> {
    return couchdbApiRequest(
      container.port,
      method,
      path,
      body,
      timeoutMs,
      auth === null
        ? null
        : (auth ?? (await this.getRuntimeAdminAuth(container.name))),
    )
  }

  /**
   * 启动 CouchDB 服务器
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container
    const savedAdminAuth = await this.getLocalAdminAuth(name)
    // 如果存在保存的凭证，则使用它们；否则跳过管理员认证检查。
    // 退回到 admin:admin 会导致在凭证被外部修改（例如云端设置）时出现 401 错误，最终锁定账户。
    const startupAdminAuth = savedAdminAuth

    // 检查是否已在运行
    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 查找 couchdb 可执行文件
    let couchdbServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(
        binaryPath,
        'bin',
        `couchdb${getCouchDBExtension()}`,
      )
      if (existsSync(serverPath)) {
        couchdbServer = serverPath
        logDebug(`使用存储的二进制路径：${couchdbServer}`)
      }
    }

    if (!couchdbServer) {
      try {
        couchdbServer = await this.getCouchDBServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `CouchDB ${version} 未安装。请运行：spindb engines download couchdb ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    logDebug(`使用版本 ${version} 的 couchdb：${couchdbServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'local.ini')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logDir = join(containerDir, 'log')
    const logFile = join(logDir, 'couchdb.log')
    const pidFile = join(containerDir, 'couchdb.pid')

    // 检查端口可用性
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`端口 ${port} 已被占用。`)
      }
      logDebug(`等待端口 ${port} 变为可用状态...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // 保留现有配置（用户可能已添加 [admins] 凭证等）
    // 仅在首次启动时生成全新配置
    const bindAddress = container.bindAddress ?? '127.0.0.1'
    if (existsSync(configPath)) {
      const existingConfig = await readFile(configPath, 'utf-8')
      const patchedConfig = patchCouchDBConfig(existingConfig, {
        port,
        bindAddress,
        adminUsername: savedAdminAuth?.username,
        adminPassword: savedAdminAuth?.password,
      })
      await writeFile(configPath, patchedConfig)
    } else {
      const configContent = generateCouchDBConfig({
        port,
        dataDir,
        logDir,
        bindAddress,
        adminUsername: savedAdminAuth?.username,
        adminPassword: savedAdminAuth?.password,
      })
      await writeFile(configPath, configContent)
    }

    // 重新生成 vm.args，使用此端口的唯一节点名
    const vmArgsPath = join(containerDir, 'vm.args')
    const vmArgsContent = generateVmArgs(port, containerDir)
    await writeFile(vmArgsPath, vmArgsContent)

    onProgress?.({ stage: 'starting', message: '正在启动 CouchDB...' })

    logDebug(`使用配置启动 couchdb：${configPath}`)

    // 获取二进制目录以设置默认配置路径
    const binDir = dirname(dirname(couchdbServer))
    const defaultIni = join(binDir, 'etc', 'default.ini')

    // CouchDB 使用 COUCHDB_INI_FILES 环境变量按顺序加载配置文件
    // COUCHDB_ARGS_FILE 指定包含唯一节点名的自定义 vm.args
    // 在 Windows 上，CouchDB 可能需要设置额外路径
    const env: Record<string, string | undefined> = {
      ...process.env,
      COUCHDB_INI_FILES: `${defaultIni} ${configPath}`,
      COUCHDB_ARGS_FILE: vmArgsPath,
      // 设置 Windows 上的 CouchDB 二进制目录
      COUCHDB_BINDIR: join(binDir, 'bin'),
      COUCHDB_QUERY_SERVER_JAVASCRIPT: join(binDir, 'bin', 'couchjs'),
    }

    // 在 Windows 上，使用 sys.config 在 os_mon 启动前禁用它
    // vm.args 中的设置生效太晚 - os_mon 在初始化时就会崩溃
    // Erlang 在启动时读取 releases/sys.config，因此我们修改该文件
    if (isWindows()) {
      const sysConfigContent = generateSysConfig()

      // 关键位置 - Erlang 发布版从 releases/sys.config 读取配置
      const releasesSysConfig = join(binDir, 'releases', 'sys.config')
      await writeFile(releasesSysConfig, sysConfigContent)

      // 将 vm.args 复制到 Windows CouchDB 期望的位置
      const expectedVmArgs = join(binDir, 'etc', 'vm.args')
      await writeFile(expectedVmArgs, vmArgsContent)

      // 同时更新 releases/vm.args
      const releasesVmArgs = join(binDir, 'releases', 'vm.args')
      await writeFile(releasesVmArgs, vmArgsContent)

      // 关键：将配置写入二进制目录下的 etc/local.ini
      // Windows CouchDB 不遵循 COUCHDB_INI_FILES 环境变量，也可能不扫描 local.d/
      // 直接写入 CouchDB 必定读取的 etc/local.ini
      // 注意：这意味着每个二进制安装只能运行一个容器（本地开发典型场景）
      const localIniPath = join(binDir, 'etc', 'local.ini')
      const localIniContent = await readFile(configPath, 'utf-8')
      await writeFile(localIniPath, localIniContent)
      logDebug(`已将配置写入 ${localIniPath}`)

      // 直接修改 os_mon.app 文件以禁用功能
      // 这会在应用规范本身中设置默认环境值
      const osMonAppPath = join(
        binDir,
        'lib',
        'os_mon-2.9.1',
        'ebin',
        'os_mon.app',
      )
      try {
        const osMonApp = await readFile(osMonAppPath, 'utf8')
        // 替换默认环境设置以禁用所有功能
        const modifiedApp = osMonApp
          .replace('{start_cpu_sup, true}', '{start_cpu_sup, false}')
          .replace('{start_disksup, true}', '{start_disksup, false}')
          .replace('{start_memsup, true}', '{start_memsup, false}')
        await writeFile(osMonAppPath, modifiedApp)
        logDebug('已修改 os_mon.app 以禁用功能')
      } catch (err) {
        logDebug(`修改 os_mon.app 失败：${err}`)
      }

      // 将 os_mon priv/bin 添加到 PATH 环境变量，以便找到 win32sysinfo.exe
      const osMonPrivBin = join(binDir, 'lib', 'os_mon-2.9.1', 'priv', 'bin')
      const existingPath = env.PATH || process.env.PATH || ''
      env.PATH = `${osMonPrivBin};${existingPath}`

      logDebug(`已将 sys.config 写入 ${releasesSysConfig}`)
      logDebug(`已将 vm.args 写入 ${releasesVmArgs}`)
      logDebug(`已添加路径到 PATH：${osMonPrivBin}`)
    }

    // 启动 CouchDB 进程
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        // 在 Windows 上，从 CouchDB 安装目录运行
        // Erlang VM 期望找到相对于其安装目录的文件
        const spawnOpts: SpawnOptions = {
          cwd: binDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
          env,
        }

        // 在 Windows 上，.cmd 文件必须通过 cmd.exe 执行
        const proc = spawn('cmd.exe', ['/c', couchdbServer!], spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`无法启动 CouchDB 服务器：${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
          reject(
            new Error(
              `CouchDB 进程意外退出（${reason}）。\n` +
                `标准错误输出：${stderrOutput || '(无)'}\n` +
                `标准输出：${stdoutOutput || '(无)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          stdoutOutput += data.toString()
        })
        proc.stderr?.on('data', (data: Buffer) => {
          stderrOutput += data.toString()
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(new Error('CouchDB 服务器进程启动失败（无 PID）'))
            return
          }

          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // 非致命错误
          }

          const ready =
            (await this.waitForReady(port)) &&
            (!startupAdminAuth ||
              (await this.waitForAdminReady(port, startupAdminAuth)))
          if (settled) return

          if (ready) {
            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true

            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // 忽略清理错误
              }
            }

            reject(
              new Error(
                `CouchDB 在超时时间内启动失败。\n` +
                  `二进制文件：${couchdbServer}\n` +
                  `配置文件：${configPath}\n` +
                  `日志文件：${logFile}`,
              ),
            )
          }
        }, 500)
      })
    }

    // macOS/Linux
    const proc = spawn(couchdbServer, [], {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('CouchDB 服务器进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    const ready =
      (await this.waitForReady(port)) &&
      (!startupAdminAuth ||
        (await this.waitForAdminReady(port, startupAdminAuth)))

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    throw new Error(
      `CouchDB 在超时时间内启动失败。\n` +
        `二进制文件：${couchdbServer}\n` +
        `配置文件：${configPath}\n` +
        `日志文件：${logFile}`,
    )
  }

  // 等待 CouchDB 准备就绪。
  //
  // CouchDB 的 chttpd HTTP 监听器在其余节点组件（mem3 / fabric / 集群机制）
  // 完成引导之前就会绑定并响应 `GET /`。
  // 在慢速运行环境（尤其是 GitHub Actions macOS x64）中，这个时间差可能足够大，
  // 以至于紧接着的操作——例如对用户数据库的 GET 请求——会命中尚未完全初始化的节点，
  // 并返回 5xx 及 `{"error":"no_majority"}`，进而毒化后续的恢复/PUT 逻辑。
  //
  // CouchDB 通过 `GET /_up` 端点提供就绪信号：文档说明只有节点完全准备好处理请求时，
  // 才会返回 `{"status":"ok"}` 200。我们还额外验证对某个肯定不存在的虚拟数据库的 GET
  // 请求会返回 404 而非 5xx —— 这能捕获 `/_up` 已就绪但 fabric 层仍拒绝查询的罕见情况。
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const upResponse = await couchdbApiRequest(
          port,
          'GET',
          '/_up',
          undefined,
          undefined,
          null,
        )

        let upOk = false
        if (upResponse.status === 200) {
          const upData = upResponse.data as { status?: string } | null
          upOk = upData?.status === 'ok'
        }

        if (upOk) {
          // 验证节点确实能响应数据库查询（返回 404 而非 5xx）
          // 这证明集群机制（mem3/fabric）已引导完毕，而不仅仅是 chttpd
          const probeResponse = await couchdbApiRequest(
            port,
            'GET',
            '/_spindb_readiness_probe',
            undefined,
            undefined,
            null,
          )
          if (probeResponse.status === 404 || probeResponse.status === 401) {
            logDebug(`CouchDB 已在端口 ${port} 就绪`)
            return true
          }
          logDebug(
            `CouchDB _up 已就绪，但数据库查询返回 ${probeResponse.status} ` +
              `在端口 ${port}，等待中...`,
          )
        }
      } catch {
        // 连接失败，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`CouchDB 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  private async waitForAdminReady(
    port: number,
    auth: LocalCouchDBAuth,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await couchdbApiRequest(
          port,
          'GET',
          '/_all_dbs',
          undefined,
          undefined,
          auth,
        )
        if (response.status === 200) {
          logDebug(`CouchDB 管理员认证在端口 ${port} 已就绪`)
          return true
        }
      } catch {
        // 管理员认证尚未就绪，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`CouchDB 管理员认证在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 CouchDB 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'couchdb.pid')

    logDebug(`正在停止端口 ${port} 上的 CouchDB 容器 "${name}"`)

    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 CouchDB 进程 ${pid}`)
      try {
        if (isWindows()) {
          await platformService.terminateProcess(pid, true)
        } else {
          await platformService.terminateProcess(pid, false)
          await new Promise((resolve) => setTimeout(resolve, 2000))

          if (platformService.isProcessRunning(pid)) {
            logWarning(`优雅终止失败，正在强制终止 ${pid}`)
            await platformService.terminateProcess(pid, true)
          }
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    if (isWindows()) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // 终止仍在占用该端口的任何进程
    const portPids = await platformService.findProcessByPort(port)
    for (const portPid of portPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`正在终止仍占用端口 ${port} 的进程 ${portPid}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // 忽略
        }
      }
    }

    if (isWindows() && portPids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    // 清理 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 忽略
      }
    }

    // 注意：在 Windows 上，我们写入 etc/local.ini，每次启动都会覆盖它
    // 无需清理，因为该文件是共享的，并在下次容器启动时更新

    // 在 Windows 上等待端口被释放
    if (isWindows()) {
      logDebug(`等待端口 ${port} 被释放...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        if (await portManager.isPortAvailable(port)) {
          logDebug('端口已成功释放')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('CouchDB 已停止')
  }

  // 获取 CouchDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'couchdb.pid')

    // 尝试通过 REST API 进行健康检查（无需认证，凭证可能已更改）
    // 任何 HTTP 响应（包括 401）都表示 CouchDB 正在运行。
    // 当 require_valid_user = true 且匿名 GET / 返回 401 时，这一点很重要。
    try {
      const response = await couchdbApiRequest(
        port,
        'GET',
        '/',
        undefined,
        undefined,
        null,
      )
      if (response.status >= 200 && response.status < 500) {
        return { running: true, message: 'CouchDB 正在运行' }
      }
    } catch {
      // 无响应，检查 PID
    }

    // 检查 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `CouchDB 正在运行（PID：${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'CouchDB 未运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * CouchDB 可以在运行时恢复（使用 REST API）
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    return restoreBackup(backupPath, {
      containerName: container.name,
      port: container.port,
      database: options.database,
      flush: options.flush,
    })
  }

  /**
   * 获取连接字符串
   * 格式：http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const base = `http://127.0.0.1:${port}`
    return database ? `${base}/${database}` : base
  }

  // 打开 Fauxton Web UI
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}/_utils`

    console.log(`CouchDB REST API 地址：http://127.0.0.1:${port}`)
    console.log(`CouchDB Fauxton UI：${url}`)
    console.log('')
    console.log('示例命令：')
    console.log(`  curl http://127.0.0.1:${port}`)
    console.log(`  curl http://127.0.0.1:${port}/_all_dbs`)
  }

  /**
   * 创建新的数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const response = await this.requestLocal(
      container,
      'PUT',
      `/${encodeURIComponent(database)}`,
    )

    if (response.status !== 201 && response.status !== 412) {
      // 412 表示数据库已存在
      throw new Error(`创建数据库失败：${JSON.stringify(response.data)}`)
    }

    logDebug(`已创建 CouchDB 数据库：${database}`)
  }

  /**
   * 删除数据库
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const response = await this.requestLocal(
      container,
      'DELETE',
      `/${encodeURIComponent(database)}`,
    )

    // 接受 200（OK）或 202（已接受）用于异步删除
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`删除数据库失败：${JSON.stringify(response.data)}`)
    }

    logDebug(`已删除 CouchDB 数据库：${database}（状态码：${response.status}）`)
  }

  /**
   * 获取 CouchDB 实例的大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    try {
      // CouchDB 不直接暴露总大小，但我们可以汇总所有数据库的大小
      const dbsResponse = await this.requestLocal(container, 'GET', '/_all_dbs')
      if (dbsResponse.status !== 200) {
        return null
      }

      const dbs = dbsResponse.data as string[]
      let totalSize = 0

      for (const db of dbs) {
        if (db.startsWith('_')) continue // 跳过系统数据库
        const infoResponse = await this.requestLocal(
          container,
          'GET',
          `/${encodeURIComponent(db)}`,
        )
        if (infoResponse.status === 200) {
          const info = infoResponse.data as { sizes?: { file?: number } }
          totalSize += info.sizes?.file || 0
        }
      }

      return totalSize > 0 ? totalSize : null
    } catch {
      return null
    }
  }

  /**
   * 从远程 CouchDB 连接导出数据
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { baseUrl, headers, database } =
      parseCouchDBConnectionString(connectionString)

    logDebug(`正在连接到位于 ${baseUrl} 的远程 CouchDB`)

    // 检查连通性
    const infoResponse = await remoteCouchDBRequest(
      baseUrl,
      'GET',
      '/',
      headers,
    )
    if (infoResponse.status !== 200) {
      throw new Error(
        `无法连接到 ${baseUrl} 上的 CouchDB：${JSON.stringify(infoResponse.data)}`,
      )
    }

    const serverInfo = infoResponse.data as { version?: string }
    logDebug(`已连接到 CouchDB ${serverInfo?.version || '未知版本'}`)

    // 获取需要备份的数据库列表
    let databasesToBackup: string[]

    if (database) {
      databasesToBackup = [database]
    } else {
      const dbsResponse = await remoteCouchDBRequest(
        baseUrl,
        'GET',
        '/_all_dbs',
        headers,
      )
      if (dbsResponse.status !== 200) {
        throw new Error(`无法列出数据库：${JSON.stringify(dbsResponse.data)}`)
      }
      const allDbs = dbsResponse.data as string[]
      databasesToBackup = allDbs.filter((db) => !db.startsWith('_'))
    }

    logDebug(`正在备份 ${databasesToBackup.length} 个数据库`)

    // 从每个数据库导出文档
    const backup = {
      version: serverInfo?.version || '未知版本',
      created: new Date().toISOString(),
      databases: [] as Array<{ name: string; docs: unknown[] }>,
    }

    for (const dbName of databasesToBackup) {
      logDebug(`正在导出数据库：${dbName}`)

      const docsResponse = await remoteCouchDBRequest(
        baseUrl,
        'GET',
        `/${encodeURIComponent(dbName)}/_all_docs?include_docs=true`,
        headers,
        undefined,
        300000, // 大数据库最多允许 5 分钟
      )

      if (docsResponse.status !== 200) {
        throw new Error(
          `无法导出数据库 ${dbName}：${JSON.stringify(docsResponse.data)}`,
        )
      }

      const docsData = docsResponse.data as {
        rows?: Array<{ doc?: unknown }>
      }
      const docs =
        docsData.rows
          ?.map((row) => row.doc)
          .filter((doc): doc is unknown => doc !== undefined) || []

      // 过滤掉设计文档
      const userDocs = docs.filter((doc) => {
        const d = doc as { _id?: string }
        return d._id && !d._id.startsWith('_design/')
      })

      backup.databases.push({
        name: dbName,
        docs: userDocs,
      })
    }

    // 将备份写入文件
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(backup, null, 2))

    return {
      filePath: outputPath,
      warnings:
        databasesToBackup.length === 0
          ? ['远程 CouchDB 实例没有任何用户数据库']
          : undefined,
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

  // 运行命令 - CouchDB 使用 REST API，而非命令文件
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'CouchDB 不支持命令文件。请直接使用 REST API。\n' +
          `示例：curl http://127.0.0.1:${port}/_all_dbs`,
      )
    }

    if (options.sql) {
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST DATABASES' || command === 'SHOW DATABASES') {
        const response = await this.requestLocal(container, 'GET', '/_all_dbs')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'CouchDB 使用 REST API 进行操作。请使用 curl 或 CouchDB 客户端库。\n' +
          `API 端点：http://127.0.0.1:${port}`,
      )
    }

    throw new Error('必须提供 file 或 sql 选项')
  }

  /**
   * 通过 REST API 执行查询
   *
   * 查询格式：METHOD /path [JSON body]
   * 示例：
   *   GET /_all_dbs
   *   GET /mydb/_all_docs
   *   POST /mydb/_find {"selector": {"type": "user"}}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container

    // 解析查询字符串：METHOD /path [body]
    // 如果提供了 options?.method，查询可以仅包含路径
    const trimmed = query.trim()
    const spaceIdx = trimmed.indexOf(' ')

    let method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    let rest: string

    if (options?.method) {
      // 通过选项提供方法
      method = options.method as 'GET' | 'POST' | 'PUT' | 'DELETE'
      if (spaceIdx !== -1) {
        // 检查第一个标记是否像方法名（GET、POST 等）
        const firstToken = trimmed.substring(0, spaceIdx).toUpperCase()
        if (['GET', 'POST', 'PUT', 'DELETE'].includes(firstToken)) {
          // 查询包含方法前缀，使用其后面的部分
          rest = trimmed.substring(spaceIdx + 1).trim()
        } else {
          // 查询即为路径 + body，全部使用
          rest = trimmed
        }
      } else {
        // 查询仅为路径
        rest = trimmed
      }
    } else {
      // 选项中未提供方法，必须从查询中解析
      if (spaceIdx === -1) {
        throw new Error(
          '无效的查询格式。期望：METHOD /path [body]\n' + '示例：GET /_all_dbs',
        )
      }
      method = trimmed.substring(0, spaceIdx).toUpperCase() as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'DELETE'
      rest = trimmed.substring(spaceIdx + 1).trim()
    }

    // 提取路径和可选的 JSON body
    let path: string
    let body: Record<string, unknown> | undefined = options?.body

    const bodyStart = rest.indexOf('{')
    if (bodyStart !== -1 && !body) {
      path = rest.substring(0, bodyStart).trim()
      try {
        body = JSON.parse(rest.substring(bodyStart)) as Record<string, unknown>
      } catch {
        throw new Error('查询中包含无效的 JSON 请求体')
      }
    } else {
      path = rest
    }

    // 确保路径以 / 开头
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    const auth = options?.password
      ? {
          username: options.username || DEFAULT_ADMIN_USER,
          password: options.password,
        }
      : await this.getRuntimeAdminAuth(container.name)

    const response = await couchdbApiRequest(
      port,
      method,
      path,
      body,
      30000,
      auth,
    )

    if (response.status >= 400) {
      throw new Error(
        `CouchDB API 错误（${response.status}）：${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * 列出所有用户数据库，排除系统数据库（_users, _replicator, _global_changes）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const response = await this.requestLocal(container, 'GET', '/_all_dbs')

    if (response.status >= 400) {
      throw new Error(
        `CouchDB API 错误（${response.status}）：${JSON.stringify(response.data)}`,
      )
    }

    const allDatabases = response.data as string[]
    const systemDatabases = ['_users', '_replicator', '_global_changes']
    const databases = allDatabases.filter(
      (db) => !systemDatabases.includes(db) && !db.startsWith('_'),
    )

    return databases
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port } = container
    const db = database || container.database
    if (!db) {
      throw new Error('未指定数据库。请使用 --database 或先创建一个数据库。')
    }

    // 确保 _users 系统数据库存在（CouchDB 3.x 不会自动创建它）
    const usersDbResponse = await this.requestLocal(container, 'PUT', '/_users')
    if (usersDbResponse.status !== 201 && usersDbResponse.status !== 412) {
      throw new Error(
        `无法确保 _users 数据库存在：${JSON.stringify(usersDbResponse.data)}`,
      )
    }

    // 在 _users 数据库中创建用户文档
    const userDoc = {
      _id: `org.couchdb.user:${username}`,
      name: username,
      type: 'user',
      roles: [],
      password,
    }

    const createResponse = await this.requestLocal(
      container,
      'PUT',
      `/_users/org.couchdb.user:${encodeURIComponent(username)}`,
      userDoc as unknown as Record<string, unknown>,
    )

    if (createResponse.status !== 201 && createResponse.status !== 409) {
      throw new Error(`创建用户失败：${JSON.stringify(createResponse.data)}`)
    }

    if (createResponse.status === 409) {
      // 用户已存在 — 获取当前文档修订号并更新密码
      const getResponse = await this.requestLocal(
        container,
        'GET',
        `/_users/org.couchdb.user:${encodeURIComponent(username)}`,
      )

      if (getResponse.status !== 200 || !getResponse.data) {
        throw new Error(
          `获取现有用户 "${username}" 失败（状态码 ${getResponse.status}）：${JSON.stringify(getResponse.data)}`,
        )
      }

      const existingDoc = getResponse.data as Record<string, unknown>
      const rev = existingDoc._rev as string
      if (!rev) {
        throw new Error(
          `用户 "${username}" 已存在，但文档缺少 _rev 字段：${JSON.stringify(getResponse.data)}`,
        )
      }
      const updateResponse = await this.requestLocal(
        container,
        'PUT',
        `/_users/org.couchdb.user:${encodeURIComponent(username)}`,
        { ...existingDoc, password, _rev: rev },
      )
      if (updateResponse.status !== 201) {
        throw new Error(`更新用户失败：${JSON.stringify(updateResponse.data)}`)
      }
    }

    // 在设置安全策略前确保目标数据库存在
    const dbCreateResponse = await this.requestLocal(
      container,
      'PUT',
      `/${encodeURIComponent(db)}`,
    )
    // 201 = 已创建，412 = 已存在 — 都是允许的
    if (dbCreateResponse.status !== 201 && dbCreateResponse.status !== 412) {
      throw new Error(
        `无法确保数据库 "${db}" 存在：${JSON.stringify(dbCreateResponse.data)}`,
      )
    }

    // 通过 _security 文档授予对目标数据库的访问权限
    const secResponse = await this.requestLocal(
      container,
      'GET',
      `/${encodeURIComponent(db)}/_security`,
    )

    if (secResponse.status !== 200) {
      throw new Error(
        `读取数据库 "${db}" 的安全策略失败：${JSON.stringify(secResponse.data)}`,
      )
    }

    const security = (secResponse.data || {}) as Record<string, unknown>
    const members = (security.members || {}) as Record<string, unknown>
    const names = ((members.names || []) as string[]).slice()

    if (!names.includes(username)) {
      names.push(username)
    }

    const secPutResponse = await this.requestLocal(
      container,
      'PUT',
      `/${encodeURIComponent(db)}/_security`,
      {
        ...security,
        members: { ...members, names },
      },
    )

    if (secPutResponse.status !== 200 && secPutResponse.status !== 201) {
      throw new Error(
        `更新数据库 "${db}" 的安全策略失败：${JSON.stringify(secPutResponse.data)}`,
      )
    }

    logDebug(`已创建 CouchDB 用户：${username}`)

    const connectionString = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(db)}`

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

export const couchdbEngine = new CouchDBEngine()
