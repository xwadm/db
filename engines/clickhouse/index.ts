/**
 * ClickHouse 引擎实现
 * 支持 ClickHouse 数据库容器的启动、停止、备份、还原及 SQL 执行等操作。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, chmod } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { clickhouseBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  CLICKHOUSE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateClickHouseIdentifier,
  escapeClickHouseIdentifier,
} from './cli-utils'
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
import { parseClickHouseJSONResult } from '../../core/query-parser'

const ENGINE = 'clickhouse'
const engineDef = getEngineDefaults(ENGINE)

/**
 * 生成 ClickHouse 服务器配置 XML
 */
function generateClickHouseConfig(options: {
  port: number
  httpPort: number
  dataDir: string
  logDir: string
  tmpDir: string
  pidFile: string
  bindAddress?: string
}): string {
  const { port, httpPort, dataDir, logDir, tmpDir, pidFile } = options

  return `<?xml version="1.0"?>
<clickhouse>
    <logger>
        <level>information</level>
        <log>${logDir}/clickhouse-server.log</log>
        <errorlog>${logDir}/clickhouse-server.err.log</errorlog>
        <size>100M</size>
        <count>3</count>
    </logger>

    <http_port>${httpPort}</http_port>
    <tcp_port>${port}</tcp_port>

    <listen_host>${options.bindAddress ?? '127.0.0.1'}</listen_host>

    <pid_file>${pidFile}</pid_file>

    <path>${dataDir}/</path>
    <tmp_path>${tmpDir}/</tmp_path>
    <user_files_path>${dataDir}/user_files/</user_files_path>

    <users_config>users.xml</users_config>

    <default_profile>default</default_profile>
    <default_database>default</default_database>

    <mark_cache_size>5368709120</mark_cache_size>
    <max_concurrent_queries>100</max_concurrent_queries>

    <user_directories>
        <users_xml>
            <path>users.xml</path>
        </users_xml>
        <local_directory>
            <path>${dataDir}/access/</path>
        </local_directory>
    </user_directories>
</clickhouse>
`
}

/**
 * 生成 ClickHouse 用户配置 XML
 */
function generateUsersConfig(): string {
  return `<?xml version="1.0"?>
<clickhouse>
    <profiles>
        <default>
            <max_memory_usage>10000000000</max_memory_usage>
            <use_uncompressed_cache>0</use_uncompressed_cache>
            <load_balancing>random</load_balancing>
        </default>
    </profiles>

    <users>
        <default>
            <password></password>
            <networks>
                <ip>127.0.0.1</ip>
            </networks>
            <profile>default</profile>
            <quota>default</quota>
            <access_management>1</access_management>
        </default>
    </users>

    <quotas>
        <default>
            <interval>
                <duration>3600</duration>
                <queries>0</queries>
                <errors>0</errors>
                <result_rows>0</result_rows>
                <read_rows>0</read_rows>
                <execution_time>0</execution_time>
            </interval>
        </default>
    </quotas>
</clickhouse>
`
}

/**
 * 解析 ClickHouse 连接字符串
 * 格式：clickhouse://[user:password@]host[:port][/database]
 *
 * 例如：
 * - clickhouse://localhost:8123
 * - clickhouse://default:password@localhost:8123/mydb
 * - clickhouse://user:pass@remote.host:8123/analytics
 */
