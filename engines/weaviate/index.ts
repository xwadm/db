import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { chmod, mkdir, writeFile, readFile, unlink, rm } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { weaviateBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  WEAVIATE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { weaviateApiRequest } from './api-client'
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
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'weaviate'
const engineDef = getEngineDefaults(ENGINE)

/**
 * 解析 Weaviate 连接字符串
 * 支持的格式：
 * - http://host:port
 * - https://host:port
 * - http://host:port?api_key=KEY（用于 API Key 认证）
 */
function parseWeaviateConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL

  // 确保存在 scheme
  let normalized = connectionString.trim()
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
  } catch {
    // 在包含到错误信息之前，先脱敏查询参数（可能包含 api_key）
    const safeString = normalized.split('?')[0]
    throw new Error(
      `无效的 Weaviate 连接字符串：${safeString}\n` +
        '期望格式：http://host:port',
    )
  }

  // 提取 API Key（如果提供）
  const apiKey = url.searchParams.get('api_key')
  const scheme = url.protocol.replace(':', '')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // 构建不含查询参数的基础 URL
  const port = url.port || '8080'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * 向远程 Weaviate 服务器发送 HTTP 请求
 */
async function remoteWeaviateRequest(
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

    // 尝试解析为 JSON，回退为纯文本
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
        `远程 Weaviate 请求超时（${timeoutMs / 1000} 秒）：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class WeaviateEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Weaviate'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取用于二进制操作的平台信息
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

  // 将版本字符串解析为完整版本（例如 '1' → '1.35.7'）
  resolveFullVersion(version: string): string {
    // 检查是否已是完整版本（至少两个点号）
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // 是主版本号，使用版本映射表解析
    return WEAVIATE_VERSION_MAP[version] || `${version}.0.0`
  }

  // 获取某版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'weaviate',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 Weaviate 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `weaviate${ext}`)
    return existsSync(serverPath)
  }

  // 检查特定 Weaviate 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return weaviateBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 Weaviate 二进制文件可用
   * 如果尚未安装，则从 hostdb 下载
   * 返回 bin 目录路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await weaviateBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['weaviate'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 Weaviate 数据目录
   * 创建目录结构
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

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 Weaviate 数据目录：${dataDir}`)
    }

    // 创建备份目录
    const backupsDir = join(dataDir, 'backups')
    if (!existsSync(backupsDir)) {
      await mkdir(backupsDir, { recursive: true })
      logDebug(`已创建 Weaviate 备份目录：${backupsDir}`)
    }

    // 写入包含端口信息的配置文件供参考
    const configPath = join(containerDir, 'weaviate.env')
    const configContent = [
      '# SpinDB 生成的 Weaviate 配置',
      `PERSISTENCE_DATA_PATH=${dataDir}`,
      `BACKUP_FILESYSTEM_PATH=${backupsDir}`,
      `QUERY_DEFAULTS_LIMIT=25`,
      `AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true`,
      `DEFAULT_VECTORIZER_MODULE=none`,
      `CLUSTER_HOSTNAME=node1`,
      '',
    ].join('\n')
    await writeFile(configPath, configContent)
    logDebug(`已生成 Weaviate 配置：${configPath}（端口：${port}）`)

    return dataDir
  }

  // 获取特定版本的 weaviate 服务端路径
  async getWeaviateServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'weaviate',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `weaviate${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Weaviate ${version} 未安装。请运行：spindb engines download weaviate ${version}`,
    )
  }

  // 获取 weaviate 二进制文件路径
  async getWeaviatePath(version?: string): Promise<string> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('weaviate')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，使用已下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'weaviate',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const weaviatePath = join(binPath, 'bin', `weaviate${ext}`)
      if (existsSync(weaviatePath)) {
        return weaviatePath
      }
    }

    throw new Error(
      '未找到 weaviate。请运行：spindb engines download weaviate <version>',
    )
  }

  /**
   * 启动 Weaviate 服务端
   * Weaviate 使用环境变量进行配置
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

    // 如果可用，使用存储的二进制路径（来自容器创建）
    let weaviateServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `weaviate${ext}`)
      if (existsSync(serverPath)) {
        weaviateServer = serverPath
        logDebug(`使用存储的二进制路径：${weaviateServer}`)
      }
    }

    // 如果上述步骤未找到二进制文件，回退到常规路径
    if (!weaviateServer) {
      try {
        weaviateServer = await this.getWeaviateServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Weaviate ${version} 未安装。请运行：spindb engines download weaviate ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    logDebug(`正在为版本 ${version} 使用 weaviate：${weaviateServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const backupsDir = join(dataDir, 'backups')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')
    const grpcPort = port + 1

    // 检查 gRPC 端口是否可用（Weaviate 使用 HTTP 端口 + 1 作为 gRPC 端口）
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckInterval = 1000

    const grpcCheckStart = Date.now()
    while (!(await portManager.isPortAvailable(grpcPort))) {
      if (Date.now() - grpcCheckStart >= portWaitTimeout) {
        throw new Error(
          `gRPC 端口 ${grpcPort} 已被占用。` +
            `Weaviate 需要 HTTP 端口 ${port} 和 gRPC 端口 ${grpcPort} 同时可用。`,
        )
      }
      logDebug(`等待 gRPC 端口 ${grpcPort} 变为可用...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Windows 上还需检查 HTTP 端口
    if (isWindows()) {
      const httpCheckStart = Date.now()
      while (!(await portManager.isPortAvailable(port))) {
        if (Date.now() - httpCheckStart >= portWaitTimeout) {
          throw new Error(
            `HTTP 端口 ${port} 已被占用。` +
              `Weaviate 需要 HTTP 端口 ${port} 和 gRPC 端口 ${grpcPort} 同时可用。`,
          )
        }
        logDebug(`等待 HTTP 端口 ${port} 变为可用...`)
        await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
      }
    }

    // 确保备份目录存在
    if (!existsSync(backupsDir)) {
      await mkdir(backupsDir, { recursive: true })
    }

    onProgress?.({ stage: 'starting', message: '正在启动 Weaviate...' })

    logDebug(`正在端口 ${port} 上启动 weaviate`)

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

    // 如果自上次启动以来集群身份发生变化，清理 RAFT 状态。
    // RAFT 会持久化集群广播地址和节点名称；过时的状态
    // 会导致 Weaviate 在重启时挂起，尝试重新加入旧节点。
    // 同时追踪绑定地址和端口，因为 RAFT 端口派生于 HTTP 端口。
    const bindFile = join(containerDir, '.last-cluster-identity')
    const currentBind = container.bindAddress ?? '127.0.0.1'
    const currentIdentity = `${currentBind}:${port}`
    try {
      const lastIdentity = existsSync(bindFile)
        ? (await readFile(bindFile, 'utf-8')).trim()
        : null
      if (lastIdentity && lastIdentity !== currentIdentity) {
        const raftDir = join(dataDir, 'raft')
        if (existsSync(raftDir)) {
          logDebug(
            `集群身份已变更（${lastIdentity} → ${currentIdentity}），正在清除 RAFT 状态`,
          )
          await rm(raftDir, { recursive: true, force: true })
        }
      }
      await writeFile(bindFile, currentIdentity)
    } catch (error) {
      logDebug(`RAFT 身份检查失败：${error}`)
    }

    // Weaviate 使用环境变量进行配置
    const args = [
      '--host',
      currentBind,
      '--port',
      String(port),
      '--scheme',
      'http',
    ]

    // 从 HTTP 端口推导出唯一的内部集群端口，以避免
    // 同时运行多个 Weaviate 容器时的端口冲突。
    // 默认内部端口（7946、7947、8300、8301）是固定的，会产生冲突。
    const gossipPort = port + 100 // 例如 8080 → 8180
    const dataPort = port + 101 // 例如 8080 → 8181
    const raftPort = port + 200 // 例如 8080 → 8280
    const raftInternalRpcPort = raftPort + 1 // 例如 8080 → 8281

    // 读取 weaviate.env 文件（由 initDataDir 写入，由 createUser 更新），
    // 使 API Key / 认证设置在重启后持久化
    const envFilePath = join(containerDir, 'weaviate.env')
    const fileEnv: Record<string, string> = {}
    if (existsSync(envFilePath)) {
      try {
        const envContent = await readFile(envFilePath, 'utf-8')
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx > 0) {
            fileEnv[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1)
          }
        }
      } catch {
        logDebug(`无法读取 ${envFilePath}，将使用默认值`)
      }
    }

    // 节点身份在所有启动和恢复操作中必须保持一致。
    // 使用基于端口的命名以确保多个容器运行时的唯一性。
    const nodeHostname = `node-${port}`

    // Weaviate 的 RAFT 层拒绝通配符绑定地址（0.0.0.0、::）
    // 作为集群广播地址 — 会出现"本地绑定地址不可广播"错误，
    // 进程在 raft 初始化期间致命退出。对于单节点操作，
    // 集群本身即为进程内，因此当 REST API 使用通配符地址时，
    // 我们在回环地址上广播。可路由的显式绑定地址直接穿透。
    const isWildcardBind = ['0.0.0.0', '::', ''].includes(currentBind)
    const clusterAdvertiseAddr = isWildcardBind ? '127.0.0.1' : currentBind

    const env = {
      ...process.env,
      // 来自 weaviate.env 文件的默认值（包含来自 createUser 的认证设置）
      ...fileEnv,
      // 显式的 spawn 值始终覆盖文件中的值
      PERSISTENCE_DATA_PATH: dataDir,
      BACKUP_FILESYSTEM_PATH: backupsDir,
      ENABLE_MODULES: 'backup-filesystem',
      CLUSTER_HOSTNAME: nodeHostname,
      CLUSTER_ADVERTISE_ADDR: clusterAdvertiseAddr,
      CLUSTER_JOIN: '',
      RAFT_JOIN: nodeHostname,
      RAFT_BOOTSTRAP_EXPECT: '1',
      GRPC_PORT: String(grpcPort),
      CLUSTER_GOSSIP_BIND_PORT: String(gossipPort),
      CLUSTER_DATA_BIND_PORT: String(dataPort),
      RAFT_PORT: String(raftPort),
      RAFT_INTERNAL_RPC_PORT: String(raftInternalRpcPort),
    }

    // 通过文件描述符将 stdout/stderr 重定向到日志文件，
    // 使 checkLogForError 能够发现启动错误。文件描述符
    // 由子进程继承，不会像 'pipe' 那样保持 Node.js 事件循环活跃，
    // 因此 proc.unref() 能正常工作。
    const logFd = openSync(logFile, 'a')

    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      env,
    }

    if (isWindows()) {
      spawnOpts.windowsHide = true
    }

    const proc = spawn(weaviateServer, args, spawnOpts)
    proc.unref()

    // 在父进程中关闭 fd — 子进程已继承自己的副本
    closeSync(logFd)

    if (!proc.pid) {
      throw new Error('Weaviate 服务端进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    // 等待 Weaviate 就绪
    const ready = await this.waitForReady(port)

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 在抛出异常前清理孤立的后台进程
    if (platformService.isProcessRunning(proc.pid)) {
      try {
        await platformService.terminateProcess(proc.pid, true)
      } catch {
        // 忽略清理错误 — 尽力而为
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'Weaviate 在超时时间内未能启动。',
      `二进制文件：${weaviateServer}`,
      `日志文件：${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // 等待 Weaviate 就绪以接受连接
  private async waitForReady(
    port: number,
    timeoutMs = 120000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // 使用 Weaviate 的就绪端点
        const response = await weaviateApiRequest(
          port,
          'GET',
          '/v1/.well-known/ready',
        )
        if (response.status === 200) {
          logDebug(`Weaviate 在端口 ${port} 上已就绪`)
          return true
        }
      } catch {
        // 连接失败，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Weaviate 在 ${timeoutMs}ms 内未变为就绪状态`)
    return false
  }

  /**
   * 停止 Weaviate 服务端
   * 使用进程终止方式
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')
    const grpcPort = port + 1

    logDebug(`正在停止 Weaviate 容器 "${name}"，端口 ${port}`)

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
      logDebug(`正在终止 Weaviate 进程 ${pid}`)
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
        logDebug(`进程终止出错：${error}`)
      }
    }

    // 等待进程完全终止
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // 终止仍在端口上监听的任何进程
    const portPids = await platformService.findProcessByPort(port)
    const grpcPids = await platformService.findProcessByPort(grpcPort)
    const allPids = [...new Set([...portPids, ...grpcPids])]
    for (const portPid of allPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`正在终止仍占用端口 ${port}/${grpcPort} 的进程 ${portPid}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // 忽略
        }
      }
    }

    // 在 Windows 上，终止端口进程后再次等待
    if (isWindows() && allPids.length > 0) {
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

    // 在 Windows 上，等待端口被释放
    if (isWindows()) {
      logDebug(`等待端口 ${port} 和 ${grpcPort} 被释放...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        const httpAvailable = await portManager.isPortAvailable(port)
        const grpcAvailable = await portManager.isPortAvailable(grpcPort)

        if (httpAvailable && grpcAvailable) {
          logDebug('端口已成功释放')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('Weaviate 已停止')
  }

  // 获取 Weaviate 服务端状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')

    // 尝试通过 REST API 进行健康检查
    try {
      const response = await weaviateApiRequest(
        port,
        'GET',
        '/v1/.well-known/ready',
      )
      if (response.status === 200) {
        return { running: true, message: 'Weaviate 正在运行' }
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
            message: `Weaviate 正在运行（PID：${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'Weaviate 未在运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * 重要：恢复前必须停止 Weaviate
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // 检查容器是否在运行 — 快照恢复前必须停止 Weaviate
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Weaviate 容器 "${name}" 必须在恢复前停止。` +
          `请运行：spindb stop ${name}`,
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    return restoreBackup(backupPath, {
      containerName: name,
      dataDir,
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

  // 打开 HTTP API（Weaviate 使用 REST/GraphQL API，无交互式 shell）
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`Weaviate REST API 地址：${url}/v1`)
    console.log(`Weaviate GraphQL 端点：${url}/v1/graphql`)
    console.log(`gRPC 端点：127.0.0.1:${port + 1}`)
    console.log('')
    console.log('示例命令：')
    console.log(`  curl ${url}/v1/schema`)
    console.log(`  curl ${url}/v1/.well-known/ready`)
  }

  /**
   * 创建新类（集合）
   * Weaviate 使用类（classes）而非传统数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // 使用默认向量配置创建类
    const response = await weaviateApiRequest(port, 'POST', '/v1/schema', {
      class: database,
      vectorizer: 'none',
    })

    if (response.status !== 200) {
      throw new Error(
        `创建类失败：${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已创建 Weaviate 类：${database}`)
  }

  /**
   * 删除类
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await weaviateApiRequest(
      port,
      'DELETE',
      `/v1/schema/${encodeURIComponent(database)}`,
    )

    if (response.status !== 200) {
      throw new Error(
        `删除类失败：${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已删除 Weaviate 类：${database}`)
  }

  /**
   * 获取 Weaviate 实例的存储大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      await weaviateApiRequest(port, 'GET', '/v1/meta')
      // Weaviate 在 meta 中不直接暴露存储大小
      return null
    } catch {
      return null
    }
  }

  /**
   * 从远程 Weaviate 连接导出数据
   * 使用 Weaviate REST API 创建并下载完整备份
   *
   * 连接字符串格式：http://host:port
   * 使用 API Key 认证：http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串
    const { baseUrl, headers } = parseWeaviateConnectionString(connectionString)

    logDebug(`正在连接到远程 Weaviate：${baseUrl}`)

    // 检查连通性并获取 schema
    const schemaResponse = await remoteWeaviateRequest(
      baseUrl,
      'GET',
      '/v1/schema',
      headers,
    )
    if (schemaResponse.status !== 200) {
      throw new Error(
        `无法连接到 Weaviate（${baseUrl}）：${JSON.stringify(schemaResponse.data)}`,
      )
    }

    const schemaData = schemaResponse.data as {
      classes?: Array<{ class: string }>
    }
    const classCount = schemaData.classes?.length ?? 0

    logDebug(`在远程服务器上找到 ${classCount} 个类`)

    // Weaviate 的文件系统备份后端将数据写入服务器本地磁盘
    // （BACKUP_FILESYSTEM_PATH/<backup_id>/）。这些文件无法通过
    // REST API 下载 — 只有备份元数据可通过 GET 获取。
    // 要从远程 Weaviate 实例导出数据，请使用支持远程访问的
    // 对象存储备份后端（s3、gcs、azure）。
    throw new Error(
      `无法从远程 Weaviate 实例使用文件系统备份后端导出数据。\n` +
        `Weaviate 文件系统备份写入服务器本地磁盘 ` +
        `（BACKUP_FILESYSTEM_PATH/<backup_id>/），无法通过 HTTP 下载。\n\n` +
        `要从远程 Weaviate 实例导出数据，请选择以下方式之一：\n` +
        `  1. SSH 登录服务器并直接复制备份目录\n` +
        `  2. 在远程服务器上配置对象存储备份后端（S3、GCS、Azure）\n` +
        `     并使用相应的备份模块端点代替 /v1/backups/filesystem\n` +
        `  3. 使用 Weaviate 客户端 SDK 以编程方式读取并重新插入对象\n\n` +
        `远程服务器 ${baseUrl} 有 ${classCount} 个类。`,
    )
  }

  // 创建备份
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // 运行命令 — Weaviate 使用 REST/GraphQL API，而非命令文件
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Weaviate 不支持命令文件。请直接使用 REST API。\n' +
          `示例：curl -X GET http://127.0.0.1:${port}/v1/schema`,
      )
    }

    if (options.sql) {
      // 尝试解释为简单命令
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST CLASSES' || command === 'SHOW CLASSES') {
        const response = await weaviateApiRequest(port, 'GET', '/v1/schema')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Weaviate 使用 REST/GraphQL API 进行操作。请使用 curl 或 Weaviate 客户端库。\n' +
          `API 端点：http://127.0.0.1:${port}/v1`,
      )
    }

    throw new Error('必须提供 file 或 sql 选项之一')
  }

  /**
   * 通过 REST API 执行查询
   *
   * 查询格式：METHOD /path [JSON body]
   * 示例：
   *   GET /v1/schema
   *   POST /v1/graphql {"query": "{ Get { MyClass { name } } }"}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container

    // 解析查询字符串：METHOD /path [body]
    const trimmed = query.trim()
    const spaceIdx = trimmed.indexOf(' ')

    if (spaceIdx === -1) {
      throw new Error(
        '无效的查询格式。期望格式：METHOD /path [body]\n' +
          '示例：GET /v1/schema',
      )
    }

    const method = (options?.method ||
      trimmed.substring(0, spaceIdx).toUpperCase()) as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE'
    const rest = trimmed.substring(spaceIdx + 1).trim()

    // 提取路径和可选的 JSON 请求体
    let path: string
    let body: Record<string, unknown> | undefined = options?.body

    const bodyStart = rest.indexOf('{')
    if (bodyStart !== -1) {
      // 始终提取不含 JSON 块的部分作为路径
      path = rest.substring(0, bodyStart).trim()
      if (options?.body) {
        throw new Error(
          '不能在查询中同时指定内联 JSON 请求体和 options.body。请二选一。',
        )
      }
      try {
        body = JSON.parse(rest.substring(bodyStart)) as Record<string, unknown>
      } catch {
        throw new Error('查询中的 JSON 请求体无效')
      }
    } else {
      path = rest
    }

    // 确保路径以 / 开头
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    const response = await weaviateApiRequest(
      port,
      method,
      path,
      body,
      30000,
      options?.password,
    )

    if (response.status >= 400) {
      throw new Error(
        `Weaviate API 错误（${response.status}）：${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * 列出 Weaviate 的数据库。
   * Weaviate 使用类而非数据库。返回已配置的数据库。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    return [container.database]
  }

  /**
   * 创建/更新 Weaviate 的 API Key。
   *
   * Weaviate 通过环境变量支持 API Key 认证。
   * 调用 createUser 将更新配置并需要重启。
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, name } = container

    // 读取当前环境配置并添加/更新 API Key
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'weaviate.env')

    if (!existsSync(configPath)) {
      throw new Error(
        `Weaviate 配置文件未找到：${configPath}\n` +
          `此文件在容器设置期间创建。` +
          `请尝试重新创建容器：spindb delete ${name} && spindb create ${name}`,
      )
    }
    const currentConfig = await readFile(configPath, 'utf-8')

    // 更新或添加认证设置
    const lines = currentConfig.split('\n')
    let foundAnonAccess = false
    let foundApiKeyEnabled = false
    let foundApiKeyAllowed = false
    let foundApiKeyUsers = false

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=')) {
        lines[i] = 'AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false'
        foundAnonAccess = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_ENABLED=')) {
        lines[i] = 'AUTHENTICATION_APIKEY_ENABLED=true'
        foundApiKeyEnabled = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_ALLOWED_KEYS=')) {
        lines[i] = `AUTHENTICATION_APIKEY_ALLOWED_KEYS=${password}`
        foundApiKeyAllowed = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_USERS=')) {
        lines[i] = `AUTHENTICATION_APIKEY_USERS=${username}`
        foundApiKeyUsers = true
      }
    }

    if (!foundAnonAccess) {
      lines.push('AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false')
    }
    if (!foundApiKeyEnabled) {
      lines.push('AUTHENTICATION_APIKEY_ENABLED=true')
    }
    if (!foundApiKeyAllowed) {
      lines.push(`AUTHENTICATION_APIKEY_ALLOWED_KEYS=${password}`)
    }
    if (!foundApiKeyUsers) {
      lines.push(`AUTHENTICATION_APIKEY_USERS=${username}`)
    }

    const updatedConfig = lines.join('\n')

    // 仅在容器当前已运行时重启
    const statusResult = await this.status(container)
    if (statusResult.running) {
      logWarning(
        `正在重启 Weaviate 容器 "${name}" 以应用 API Key 变更。` +
          '活跃的客户端连接将被断开。',
      )
      await this.stop(container)
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
      await this.start(container)
    } else {
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
    }

    logDebug(`已配置 Weaviate API Key（凭据标签：${username}）`)

    const connectionString = `http://127.0.0.1:${port}`

    return {
      username,
      password: '',
      connectionString,
      engine: container.engine,
      container: container.name,
      apiKey: password,
    }
  }
}

export const weaviateEngine = new WeaviateEngine()