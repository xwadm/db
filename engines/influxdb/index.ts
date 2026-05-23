import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { chmod, mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { getWindowsDllEnv } from '../../core/library-env'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
  saveCredentials,
} from '../../core/credential-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { influxdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { influxdbApiRequest } from './api-client'
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
  Engine,
  type QueryResult,
  type QueryOptions,
  type CreateUserOptions,
  type UserCredentials,
} from '../../types'
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'influxdb'
const engineDef = getEngineDefaults(ENGINE)
const ADMIN_TOKEN_FILE = 'admin-token.json'

/**
 * 启动 InfluxDB 后检查其是否就绪的初始延迟时间。
 * Windows 需要更长的延迟，因为进程启动较慢。
 */
const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500

/**
 * 解析 InfluxDB 连接字符串
 * 支持的格式：
 * - http://host:port
 * - https://host:port
 * - influxdb://host:port（转换为 http）
 */
function parseInfluxDBConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
  database?: string
} {
  let url: URL
  let scheme = 'http'

  // 通过将 influxdb:// 转换为 http:// 来处理该协议
  let normalized = connectionString.trim()
  if (normalized.startsWith('influxdb://')) {
    normalized = normalized.replace('influxdb://', 'http://')
  }

  // 确保协议前缀存在
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `无效的 InfluxDB 连接字符串：${connectionString}\n` +
        '期望格式：http://host:port 或 influxdb://host:port',
    )
  }

  // 提取 token（如果提供）
  const token = url.searchParams.get('token')
  const database = url.searchParams.get('db') || undefined

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // 构建不含查询参数的基础 URL
  const port = url.port || '8086'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers, database }
}

/**
 * 向远程 InfluxDB 服务器发起 HTTP 请求
 */
async function remoteInfluxDBRequest(
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
        `远程 InfluxDB 请求超时（${timeoutMs / 1000}秒）：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

type StoredAdminToken = {
  token: string
  name: string
}

function getAdminTokenPath(containerName: string): string {
  const containerDir = paths.getContainerPath(containerName, { engine: ENGINE })
  return join(containerDir, ADMIN_TOKEN_FILE)
}

async function readAdminToken(
  containerName: string,
): Promise<StoredAdminToken | null> {
  const tokenPath = getAdminTokenPath(containerName)
  if (!existsSync(tokenPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(await readFile(tokenPath, 'utf-8')) as Partial<
      StoredAdminToken
    >

    if (!parsed.token || !parsed.name) {
      throw new Error('缺少 token 或 name 字段')
    }

    return {
      token: parsed.token,
      name: parsed.name,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `读取 InfluxDB 管理员令牌文件 ${tokenPath} 失败：${message}`,
    )
  }
}

function buildInfluxTokenCredentials(
  container: ContainerConfig,
  username: string,
  token: string,
): UserCredentials {
  return {
    username,
    password: '',
    connectionString: `http://127.0.0.1:${container.port}`,
    engine: container.engine,
    container: container.name,
    apiKey: token,
  }
}