function parseClickHouseConnectionString(connectionString: string): {
  baseUrl: string
  user: string | undefined
  password: string | undefined
  database: string
} {
  let url: URL

  // 规范化连接字符串
  let normalized = connectionString.trim()

  // 支持 clickhouse:// 协议（转为 http:// 以便 URL 解析）
  if (normalized.startsWith('clickhouse://')) {
    normalized = normalized.replace('clickhouse://', 'http://')
  } else if (
    !normalized.startsWith('http://') &&
    !normalized.startsWith('https://')
  ) {
    throw new Error(
      `无效的 ClickHouse 连接字符串：${connectionString}\n` +
        '期望的格式：clickhouse://[user:password@]host:port[/database]',
    )
  }

  try {
    url = new URL(normalized)
  } catch {
    throw new Error(
      `无效的 ClickHouse 连接字符串：${connectionString}\n` +
        '期望的格式：clickhouse://[user:password@]host:port[/database]',
    )
  }

  const host = url.hostname || 'localhost'
  // ClickHouse HTTP API 默认端口为 8123
  const port = parseInt(url.port, 10) || 8123
  const scheme = url.protocol === 'https:' ? 'https' : 'http'

  const user = url.username || undefined
  const password = url.password || undefined

  // 数据库名位于路径中
  let database = 'default'
  if (url.pathname && url.pathname !== '/') {
    database = url.pathname.replace(/^\//, '')
  }

  const baseUrl = `${scheme}://${host}:${port}`

  return { baseUrl, user, password, database }
}

export class ClickHouseEngine extends BaseEngine {
  name = ENGINE
  displayName = 'ClickHouse'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息以进行二进制文件操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '25.12' -> '25.12.3.21'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return CLICKHOUSE_VERSION_MAP[version] || version
  }

  // 获取指定版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 ClickHouse 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    return existsSync(clickhousePath)
  }

  // 检查特定 ClickHouse 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return clickhouseBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保 ClickHouse 二进制文件对指定版本可用
   * 如果未安装则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await clickhouseBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      await configManager.setBinaryPath('clickhouse', clickhousePath, 'bundled')
    }

    return binPath
  }

  /**
   * 初始化新的 ClickHouse 数据目录
   * 创建目录结构和配置文件
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
    const logDir = containerDir
    const tmpDir = join(dataDir, 'tmp')
    const port = (options.port as number) || engineDef.defaultPort
    const httpPort = port + 1 // HTTP 端口比原生端口大 1

    // 创建目录
    await mkdir(dataDir, { recursive: true })
    await mkdir(tmpDir, { recursive: true })
    await mkdir(join(dataDir, 'user_files'), { recursive: true })
    const accessDir = join(dataDir, 'access')
    await mkdir(accessDir, { recursive: true, mode: 0o700 })
    await chmod(accessDir, 0o700).catch((err) => {
      logDebug(`无法修改目录权限 ${accessDir}：${err}`)
    })

    logDebug(`已创建 ClickHouse 数据目录：${dataDir}`)

    // 生成 config.xml
    const configPath = join(containerDir, 'config.xml')
    const pidFile = join(containerDir, engineDef.pidFileName)
    const configContent = generateClickHouseConfig({
      port,
      httpPort,
      dataDir,
      logDir,
      tmpDir,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`已生成 ClickHouse 配置：${configPath}`)

    // 生成 users.xml
    const usersConfigPath = join(containerDir, 'users.xml')
    const usersConfigContent = generateUsersConfig()
    await writeFile(usersConfigPath, usersConfigContent)
    logDebug(`已生成 ClickHouse 用户配置：${usersConfigPath}`)

    return dataDir
  }

  /**
   * 容器重命名后重新生成 config.xml，更新路径
   * 在目录移动后由容器管理器调用
   */
  async regenerateConfig(containerName: string, port: number): Promise<void> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const logDir = containerDir
    const tmpDir = join(dataDir, 'tmp')
    const httpPort = port + 1

    const accessDir = join(dataDir, 'access')
    try {
      await mkdir(accessDir, { recursive: true, mode: 0o700 })
      await chmod(accessDir, 0o700).catch((err) => {
        logDebug(`无法修改目录权限 ${accessDir}：${err}`)
      })
    } catch (error) {
      logWarning(`创建 ClickHouse access 目录 ${accessDir} 失败：${error}`)
    }

    const configPath = join(containerDir, 'config.xml')
    const pidFile = join(containerDir, engineDef.pidFileName)
    const configContent = generateClickHouseConfig({
      port,
      httpPort,
      dataDir,
      logDir,
      tmpDir,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`重命名后已重新生成 ClickHouse 配置：${configPath}`)
  }

  // 获取指定版本 clickhouse 二进制文件的路径
  async getClickHousePath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      return clickhousePath
    }
    throw new Error(
      `ClickHouse ${version} 未安装。请运行：spindb engines download clickhouse ${version}`,
    )
  }

  // 获取 clickhouse 二进制文件路径（用于客户端操作）
  override async getClickHouseClientPath(version?: string): Promise<string> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('clickhouse')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，则使用已下载的二进制文件
    if (version) {
      return this.getClickHousePath(version)
    }

    throw new Error(
      '未找到 ClickHouse 二进制文件。请运行：spindb engines download clickhouse <version>',
    )
  }

  /**
   * 启动 ClickHouse 服务器
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

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

    // 获取 ClickHouse 二进制文件路径
    let clickhouseBinary: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', 'clickhouse')
      if (existsSync(serverPath)) {
        clickhouseBinary = serverPath
        logDebug(`使用已存储的二进制文件路径：${clickhouseBinary}`)
      }
    }

    if (!clickhouseBinary) {
      try {
        clickhouseBinary = await this.getClickHousePath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `ClickHouse ${version} 未安装。请运行：spindb engines download clickhouse ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'config.xml')
    const logFile = join(containerDir, 'clickhouse-server.log')
    const pidFile = join(containerDir, 'clickhouse.pid')

    onProgress?.({ stage: 'starting', message: '正在启动 ClickHouse...' })

    // 如果设置了 bindAddress，则修补 config.xml 中的监听地址
    if (container.bindAddress && existsSync(configPath)) {
      const configXml = await readFile(configPath, 'utf-8')
      const patched = configXml.replace(
        /<listen_host>[^<]+<\/listen_host>/,
        `<listen_host>${container.bindAddress}</listen_host>`,
      )
      await writeFile(configPath, patched)
    }

    logDebug(`正在使用配置文件启动 ClickHouse：${configPath}`)

    const args = ['server', '--config-file', configPath, '--daemon']

    // 启动守护进程并等待其退出
    // ClickHouse 的 --daemon 会立即 fork，父进程随后退出
    const spawnResult = await new Promise<{
      code: number | null
      stdout: string
      stderr: string
    }>((resolve, reject) => {
      const proc = spawn(clickhouseBinary!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`clickhouse 标准输出：${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`clickhouse 标准错误：${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', (code) => {
        logDebug(`ClickHouse 启动进程已关闭，退出码：${code}`)
        // 捕获结果后再解引用，防止进程过早退出
        proc.unref()
        resolve({ code, stdout, stderr })
      })
    })

    // 检查启动是否成功
    if (spawnResult.code !== 0 && spawnResult.code !== null) {
      throw new Error(
        spawnResult.stderr ||
          spawnResult.stdout ||
          `clickhouse 服务器退出，错误码 ${spawnResult.code}`,
      )
    }

    // ClickHouse 以 --daemon 模式运行，会立即 fork。PID 文件通过抓取
    // `lsof -ti tcp:PORT` 写入（配置文件中的 <pid_file> 指令在守护进程模式下不会生效）。
    // 以前，这仅在 waitForReady 成功后才会执行，从而产生了一个竞态条件：
    // 如果 waitForReady 超时（或 lsof/findProcessByPort 出现问题），守护进程仍会运行，
    // 但没有 PID 文件。spindb 的容器管理器会将容器报告为“已停止”
    // （没有 PID 文件 → process-manager.isRunning 返回 false），而云端的健康检查协调器
    // 会将数据库行状态翻转为 Stopped，尽管守护进程仍在运行。
    // 参见 spindb-status-invariants 笔记。
    //
    // 修复方法：在 waitForReady 之前尝试写入 PID 文件（带有限的短重试，
    // 因为守护进程需要约 1-2 秒来绑定端口）。如果守护进程尚未绑定，
    // waitForReady 仍会确认就绪，并且之后我们会进行第二次 PID 写入尝试。
    // 因此，只要守护进程确实在端口上监听过，无论就绪握手是否成功（在内存不足等情况下
    // 即使守护进程正常也可能失败），PID 文件都会被写入。
    let pidWritten = await this.writePidFromPort(port, pidFile)
    if (pidWritten) {
      logDebug(`在 waitForReady 之前已将 PID 文件写入 ${pidFile}`)
    }

    // 等待服务器就绪（在事件循环外部等待以保持事件循环处于活动状态）
    logDebug(`正在等待 ClickHouse 服务器在端口 ${port} 上就绪...`)
    const ready = await this.waitForReady(port, version)
    logDebug(`waitForReady 返回：${ready}`)

    // 第二次尝试 — 覆盖以下情况：守护进程在端口上绑定得较晚
    // （例如，在第一次 writePidFromPort 重试预算耗尽之后，
    // 但在 waitForReady 放弃之前）。
    if (!pidWritten) {
      pidWritten = await this.writePidFromPort(port, pidFile)
      if (pidWritten) {
        logDebug(`在 waitForReady 之后已将 PID 文件写入 ${pidFile}`)
      }
    }

    if (!ready) {
      // 仅当守护进程也从未绑定到端口时，才将此视为硬故障。
      // 如果 pidWritten 为 true，则守护进程正在运行并监听 —— 就绪探测失败
      // 可能是暂时的握手问题（lsof 竞态、客户端启动缓慢、内存不足的虚拟机）。
      // 让调用者将守护进程视为正在运行，而不是错误地报告为启动失败。
      if (!pidWritten) {
        throw new Error(
          `ClickHouse 未能在超时时间内启动。请查看日志：${logFile}`,
        )
      }
      logWarning(
        `ClickHouse 就绪探测超时，但守护进程正在端口 ${port} 上监听；视为已启动`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  /**
   * 查找绑定到 `port` 的守护进程，并将其 PID 写入 `pidFile`。
   *
   * 最多尝试 `maxAttempts` 次，每次间隔 `intervalMs` 毫秒。
   * 返回 true 表示 PID 文件已成功写入。任何错误都不会致命。
   *
   * 将此方法暴露出来（而不是内联）是为了便于直接进行单元测试：
   * 测试可以传入一个已知端口来驱动此方法，并验证 PID 文件是否出现，
   * 而无需启动真实的 ClickHouse 服务器。
   */
  async writePidFromPort(
    port: number,
    pidFile: string,
    options: { maxAttempts?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = options.maxAttempts ?? 10
    const intervalMs = options.intervalMs ?? 200

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const pids = await platformService.findProcessByPort(port)
        logDebug(
          `writePidFromPort 尝试 ${attempt}/${maxAttempts}：findProcessByPort(${port}) -> ${JSON.stringify(pids)}`,
        )
        if (pids.length > 0) {
          const serverPid = String(pids[0])
          await writeFile(pidFile, serverPid, 'utf8')
          logDebug(`writePidFromPort：已将 ${serverPid} 写入 ${pidFile}`)
          return true
        }
      } catch (error) {
        // 非致命错误：继续尝试。将错误记录在调试日志中以供可见性。
        logDebug(`writePidFromPort 尝试 ${attempt} 出错：${error}`)
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
    return false
  }

  // 等待 ClickHouse 就绪
  // ClickHouse 在冷启动时（CI 运行器、内存不足的虚拟机）可能需要 2-4 分钟
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 240000,
  ): Promise<boolean> {
    logDebug(`waitForReady 被调用，端口 ${port}，版本 ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let clickhouse: string
    try {
      logDebug('正在获取 clickhouse 客户端路径...')
      clickhouse = await this.getClickHouseClientPath(version)
      logDebug(`已获取 clickhouse 客户端路径：${clickhouse}`)
    } catch (err) {
      logDebug(`获取 clickhouse 客户端路径时出错：${err}`)
      logWarning(
        '未找到 ClickHouse 二进制文件，无法验证服务器是否就绪。将在延迟后假定就绪。',
      )
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return true
    }

    logDebug(`开始连接循环，超时：${timeoutMs}ms`)
    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`连接尝试 ${attempt}...`)
      try {
        const args = [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--query',
          'SELECT 1',
        ]
        // 捕获标准错误，以便区分“服务器已关闭”和
        // “服务器已启动但拒绝了未经身份验证的探测”。在重启后，
        // 如果用户设置了密码（例如，云端的 setup-database.sh
        // 在首次配置时编辑 users.xml），此探测不携带凭据，
        // ClickHouse 会返回明确的身份验证失败错误 ——
        // 这本身就是服务器已启动并正在监听的证明。
        // 将此情况视为就绪，以避免在每次重启受密码保护的 ClickHouse 时
        // 消耗完整的 240 秒超时时间。
        const authFailedReady = await new Promise<boolean>(
          (resolve, reject) => {
            const proc = spawn(clickhouse, args, {
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            let stderr = ''
            proc.stderr?.on('data', (data: Buffer) => {
              stderr += data.toString()
            })
            proc.on('close', (code) => {
              logDebug(`客户端进程已关闭，退出码 ${code}`)
              if (code === 0) {
                resolve(false) // 通过成功查询就绪，不需要身份验证回退
                return
              }
              // ClickHouse 服务器正在响应，但由于需要身份验证而拒绝了探测。
              // 我们在此处没有密码，因此将身份验证错误视为明确的“服务器已启动”信号。
              if (
                /Authentication failed|password is incorrect|there is no user with such name|UNKNOWN_USER|AUTHENTICATION_FAILED/i.test(
                  stderr,
                )
              ) {
                logDebug(
                  `ClickHouse 返回需要身份验证（退出码 ${code}）；服务器已启动 —— 视为就绪`,
                )
                resolve(true)
                return
              }
              reject(new Error(`退出码 ${code}：${stderr.slice(0, 200)}`))
            })
            proc.on('error', (err) => {
              logDebug(`客户端进程错误：${err}`)
              reject(err)
            })
          },
        )
        if (authFailedReady) {
          logDebug(`ClickHouse 在端口 ${port} 上已就绪（需要身份验证）`)
        } else {
          logDebug(`ClickHouse 在端口 ${port} 上已就绪`)
        }
        return true
      } catch (err) {
        logDebug(`尝试 ${attempt} 失败：${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`ClickHouse 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 ClickHouse 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'clickhouse.pid')

    logDebug(`正在停止 ClickHouse 容器 "${name}"，端口 ${port}`)

    // 通过跨平台辅助函数查找 PID
    let pid: number | null = null

    // 尝试通过端口查找 ClickHouse 进程
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        pid = pids[0]
      }
    } catch {
      // 忽略错误
    }

    // 如果找到进程，则终止它
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 ClickHouse 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`正常终止失败，正在强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    // 清理 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 忽略错误
      }
    }

    logDebug('ClickHouse 已停止')
  }

  // 获取 ClickHouse 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port, version } = container

    // 尝试连接
    try {
      const clickhouse = await this.getClickHouseClientPath(version)
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--query',
        'SELECT 1',
      ]
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`退出码 ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'ClickHouse 正在运行' }
    } catch {
      return { running: false, message: 'ClickHouse 未运行' }
    }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 还原备份
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; clean?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port, version } = container

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database: options.database || container.database || 'default',
      version,
      clean: options.clean,
    })
  }

  /**
   * 获取连接字符串
   * 格式：clickhouse://127.0.0.1:PORT/DATABASE
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'default'
    return `clickhouse://127.0.0.1:${port}/${db}`
  }

  // 打开 clickhouse 客户端交互式 shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        clickhouse,
        [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--database',
          db,
        ],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    // 验证数据库标识符以防止 SQL 注入
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = escapeClickHouseIdentifier(database)

    const clickhouse = await this.getClickHouseClientPath(version)

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--query',
      `CREATE DATABASE IF NOT EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已创建 ClickHouse 数据库：${database}`)
          resolve()
        } else {
          reject(new Error(`创建数据库失败：${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 删除数据库
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    if (database === 'default' || database === 'system') {
      throw new Error(`不能删除系统数据库：${database}`)
    }

    // 验证数据库标识符以防止 SQL 注入
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = escapeClickHouseIdentifier(database)

    const clickhouse = await this.getClickHouseClientPath(version)

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--query',
      `DROP DATABASE IF EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已删除 ClickHouse 数据库：${database}`)
          resolve()
        } else {
          reject(new Error(`删除数据库失败：${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 使用 ClickHouse 原生 RENAME DATABASE 重命名数据库
   */
  async renameDatabase(
    container: ContainerConfig,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const { port, version } = container

    if (oldName === 'default' || oldName === 'system') {
      throw new Error(`不能重命名系统数据库：${oldName}`)
    }
    if (newName === 'default' || newName === 'system') {
      throw new Error(`不能重命名为系统数据库名：${newName}`)
    }

    validateClickHouseIdentifier(oldName, 'database')
    validateClickHouseIdentifier(newName, 'database')
    const escapedOld = escapeClickHouseIdentifier(oldName)
    const escapedNew = escapeClickHouseIdentifier(newName)

    const clickhouse = await this.getClickHouseClientPath(version)

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--query',
      `RENAME DATABASE ${escapedOld} TO ${escapedNew}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已将 ClickHouse 数据库重命名：${oldName} -> ${newName}`)
          resolve()
        } else {
          reject(new Error(`重命名数据库失败：${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 获取数据库大小（字节）
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, version, database } = container

    try {
      const clickhouse = await this.getClickHouseClientPath(version)
      // 验证并转义数据库名以防止 SQL 注入
      const dbName = database || 'default'
      validateClickHouseIdentifier(dbName, 'database')
      // 转义单引号以用于 WHERE 子句中的字符串字面量
      const escapedDbName = dbName.replace(/'/g, "''")
      const query = `SELECT sum(bytes_on_disk) FROM system.parts WHERE database = '${escapedDbName}'`

      const result = await new Promise<string>((resolve, reject) => {
        const args = [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--query',
          query,
        ]

        const proc = spawn(clickhouse, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`退出码 ${code}`))
        })
        proc.on('error', reject)
      })

      const size = parseInt(result, 10)
      return isNaN(size) ? null : size
    } catch {
      return null
    }
  }

  /**
   * 从远程 ClickHouse 连接导出数据
   * 使用 ClickHouse 的 HTTP API 导出架构和数据
   *
   * 连接字符串格式：clickhouse://[user:password@]host[:port][/database]
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串
    const { baseUrl, user, password, database } =
      parseClickHouseConnectionString(connectionString)

    // 验证并转义数据库标识符以防止 SQL 注入
    validateClickHouseIdentifier(database, 'database')
    const escapedDatabase = escapeClickHouseIdentifier(database)

    logDebug(`正在连接到远程 ClickHouse：${baseUrl}（数据库：${database}）`)

    // 构建用于身份验证的请求头
    const headers: Record<string, string> = {}
    if (user) {
      headers['X-ClickHouse-User'] = user
      if (password) {
        headers['X-ClickHouse-Key'] = password
      }
    }

    // 辅助函数：通过 HTTP API 执行查询
    const execQuery = async (query: string): Promise<string> => {
      const url = new URL(baseUrl)
      url.searchParams.set('query', query)
      url.searchParams.set('database', database)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`ClickHouse 查询失败：${errorText}`)
      }

      return response.text()
    }

    // 测试连接
    try {
      const result = await execQuery('SELECT 1')
      if (!result.trim().includes('1')) {
        throw new Error(`测试查询的意外响应：${result.trim()}`)
      }
    } catch (error) {
      throw new Error(
        `无法连接到 ClickHouse：${baseUrl}，错误：${(error as Error).message}`,
      )
    }

    // 获取表列表
    const tablesResult = await execQuery(
      `SELECT name FROM system.tables WHERE database = '${database.replace(/'/g, "''")}' ORDER BY name`,
    )
    const tables = tablesResult
      .trim()
      .split('\n')
      .filter((t) => t.trim())

    logDebug(`在数据库 ${database} 中找到 ${tables.length} 个表`)

    // 构建 SQL 备份
    const lines: string[] = []
    lines.push('-- SpinDB 生成的 ClickHouse 备份')
    lines.push(`-- 来源：${baseUrl}`)
    lines.push(`-- 数据库：${database}`)
    lines.push(`-- 日期：${new Date().toISOString()}`)
    lines.push('')

    for (const table of tables) {
      // 验证表名
      validateClickHouseIdentifier(table, 'table')
      const escapedTable = escapeClickHouseIdentifier(table)

      lines.push(`-- 表：${table}`)
      lines.push('')

      // 获取 CREATE TABLE 语句（使用 TSVRaw 获取未转义的输出）
      try {
        const createUrl = new URL(baseUrl)
        createUrl.searchParams.set(
          'query',
          `SHOW CREATE TABLE ${escapedDatabase}.${escapedTable} FORMAT TSVRaw`,
        )

        const createResponse = await fetch(createUrl.toString(), { headers })
        if (!createResponse.ok) {
          logWarning(`无法获取表 ${table} 的 CREATE TABLE 语句`)
          continue
        }

        let createStmt = (await createResponse.text()).trim()

        // 去掉数据库前缀以提高可移植性
        const dbPrefixPattern = new RegExp(
          `(CREATE TABLE\\s+)\`?${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\.`,
          'i',
        )
        createStmt = createStmt.replace(dbPrefixPattern, '$1')

        lines.push(createStmt + ';')
        lines.push('')
      } catch (error) {
        logWarning(`无法获取表 ${table} 的 CREATE TABLE 语句：${error}`)
        continue
      }

      // 使用 SQLInsert 格式导出数据
      try {
        const dataUrl = new URL(baseUrl)
        dataUrl.searchParams.set(
          'query',
          `SELECT * FROM ${escapedDatabase}.${escapedTable} FORMAT SQLInsert`,
        )

        const dataResponse = await fetch(dataUrl.toString(), { headers })
        if (!dataResponse.ok) {
          const errorText = await dataResponse.text()
          logWarning(
            `无法导出表 ${table} 的数据：HTTP ${dataResponse.status} - ${errorText}`,
          )
        } else {
          const data = (await dataResponse.text()).trim()
          if (data) {
            // SQLInsert 格式使用 'table' 作为占位符，替换为实际表名
            // 处理变体：TABLE、`table`、"table"、'table' 以及可选的空格
            const insertData = data.replace(
              /INSERT\s+INTO\s+[`"']?table[`"']?\s*\(/gi,
              `INSERT INTO ${escapedTable} (`,
            )
            lines.push(insertData)
            lines.push('')
          }
        }
      } catch (error) {
        logWarning(`无法导出表 ${table} 的数据：${error}`)
      }
    }

    // 写入文件
    const content = lines.join('\n')
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        tables.length === 0 ? [`数据库 '${database}' 中没有表`] : undefined,
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

  // 运行 SQL 文件或内联 SQL 语句
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    if (options.file) {
      // 读取文件并通过管道传给 clickhouse 客户端
      const fileContent = await readFile(options.file, 'utf-8')
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--multiquery',
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`clickhouse 客户端退出，错误码 ${code}`))
        })

        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // 通过标准输入运行内联 SQL，以避免命令注入
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--multiquery',
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`clickhouse 客户端退出，错误码 ${code}`))
        })

        proc.stdin?.write(options.sql)
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
    const { port, version } = container
    const db = options?.database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    // 处理 FORMAT 子句：替换现有的 FORMAT 或追加 FORMAT JSON
    // 正则表达式匹配 "FORMAT <type>"，后跟可选的尾部空格/分号
    let queryWithFormat = query.trim()
    const formatRegex = /\bFORMAT\s+\w+\s*;?\s*$/i
    if (formatRegex.test(queryWithFormat)) {
      // 将现有的 FORMAT 子句替换为 FORMAT JSON
      queryWithFormat = queryWithFormat.replace(formatRegex, 'FORMAT JSON')
    } else {
      // 没有 FORMAT 子句，追加 FORMAT JSON
      queryWithFormat = queryWithFormat.replace(/;?\s*$/, ' FORMAT JSON')
    }

    return new Promise((resolve, reject) => {
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--query',
        queryWithFormat,
      ]

      if (options?.username) {
        args.push('--user', options.username)
      }
      if (options?.password) {
        args.push('--password', options.password)
      }

      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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
        if (code === 0) {
          resolve(parseClickHouseJSONResult(stdout))
        } else {
          reject(new Error(stderr || `clickhouse 退出，错误码 ${code}`))
        }
      })
    })
  }

  /**
   * 列出所有用户数据库，排除系统数据库（system、information_schema、INFORMATION_SCHEMA）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port, version } = container
    const clickhouse = await this.getClickHouseClientPath(version)

    logDebug(`正在列出端口 ${port} 上版本 ${version} 的数据库`)

    return new Promise((resolve, reject) => {
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--query',
        'SHOW DATABASES',
      ]

      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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
        if (code !== 0) {
          reject(new Error(stderr || `clickhouse 退出，错误码 ${code}`))
          return
        }

        // 解析输出（每行一个数据库名）
        const systemDatabases = [
          'system',
          'information_schema',
          'INFORMATION_SCHEMA',
        ]
        const databases = stdout
          .trim()
          .split('\n')
          .map((db) => db.trim())
          .filter((db) => db.length > 0 && !systemDatabases.includes(db))

        resolve(databases)
      })
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port, version } = container
    const db = database || container.database || 'default'

    validateClickHouseIdentifier(username, 'username')
    validateClickHouseIdentifier(db, 'database')
    const escapedUser = escapeClickHouseIdentifier(username)
    const escapedDb = escapeClickHouseIdentifier(db)

    const clickhouse = await this.getClickHouseClientPath(version)

    const escapedPass = password.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const sql = `CREATE USER IF NOT EXISTS ${escapedUser} IDENTIFIED BY '${escapedPass}'; ALTER USER ${escapedUser} IDENTIFIED BY '${escapedPass}'; GRANT ALL ON ${escapedDb}.* TO ${escapedUser};`

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--multiquery',
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已创建 ClickHouse 用户：${username}`)
          resolve()
        } else {
          reject(new Error(`创建用户失败：${stderr}`))
        }
      })
      proc.on('error', reject)

      proc.stdin?.write(sql)
      proc.stdin?.end()
    })

    const connectionString = `clickhouse://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const clickhouseEngine = new ClickHouseEngine()