export class InfluxDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'InfluxDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  private async getStoredAuthToken(
    containerName: string,
    username?: string,
  ): Promise<string | undefined> {
    const adminToken = await readAdminToken(containerName).catch(() => null)
    if (adminToken) {
      return adminToken.token
    }

    const lookupUsername = username ?? getDefaultUsername(Engine.InfluxDB)
    const savedCreds = await loadCredentials(
      containerName,
      Engine.InfluxDB,
      lookupUsername,
    )
    return savedCreds?.apiKey
  }

  private async requestLocal(
    containerName: string,
    port: number,
    method: string,
    path: string,
    body?: Record<string, unknown> | string,
    timeoutMs = 30000,
    username?: string,
  ): Promise<{ status: number; data: unknown }> {
    const token = await this.getStoredAuthToken(containerName, username)
    return influxdbApiRequest(port, method, path, body, timeoutMs, token)
  }

  // 获取平台信息，用于二进制文件操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本列表
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '3' -> '3.8.0'）
  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  // 获取指定版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'influxdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 InfluxDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `influxdb3${ext}`)
    return existsSync(serverPath)
  }

  // 检查指定 InfluxDB 版本是否已安装
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return influxdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 InfluxDB 二进制文件可用
   * 若未安装则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await influxdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['influxdb3'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 InfluxDB 数据目录
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })

    // 如果容器目录不存在则创建
    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 InfluxDB 数据目录：${dataDir}`)
    }

    return dataDir
  }

  // 获取指定版本的 influxdb3 服务端路径
  async getInfluxDBServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'influxdb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `influxdb3${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `InfluxDB ${version} 未安装。请运行：spindb engines download influxdb ${version}`,
    )
  }

  // 获取 influxdb3 二进制文件路径
  async getInfluxDBPath(version?: string): Promise<string> {
    // 先检查配置缓存
    const cached = await configManager.getBinaryPath('influxdb3')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，使用已下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'influxdb',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const influxdbPath = join(binPath, 'bin', `influxdb3${ext}`)
      if (existsSync(influxdbPath)) {
        return influxdbPath
      }
    }

    throw new Error(
      '未找到 influxdb3。请运行：spindb engines download influxdb <version>',
    )
  }

  /**
   * 启动 InfluxDB 服务器
   * 命令行：influxdb3 serve --data-dir /path/to/data --http-bind 127.0.0.1:PORT
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

    // 如果有已存储的二进制文件路径则优先使用
    let influxdbServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `influxdb3${ext}`)
      if (existsSync(serverPath)) {
        influxdbServer = serverPath
        logDebug(`使用已存储的二进制文件路径：${influxdbServer}`)
      }
    }

    // 回退到常规路径
    if (!influxdbServer) {
      try {
        influxdbServer = await this.getInfluxDBServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `InfluxDB ${version} 未安装。请运行：spindb engines download influxdb ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    logDebug(`使用 influxdb3（版本 ${version}）：${influxdbServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    // 在 Windows 上，等待端口释放的时间更长
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    // 检查 HTTP 端口是否可用
    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`HTTP 端口 ${port} 已被占用。`)
      }
      logDebug(`等待 HTTP 端口 ${port} 释放...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    onProgress?.({ stage: 'starting', message: '正在启动 InfluxDB...' })

    const adminToken = await readAdminToken(name)

    // 构建命令行参数。InfluxDB 3.x 使用 'serve' 并需要 --node-id 参数。
    // 使用固定的 node-id 以便在容器重命名后数据能持久保留。
    const args = [
      'serve',
      '--node-id',
      'spindb',
      '--object-store',
      'file',
      '--data-dir',
      dataDir,
      '--http-bind',
      `${container.bindAddress ?? '127.0.0.1'}:${port}`,
    ]

    if (adminToken) {
      args.push(
        '--admin-token-file',
        getAdminTokenPath(name),
        '--disable-authz',
        'health,ping',
      )
      logDebug(`为 ${name} 使用已持久化的 InfluxDB 管理员令牌`)
    } else {
      args.push('--without-auth')
    }

    logDebug(`正在启动 influxdb3，参数：${args.join(' ')}`)

    /**
     * 检查日志文件中的启动错误
     */
    const checkLogForError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000) // 最后 2KB

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `端口 ${port} 已被占用`
        }
        if (recentLog.includes('Failed to bind')) {
          return `端口 ${port} 已被占用`
        }
      } catch {
        // 日志文件可能尚不存在
      }
      return null
    }

    // 在 Windows 上，influxdb3.exe 需要同目录 python/ 中的 python313.dll
    const pythonDllEnv = getWindowsDllEnv(join(dirname(influxdbServer), 'python'))

    // InfluxDB 以前台模式运行，因此需要以分离模式启动
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
          windowsHide: true,
          env: { ...process.env, ...pythonDllEnv },
        }

        const proc = spawn(influxdbServer, args, spawnOpts)
        let settled = false

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`启动 InfluxDB 服务器失败：${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
          reject(
            new Error(
              `InfluxDB 进程意外退出（${reason}）。`,
            ),
          )
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(
              new Error('InfluxDB 服务器进程启动失败（无 PID）'),
            )
            return
          }

          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // 非致命错误
          }

          const ready =
            (await this.waitForReady(port)) &&
            (!adminToken || (await this.waitForAuthReady(port, adminToken.token)))
          if (settled) return

          if (ready) {
            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true

            // 在拒绝之前清理孤立的分离进程
            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // 忽略清理错误
              }
            }

            const portError = await checkLogForError()

            const errorDetails = [
              portError || 'InfluxDB 在超时时间内未能启动。',
              `二进制文件：${influxdbServer}`,
              `日志文件：${logFile}`,
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, START_CHECK_DELAY_MS)
      })
    }

    // macOS/Linux：以忽略 stdio 的方式启动，使 Node.js 能正常退出
    const proc = spawn(influxdbServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env, ...pythonDllEnv },
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('InfluxDB 服务器进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    // 等待 InfluxDB 就绪
    const ready =
      (await this.waitForReady(port)) &&
      (!adminToken || (await this.waitForAuthReady(port, adminToken.token)))

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 在抛出错误前清理孤立的分离进程
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM')
        logDebug(`已终止进程组 ${proc.pid}`)
      } catch {
        try {
          process.kill(proc.pid, 'SIGTERM')
          logDebug(`已终止进程 ${proc.pid}`)
        } catch {
          // 忽略 - 进程可能已经退出
        }
      }
    }

    // 清理 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 非致命错误
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'InfluxDB 在超时时间内未能启动。',
      `二进制文件：${influxdbServer}`,
      `日志文件：${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // 等待 InfluxDB 准备好接受连接
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // InfluxDB 3.x 健康检查端点
        const response = await influxdbApiRequest(port, 'GET', '/health')
        if (response.status === 200) {
          logDebug(`InfluxDB 已在端口 ${port} 上就绪`)
          return true
        }
      } catch {
        // 连接失败，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`InfluxDB 在 ${timeoutMs}ms 内未能就绪`)
    return false
  }

  private async waitForAuthReady(
    port: number,
    apiKey: string,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await influxdbApiRequest(
          port,
          'GET',
          '/api/v3/configure/database?format=json',
          undefined,
          30000,
          apiKey,
        )
        if (response.status === 200) {
          logDebug(`InfluxDB 认证已在端口 ${port} 上就绪`)
          return true
        }
      } catch {
        // 认证尚未就绪，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`InfluxDB 认证在 ${timeoutMs}ms 内未能就绪`)
    return false
  }

  /**
   * 停止 InfluxDB 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    logDebug(`正在停止 InfluxDB 容器 "${name}"（端口 ${port}）`)

    // 获取 PID 并终止进程
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    // 如果进程正在运行则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 InfluxDB 进程 ${pid}`)
      try {
        if (isWindows()) {
          await platformService.terminateProcess(pid, true)
        } else {
          await platformService.terminateProcess(pid, false)
          await new Promise((resolve) => setTimeout(resolve, 2000))

          if (platformService.isProcessRunning(pid)) {
            logWarning(`优雅终止失败，强制终止进程 ${pid}`)
            await platformService.terminateProcess(pid, true)
          }
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    // 等待进程完全终止
    if (isWindows()) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // 终止仍在监听端口的进程
    const portPids = await platformService.findProcessByPort(port)
    for (const portPid of portPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`正在终止仍在端口 ${port} 上的进程 ${portPid}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // 忽略
        }
      }
    }

    // 在 Windows 上，终止端口进程后再次等待
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

    // 在 Windows 上，等待端口释放
    if (isWindows()) {
      logDebug(`等待端口 ${port} 释放...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        const httpAvailable = await portManager.isPortAvailable(port)

        if (httpAvailable) {
          logDebug('端口已成功释放')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('InfluxDB 已停止')
  }

  // 获取 InfluxDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    // 尝试通过 REST API 进行健康检查
    try {
      const response = await influxdbApiRequest(port, 'GET', '/health')
      if (response.status === 200) {
        return { running: true, message: 'InfluxDB 正在运行' }
      }
    } catch {
      // 未响应，检查 PID
    }

    // 检查 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `InfluxDB 正在运行（PID：${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'InfluxDB 未运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * InfluxDB 在 SQL 恢复期间可以保持运行（通过 REST API）
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port } = container
    const database = _options.database || container.database

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database,
    })
  }

  /**
   * 获取连接字符串
   * 格式：http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `http://127.0.0.1:${port}`
  }

  // 打开 HTTP API（InfluxDB 使用 REST API）
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`InfluxDB REST API 地址：${url}`)
    console.log('')
    console.log('示例命令：')
    console.log(`  curl ${url}/health`)
    console.log(
      `  curl -X POST ${url}/api/v3/query_sql -H "Content-Type: application/json" -d '{"db":"mydb","q":"SELECT 1"}'`,
    )
  }

  /**
   * 创建新数据库
   * InfluxDB 3.x 在首次写入时隐式创建数据库，
   * 但我们可以验证服务器是否正在运行
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { name, port } = container

    // InfluxDB 3.x 在写入数据时隐式创建数据库
    // 验证服务器可访问并写入测试记录以创建数据库
    const response = await this.requestLocal(
      name,
      port,
      'POST',
      `/api/v3/write_lp?db=${encodeURIComponent(database)}`,
      undefined,
    )

    // 204 或 200 表示成功，但也可能收到 2xx 状态码且响应体为空
    // 这是正常的 —— 数据库将在首次写入时创建
    if (response.status >= 400) {
      logDebug(
        `数据库创建提示：${JSON.stringify(response.data)}。数据库将在首次写入时创建。`,
      )
    }

    logDebug(`InfluxDB 数据库 "${database}" 已就绪（将在首次写入时创建）`)
  }

  /**
   * 删除数据库
   * InfluxDB 3.x 没有通过 REST 直接执行 DROP DATABASE 的命令
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { name, port } = container

    // 尝试删除数据库中的所有表
    const tablesResponse = await this.requestLocal(
      name,
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: 'SHOW TABLES',
        format: 'json',
      },
    )

    if (tablesResponse.status === 200) {
      const tables = tablesResponse.data as Array<Record<string, unknown>>
      if (Array.isArray(tables)) {
        for (const row of tables) {
          // 仅删除用户表（iox 模式），跳过系统表/information_schema
          const schema = row.table_schema as string | undefined
          if (schema && schema !== 'iox') continue
          const tableName =
            (row.table_name as string) ||
            (row.name as string) ||
            (Object.values(row)[0] as string)
          if (tableName) {
            await this.requestLocal(name, port, 'POST', '/api/v3/query_sql', {
              db: database,
              q: `DROP TABLE "${tableName}"`,
              format: 'json',
            })
          }
        }
      }
    }

    logDebug(`已删除 InfluxDB 数据库中的所有表：${database}`)
  }

  /**
   * 获取 InfluxDB 实例的存储大小
   */
  async getDatabaseSize(_container: ContainerConfig): Promise<number | null> {
    // InfluxDB 3.x 没有直接获取大小的端点
    // 返回 null 以使用基于文件系统的计算方式
    return null
  }

  /**
   * 从远程 InfluxDB 连接导出数据
   * 使用 InfluxDB REST API 查询表并将数据导出为 SQL
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { baseUrl, headers, database } =
      parseInfluxDBConnectionString(connectionString)

    logDebug(`正在连接远程 InfluxDB：${baseUrl}`)

    // 检查连接性
    const healthResponse = await remoteInfluxDBRequest(
      baseUrl,
      'GET',
      '/health',
      headers,
    )
    if (healthResponse.status !== 200) {
      throw new Error(
        `连接 InfluxDB ${baseUrl} 失败：${JSON.stringify(healthResponse.data)}`,
      )
    }

    const db = database || 'mydb'
    const warnings: string[] = []

    // 获取表列表
    const tablesResponse = await remoteInfluxDBRequest(
      baseUrl,
      'POST',
      '/api/v3/query_sql',
      headers,
      { db, q: 'SHOW TABLES', format: 'json' },
    )

    const tablesData = tablesResponse.data as Array<Record<string, unknown>>
    const tables: string[] = []
    if (Array.isArray(tablesData)) {
      for (const row of tablesData) {
        const schema = row.table_schema as string | undefined
        if (schema && schema !== 'iox') continue
        const tableName =
          (row.table_name as string) ||
          (row.name as string) ||
          (Object.values(row)[0] as string)
        if (tableName) tables.push(tableName)
      }
    }

    logDebug(`在远程服务器上找到 ${tables.length} 张表`)

    if (tables.length === 0) {
      warnings.push(
        `远程 InfluxDB 实例在数据库 "${db}" 中没有表`,
      )
    }

    // 构建 SQL 转储（与本地备份格式相同）
    let sqlContent = `-- InfluxDB SQL 备份\n`
    sqlContent += `-- 数据库：${db}\n`
    sqlContent += `-- 来源：${baseUrl}\n`
    sqlContent += `-- 创建时间：${new Date().toISOString()}\n\n`

    for (const table of tables) {
      // 查询列元数据用于标签识别
      const tagColumns: string[] = []
      try {
        const colResponse = await remoteInfluxDBRequest(
          baseUrl,
          'POST',
          '/api/v3/query_sql',
          headers,
          {
            db,
            q: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}'`,
            format: 'json',
          },
        )
        if (colResponse.status === 200 && Array.isArray(colResponse.data)) {
          for (const col of colResponse.data as Array<
            Record<string, unknown>
          >) {
            if (String(col.data_type || '').includes('Dictionary')) {
              tagColumns.push(String(col.column_name))
            }
          }
        }
      } catch {
        logDebug(`警告：无法查询表 ${table} 的列元数据`)
      }

      // 查询表中的所有数据
      const dataResponse = await remoteInfluxDBRequest(
        baseUrl,
        'POST',
        '/api/v3/query_sql',
        headers,
        {
          db,
          q: `SELECT * FROM "${table.replace(/"/g, '""')}"`,
          format: 'json',
        },
      )

      if (dataResponse.status !== 200) {
        const msg = `导出表 ${table} 失败：${JSON.stringify(dataResponse.data)}`
        logDebug(`警告：${msg}`)
        warnings.push(msg)
        continue
      }

      const rows = dataResponse.data as Array<Record<string, unknown>>
      if (Array.isArray(rows) && rows.length > 0) {
        sqlContent += `-- 表：${table}\n`
        if (tagColumns.length > 0) {
          sqlContent += `-- 标签：${tagColumns.join(', ')}\n`
        }

        for (const row of rows) {
          const columns = Object.keys(row)
          const values = columns.map((col) => {
            const val = row[col]
            if (val === null || val === undefined) return 'NULL'
            if (typeof val === 'number') return String(val)
            if (typeof val === 'boolean') return val ? 'true' : 'false'
            return `'${String(val).replace(/'/g, "''")}'`
          })
          sqlContent += `INSERT INTO "${table.replace(/"/g, '""')}" (${columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${values.join(', ')});\n`
        }
        sqlContent += '\n'
      }
    }

    // 将 SQL 内容写入文件
    await writeFile(outputPath, sqlContent, 'utf-8')

    return {
      filePath: outputPath,
      warnings,
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

  // 运行命令 —— InfluxDB 使用 REST API 和 SQL
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { name, port } = container
    const database = options.database || container.database

    if (options.file) {
      const content = await readFile(options.file, 'utf-8')

      // 确保数据库存在（InfluxDB 在写入时隐式创建数据库，
      // 但如果数据库尚不存在，SQL 查询会失败）
      const createDbResp = await this.requestLocal(
        name,
        port,
        'POST',
        '/api/v3/configure/database',
        { db: database },
      )
      if (createDbResp.status >= 400) {
        throw new Error(
          `创建数据库 "${database}" 失败：HTTP ${createDbResp.status} — ${JSON.stringify(createDbResp.data)}`,
        )
      }

      // 行协议文件（.lp）→ 通过 /api/v3/write_lp 写入
      if (options.file.endsWith('.lp')) {
        const lines = content
          .split('\n')
          .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
          .join('\n')
        const response = await this.requestLocal(
          name,
          port,
          'POST',
          `/api/v3/write_lp?db=${encodeURIComponent(database)}`,
          lines,
        )
        if (response.status >= 400) {
          throw new Error(`写入错误：${JSON.stringify(response.data)}`)
        }
        return
      }

      // SQL 文件 → 通过 /api/v3/query_sql 执行
      const statements = content
        .split('\n')
        .filter((line) => !line.startsWith('--') && line.trim().length > 0)
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const sql of statements) {
        const response = await this.requestLocal(
          name,
          port,
          'POST',
          '/api/v3/query_sql',
          {
            db: database,
            q: sql,
            format: 'json',
          },
        )

        if (response.status >= 400) {
          throw new Error(
            `SQL 错误：${JSON.stringify(response.data)}\n语句：${sql}`,
          )
        }
      }
      return
    }

    if (options.sql) {
      // 对于内联 SQL 也确保数据库存在
      const createDbResp2 = await this.requestLocal(
        name,
        port,
        'POST',
        '/api/v3/configure/database',
        { db: database },
      )
      if (createDbResp2.status >= 400) {
        throw new Error(
          `创建数据库 "${database}" 失败：HTTP ${createDbResp2.status} — ${JSON.stringify(createDbResp2.data)}`,
        )
      }
      const response = await this.requestLocal(
        name,
        port,
        'POST',
        '/api/v3/query_sql',
        {
          db: database,
          q: options.sql,
          format: 'json',
        },
      )

      if (response.status >= 400) {
        throw new Error(`SQL 错误：${JSON.stringify(response.data)}`)
      }

      if (response.data) {
        console.log(JSON.stringify(response.data, null, 2))
      }
      return
    }

    throw new Error('必须提供 file 或 sql 参数')
  }

  /**
   * 通过 REST API 执行查询
   *
   * 查询格式：SQL 语句 或 METHOD /path [JSON 请求体]
   * 示例：
   *   SELECT * FROM cpu
   *   GET /health
   *   POST /api/v3/query_sql {"db": "mydb", "q": "SELECT 1"}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port } = container
    const database = options?.database || container.database
    const authToken =
      options?.password ||
      (await this.getStoredAuthToken(
        name,
        options?.username ?? getDefaultUsername(Engine.InfluxDB),
      ))
    const trimmed = query.trim()

    // 检查是否为 REST API 风格的查询（以 HTTP 方法开头）
    const httpMethods = ['GET', 'POST', 'PUT', 'DELETE']
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase()

    if (httpMethods.includes(firstWord)) {
      // 解析为 REST API 查询：METHOD /path [请求体]
      const spaceIdx = trimmed.indexOf(' ')
      const method = (options?.method || firstWord) as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'DELETE'
      const rest = trimmed.substring(spaceIdx + 1).trim()

      let path: string
      let body: Record<string, unknown> | undefined = options?.body

      const bodyStart = rest.indexOf('{')
      if (bodyStart !== -1) {
        path = rest.substring(0, bodyStart).trim()
        if (!body) {
          try {
            body = JSON.parse(rest.substring(bodyStart)) as Record<
              string,
              unknown
            >
          } catch {
            throw new Error('查询中的 JSON 请求体无效')
          }
        }
      } else {
        path = rest
      }

      if (!path.startsWith('/')) {
        path = '/' + path
      }

      const response = await influxdbApiRequest(
        port,
        method,
        path,
        body,
        30000,
        authToken,
      )

      if (response.status >= 400) {
        throw new Error(
          `InfluxDB API 错误（${response.status}）：${JSON.stringify(response.data)}`,
        )
      }

      return parseRESTAPIResult(JSON.stringify(response.data))
    }

    // 默认：作为 SQL 查询处理
    const response = await influxdbApiRequest(
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: trimmed,
        format: 'json',
      },
      30000,
      authToken,
    )

    if (response.status >= 400) {
      throw new Error(
        `InfluxDB SQL 错误（${response.status}）：${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * 列出 InfluxDB 的数据库
   * InfluxDB 3.x 使用 GET /api/v3/configure/database?format=json
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { name, port } = container
    const authToken = await this.getStoredAuthToken(name)

    try {
      const response = await influxdbApiRequest(
        port,
        'GET',
        '/api/v3/configure/database?format=json',
        undefined,
        30000,
        authToken,
      )

      if (response.status === 200 && response.data) {
        const data = response.data as Array<Record<string, unknown>>
        if (Array.isArray(data)) {
          const databases = data
            .map((row) => {
              return (
                (row['iox::database'] as string) ||
                (row.name as string) ||
                (Object.values(row)[0] as string)
              )
            })
            .filter(Boolean)
          return databases.length > 0 ? databases : [container.database]
        }
      }
      return [container.database]
    } catch (error) {
      logDebug(
        `列出容器 "${name}"（端口 ${port}）的 InfluxDB 数据库失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return [container.database]
    }
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { name, version } = container
    const { username } = options
    assertValidUsername(username)

    const existingToken = await readAdminToken(name)
    if (existingToken) {
      const credentials = buildInfluxTokenCredentials(
        container,
        username,
        existingToken.token,
      )
      await saveCredentials(name, Engine.InfluxDB, credentials)
      return credentials
    }

    const tokenPath = getAdminTokenPath(name)
    const influxdbServer = await this.getInfluxDBServerPath(version)

    await new Promise<void>((resolve, reject) => {
      const tokenDllEnv = getWindowsDllEnv(
        join(dirname(influxdbServer), 'python'),
      )
      const proc = spawn(
        influxdbServer,
        [
          'create',
          'token',
          '--admin',
          '--offline',
          '--output-file',
          tokenPath,
          '--name',
          username,
          '--format',
          'json',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...tokenDllEnv },
        },
      )

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              stderr || `influxdb3 create token 以退出码 ${code} 退出`,
            ),
          )
        }
      })
    })

    await chmod(tokenPath, 0o600)

    const storedToken = await readAdminToken(name)
    if (!storedToken) {
      throw new Error('加载已生成的 InfluxDB 管理员令牌失败')
    }

    const statusResult = await this.status(container)
    if (statusResult.running) {
      logWarning(
        `正在重启 InfluxDB 容器 "${name}" 以应用认证令牌配置。` +
          '活动的客户端连接将被断开。',
      )
      await this.stop(container)
      await this.start(container)
    }

    const credentials = buildInfluxTokenCredentials(
      container,
      username,
      storedToken.token,
    )
    await saveCredentials(name, Engine.InfluxDB, credentials)
    return credentials
  }
}

export const influxdbEngine = new InfluxDBEngine()
