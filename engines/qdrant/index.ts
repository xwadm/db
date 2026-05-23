import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { chmod, mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, relative } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
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
import { qdrantBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  QDRANT_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { qdrantApiRequest } from './api-client'
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

const ENGINE = 'qdrant'
const engineDef = getEngineDefaults(ENGINE)

/**
 * 获取存储快照参数路径
 * 在 Windows 上需要转换为相对路径以避免盘符中的冒号干扰 Qdrant 的 `--storage-snapshot` 参数解析
 */
function getStorageSnapshotArg(
  containerDir: string,
  snapshotPath: string,
): string {
  if (!isWindows()) {
    return snapshotPath
  }

  // Qdrant 使用 `:` 分隔符解析 `--storage-snapshot` 参数值。在 Windows 上，
  // 绝对路径包含盘符冒号，因此需要传递相对于当前工作目录的路径
  return relative(containerDir, snapshotPath).replace(/\\/g, '/')
}

/**
 * 生成 Qdrant 配置 YAML 内容
 */
function generateQdrantConfig(options: {
  port: number
  grpcPort: number
  dataDir: string
  snapshotsDir: string
  bindAddress?: string
}): string {
  // Qdrant 配置中即使在 Windows 上也使用正斜杠
  const normalizePathForQdrant = (p: string) => p.replace(/\\/g, '/')
  const bindAddress = options.bindAddress ?? '127.0.0.1'

  return `# SpinDB 生成的 Qdrant 配置
service:
  host: ${bindAddress}
  http_port: ${options.port}
  grpc_port: ${options.grpcPort}

storage:
  storage_path: ${normalizePathForQdrant(options.dataDir)}
  snapshots_path: ${normalizePathForQdrant(options.snapshotsDir)}

log_level: INFO
`
}

/**
 * 修补现有 Qdrant 配置，仅更新由 spindb 管理的值
 */
function patchQdrantConfig(
  existingConfig: string,
  options: { port: number; grpcPort: number; bindAddress?: string },
): string {
  let config = existingConfig
  config = config.replace(/^(\s*http_port:\s*)\d+/m, `$1${options.port}`)
  config = config.replace(/^(\s*grpc_port:\s*)\d+/m, `$1${options.grpcPort}`)
  if (options.bindAddress !== undefined) {
    config = config.replace(/^(\s*host:\s*).+/m, `$1${options.bindAddress}`)
  }
  return config
}

/**
 * 解析 Qdrant 连接字符串
 * 支持的格式:
 * - http://host:port
 * - https://host:port
 * - qdrant://host:port（转换为 http）
 * - http://host:port?api_key=KEY（用于 API 密钥认证）
 */
function parseQdrantConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL
  let scheme = 'http'

  // 处理 qdrant:// 协议，转换为 http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('qdrant://')) {
    normalized = normalized.replace('qdrant://', 'http://')
  }

  // 确保存在协议头
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `无效的 Qdrant 连接字符串: ${connectionString}\n` +
        '期望格式: http://host:port 或 qdrant://host:port',
    )
  }

  // 提取 API 密钥（如果提供）
  const apiKey = url.searchParams.get('api_key')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['api-key'] = apiKey
  }

  // 构建不含查询参数的基础 URL
  // Qdrant REST API 无论 http/https 都使用端口 6333
  const port = url.port || '6333'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * 向远程 Qdrant 服务器发起 HTTP 请求
 */
async function remoteQdrantRequest(
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

    // 尝试解析为 JSON，失败时降级为文本
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
        `远程 Qdrant 请求在 ${timeoutMs / 1000}s 后超时: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class QdrantEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Qdrant'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取用于二进制操作的平台信息
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退数据中获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载地址
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '1' -> '1.16.3'）
  resolveFullVersion(version: string): string {
    // 检查是否已经是完整版本（至少包含两个点）
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // 是主版本号，使用版本映射表解析
    return QDRANT_VERSION_MAP[version] || `${version}.0.0`
  }

  // 获取某版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'qdrant',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 Qdrant 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `qdrant${ext}`)
    return existsSync(serverPath)
  }

  // 检查特定 Qdrant 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return qdrantBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 Qdrant 二进制文件可用
   * 如果尚未安装则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await qdrantBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['qdrant'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 Qdrant 数据目录
   * 创建目录并生成 config.yaml
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
    const grpcPort = port + 1 // gRPC 端口通常为 HTTP 端口 + 1

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 Qdrant 数据目录: ${dataDir}`)
    }

    // 创建 snapshots 目录
    const snapshotsDir = join(dataDir, 'snapshots')
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
      logDebug(`已创建 Qdrant 快照目录: ${snapshotsDir}`)
    }

    // 生成 config.yaml
    const configPath = join(containerDir, 'config.yaml')
    const configContent = generateQdrantConfig({
      port,
      grpcPort,
      dataDir,
      snapshotsDir,
    })
    await writeFile(configPath, configContent)
    logDebug(`已生成 Qdrant 配置: ${configPath}`)

    return dataDir
  }

  // 获取某版本的 qdrant 服务端路径
  async getQdrantServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'qdrant',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `qdrant${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Qdrant ${version} 尚未安装。请运行: spindb engines download qdrant ${version}`,
    )
  }

  // 获取 qdrant 二进制文件路径
  async getQdrantPath(version?: string): Promise<string> {
    // 优先检查配置缓存
    const cached = await configManager.getBinaryPath('qdrant')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本号，使用已下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'qdrant',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const qdrantPath = join(binPath, 'bin', `qdrant${ext}`)
      if (existsSync(qdrantPath)) {
        return qdrantPath
      }
    }

    throw new Error(
      '未找到 qdrant。请运行: spindb engines download qdrant <版本号>',
    )
  }

  /**
   * 启动 Qdrant 服务器
   * CLI 封装: qdrant --config-path /path/to/config.yaml
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

    // 如果有存储的二进制路径（来自容器创建时），优先使用
    let qdrantServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `qdrant${ext}`)
      if (existsSync(serverPath)) {
        qdrantServer = serverPath
        logDebug(`使用存储的二进制路径: ${qdrantServer}`)
      }
    }

    // 如果上面没找到二进制文件，回退到常规路径
    if (!qdrantServer) {
      try {
        qdrantServer = await this.getQdrantServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Qdrant ${version} 尚未安装。请运行: spindb engines download qdrant ${version}\n` +
            `  原始错误: ${originalMessage}`,
        )
      }
    }

    logDebug(`使用 qdrant 版本 ${version}: ${qdrantServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'config.yaml')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const snapshotsDir = join(dataDir, 'snapshots')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')
    const pendingSnapshotMarker = join(containerDir, 'pending-storage-snapshot')
    const grpcPort = port + 1

    // 检查 gRPC 端口是否可用（Qdrant 使用 HTTP 端口 + 1 作为 gRPC 端口）
    // Windows 上需要等待更长时间以释放端口（TIME_WAIT 状态可能持续存在）
    // Windows 在进程终止后可能占用端口 30 秒以上
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    while (!(await portManager.isPortAvailable(grpcPort))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(
          `gRPC 端口 ${grpcPort} 已被占用。` +
            `Qdrant 需要 HTTP 端口 ${port} 和 gRPC 端口 ${grpcPort} 同时可用。`,
        )
      }
      logDebug(`等待 gRPC 端口 ${grpcPort} 变为可用...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Windows 上还需要检查 HTTP 端口
    if (isWindows()) {
      while (!(await portManager.isPortAvailable(port))) {
        if (Date.now() - portCheckStart >= portWaitTimeout) {
          throw new Error(
            `HTTP 端口 ${port} 已被占用。` +
              `Qdrant 需要 HTTP 端口 ${port} 和 gRPC 端口 ${grpcPort} 同时可用。`,
          )
        }
        logDebug(`等待 HTTP 端口 ${port} 变为可用...`)
        await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
      }
    }

    // 确保 snapshots 目录存在
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
    }

    // 更新配置 —— 重启时保留现有配置（如 API 密钥）
    const bindAddress = container.bindAddress ?? '127.0.0.1'
    if (existsSync(configPath)) {
      const existingConfig = await readFile(configPath, 'utf-8')
      const patchedConfig = patchQdrantConfig(existingConfig, {
        port,
        grpcPort,
        bindAddress,
      })
      await writeFile(configPath, patchedConfig)
    } else {
      const configContent = generateQdrantConfig({
        port,
        grpcPort,
        dataDir,
        snapshotsDir,
        bindAddress,
      })
      await writeFile(configPath, configContent)
    }

    onProgress?.({ stage: 'starting', message: '正在启动 Qdrant...' })

    logDebug(`使用配置启动 qdrant: ${configPath}`)

    /**
     * 检查日志文件中是否有启动错误
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
        // 日志文件可能尚未存在
      }
      return null
    }

    const args = ['--config-path', configPath]
    let snapshotApplied = false
    if (existsSync(pendingSnapshotMarker)) {
      try {
        const snapshotPath = (await readFile(pendingSnapshotMarker, 'utf-8')).trim()
        if (snapshotPath && existsSync(snapshotPath)) {
          args.push(
            '--storage-snapshot',
            getStorageSnapshotArg(containerDir, snapshotPath),
          )
          snapshotApplied = true
          logDebug(`使用存储快照启动 Qdrant: ${snapshotPath}`)
        }
      } catch (error) {
        logWarning(`读取待处理的 Qdrant 快照标记失败: ${error}`)
      }
    }

    // Qdrant 以前台模式运行，因此需要分离式（detached）启动
    // 设置 cwd 为容器目录，使 Qdrant 创建的任意文件都位于该目录

    // 非 Windows 上使用 'ignore' 作为 stdio，使 Node.js 进程可以正常退出
    //（管道流即使 unref 后仍会保持事件循环活跃）
    // Windows 上使用 'pipe' 捕获 stderr 以获得更好的错误信息
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        }

        const proc = spawn(qdrantServer, args, spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`启动 Qdrant 服务器失败: ${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
          reject(
            new Error(
              `Qdrant 进程意外退出 (${reason})。\n` +
                `Stderr: ${stderrOutput || '(无)'}\n` +
                `Stdout: ${stdoutOutput || '(无)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`qdrant stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`qdrant stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(new Error('Qdrant 服务器进程启动失败（无 PID）'))
            return
          }

          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // 非致命错误
          }

          const ready = await this.waitForReady(port)
          if (settled) return

          if (ready) {
            if (snapshotApplied && existsSync(pendingSnapshotMarker)) {
              await unlink(pendingSnapshotMarker).catch(() => {})
            }
            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true

            // 在拒绝前清理孤立的分离式进程
            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // 忽略清理错误 - 尽力而为
              }
            }

            const portError = await checkLogForError()

            const errorDetails = [
              portError || 'Qdrant 启动超时。',
              `二进制文件: ${qdrantServer}`,
              `配置: ${configPath}`,
              `日志文件: ${logFile}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, 500)
      })
    }

    // macOS/Linux: 使用 ignored stdio 启动，使 Node.js 可以干净退出
    const proc = spawn(qdrantServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('Qdrant 服务器进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    // 等待 Qdrant 就绪
    const ready = await this.waitForReady(port)

    if (ready) {
      if (snapshotApplied && existsSync(pendingSnapshotMarker)) {
        await unlink(pendingSnapshotMarker).catch(() => {})
      }
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'Qdrant 启动超时。',
      `二进制文件: ${qdrantServer}`,
      `配置: ${configPath}`,
      `日志文件: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // 等待 Qdrant 就绪并接受连接
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // 通过 REST API 进行健康检查
        const response = await qdrantApiRequest(port, 'GET', '/healthz')
        if (response.status === 200) {
          logDebug(`Qdrant 在端口 ${port} 上已就绪`)
          return true
        }
      } catch {
        // 连接失败，等待并重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Qdrant 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 Qdrant 服务器
   * 使用进程终止方式
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')
    const grpcPort = port + 1

    logDebug(`正在停止 Qdrant 容器 "${name}"，端口 ${port}`)

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

    // 如果进程在运行则终止
    // Windows 上立即强制终止（优雅关闭通常不会释放资源）
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 Qdrant 进程 ${pid}`)
      try {
        // Windows 上跳过优雅终止 —— 通常不会释放文件句柄
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
        logDebug(`进程终止错误: ${error}`)
      }
    }

    // 等待进程完全终止
    // Windows 需要更长时间以释放文件句柄
    // Linux/macOS 在 SIGKILL 后需要短暂等待再检查端口
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // 终止仍在监听端口的任何进程
    // 处理 PID 文件过时、存在子进程或主进程终止失败的情况
    const portPids = await platformService.findProcessByPort(port)
    const grpcPids = await platformService.findProcessByPort(grpcPort)
    const allPids = [...new Set([...portPids, ...grpcPids])]
    for (const portPid of allPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`正在终止仍在端口 ${port}/${grpcPort} 上的进程 ${portPid}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // 忽略
        }
      }
    }

    // Windows 上终止端口进程后再等待一段时间
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

    // Windows 上等待端口释放
    // Windows 在进程终止后占用端口的时间更长（TIME_WAIT 状态）
    // 某些情况下可能持续 30 秒以上
    if (isWindows()) {
      logDebug(`等待端口 ${port} 和 ${grpcPort} 释放...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000 // 最长 30 秒
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

    logDebug('Qdrant 已停止')
  }

  // 获取 Qdrant 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')

    // 通过 REST API 进行健康检查
    try {
      const response = await qdrantApiRequest(port, 'GET', '/healthz')
      if (response.status === 200) {
        return { running: true, message: 'Qdrant 正在运行' }
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
            message: `Qdrant 正在运行 (PID: ${pid})`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'Qdrant 未运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * 重要：恢复前必须停止 Qdrant
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // 检查容器是否正在运行 - 快照恢复前必须停止 Qdrant
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Qdrant 容器 "${name}" 必须在恢复前停止。` +
          `请运行: spindb stop ${name}`,
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
   * 格式: http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `http://127.0.0.1:${port}`
  }

  // 打开 HTTP API（Qdrant 使用 REST API，无交互式 Shell）
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}/dashboard`

    console.log(`Qdrant REST API 地址: http://127.0.0.1:${port}`)
    console.log(`Qdrant 仪表盘: ${url}`)
    console.log(`gRPC 端点: http://127.0.0.1:${port + 1}`)
    console.log('')
    console.log('示例命令:')
    console.log(`  curl http://127.0.0.1:${port}/collections`)
    console.log(`  curl http://127.0.0.1:${port}/healthz`)
  }

  /**
   * 创建新集合
   * Qdrant 使用集合代替传统数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // 使用默认向量配置创建集合
    // 用户需要根据实际用例配置合适的向量维度
    const response = await qdrantApiRequest(
      port,
      'PUT',
      `/collections/${encodeURIComponent(database)}`,
      {
        vectors: {
          size: 128, // 默认向量大小，用户应根据需求更新
          distance: 'Cosine',
        },
      },
    )

    if (response.status !== 200) {
      throw new Error(
        `创建集合失败: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已创建 Qdrant 集合: ${database}`)
  }

  /**
   * 删除集合
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await qdrantApiRequest(
      port,
      'DELETE',
      `/collections/${encodeURIComponent(database)}`,
    )

    if (response.status !== 200) {
      throw new Error(
        `删除集合失败: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已删除 Qdrant 集合: ${database}`)
  }

  /**
   * 获取 Qdrant 实例的存储大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      // 调用 API 验证连通性，但 Qdrant 不直接暴露存储大小
      await qdrantApiRequest(port, 'GET', '/telemetry')
      // Qdrant 在遥测数据中不暴露直接存储大小
      // 无法确定确切大小时返回 null
      return null
    } catch {
      return null
    }
  }

  /**
   * 从远程 Qdrant 连接导出数据
   * 使用 Qdrant REST API 创建并下载完整快照
   *
   * 连接字符串格式: http://host:port 或 qdrant://host:port
   * API 密钥认证: http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串
    const { baseUrl, headers } = parseQdrantConnectionString(connectionString)

    logDebug(`正在连接到远程 Qdrant: ${baseUrl}`)

    // 检查连通性并获取集合数量
    const collectionsResponse = await remoteQdrantRequest(
      baseUrl,
      'GET',
      '/collections',
      headers,
    )
    if (collectionsResponse.status !== 200) {
      throw new Error(
        `连接 Qdrant 失败 (${baseUrl}): ${JSON.stringify(collectionsResponse.data)}`,
      )
    }

    const collectionsData = collectionsResponse.data as {
      result?: { collections?: Array<{ name: string }> }
    }
    const collectionCount = collectionsData.result?.collections?.length ?? 0

    logDebug(`远程服务器上有 ${collectionCount} 个集合`)

    // 在远程服务器上创建完整快照
    logDebug('正在远程服务器上创建快照...')
    const snapshotResponse = await remoteQdrantRequest(
      baseUrl,
      'POST',
      '/snapshots',
      headers,
    )

    if (snapshotResponse.status !== 200) {
      throw new Error(
        `在远程 Qdrant 上创建快照失败: ${JSON.stringify(snapshotResponse.data)}`,
      )
    }

    const snapshotData = snapshotResponse.data as { result?: { name?: string } }
    const snapshotName = snapshotData.result?.name

    if (!snapshotName) {
      throw new Error(
        'Qdrant 快照创建失败: 未返回快照名称',
      )
    }

    logDebug(`远程快照已创建: ${snapshotName}`)

    // 下载快照（大快照超时时间为 5 分钟）
    const snapshotUrl = `${baseUrl}/snapshots/${snapshotName}`
    logDebug(`正在从 ${snapshotUrl} 下载快照...`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

    let downloadResponse: Response
    try {
      downloadResponse = await fetch(snapshotUrl, {
        headers,
        signal: controller.signal,
      })
    } catch (fetchError) {
      clearTimeout(timeoutId)
      // 清理已创建的快照
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      const err = fetchError as Error
      if (err.name === 'AbortError') {
        throw new Error('快照下载在 5 分钟后超时')
      }
      throw fetchError
    }

    if (!downloadResponse.ok) {
      clearTimeout(timeoutId)
      // 清理已创建的快照
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      throw new Error(
        `下载快照失败: ${downloadResponse.status} ${downloadResponse.statusText}`,
      )
    }

    // 流式写入输出路径，避免将文件缓冲到内存
    if (!downloadResponse.body) {
      clearTimeout(timeoutId)
      throw new Error('下载失败: 响应体为空')
    }

    const fileStream = createWriteStream(outputPath)
    try {
      const nodeStream = Readable.fromWeb(downloadResponse.body)
      await pipeline(nodeStream, fileStream)
      clearTimeout(timeoutId)
    } catch (streamError) {
      clearTimeout(timeoutId)
      fileStream.destroy()
      // 删除不完整的输出文件
      await unlink(outputPath).catch(() => {})
      // 清理远程服务器上的快照
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      throw streamError
    }

    logDebug(`快照已下载到 ${outputPath}`)

    // 清理远程服务器上的快照（礼貌性清理）
    await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
      (err) => {
        logDebug(`无法删除远程快照（非致命错误）: ${err}`)
      },
    )

    return {
      filePath: outputPath,
      warnings:
        collectionCount === 0
          ? ['远程 Qdrant 实例无集合']
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

  // 执行命令 - Qdrant 使用 REST API，而非命令文件
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Qdrant 不支持命令文件。请直接使用 REST API。\n' +
          `示例: curl -X POST http://127.0.0.1:${port}/collections`,
      )
    }

    if (options.sql) {
      // 尝试解释为简单命令（如 "LIST COLLECTIONS"）
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST COLLECTIONS' || command === 'SHOW COLLECTIONS') {
        const response = await qdrantApiRequest(port, 'GET', '/collections')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Qdrant 使用 REST API 进行操作。请使用 curl 或 Qdrant 客户端库。\n' +
          `API 端点: http://127.0.0.1:${port}`,
      )
    }

    throw new Error('必须提供 file 或 sql 选项之一')
  }

  /**
   * 通过 REST API 执行查询
   *
   * 查询格式: METHOD /path [JSON body]
   * 示例:
   *   GET /collections
   *   POST /collections/my_collection/points/search {"vector": [0.1, 0.2], "limit": 10}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container

    // 解析查询字符串: METHOD /path [body]
    const trimmed = query.trim()
    const spaceIdx = trimmed.indexOf(' ')

    if (spaceIdx === -1) {
      throw new Error(
        '无效的查询格式。期望格式: METHOD /path [body]\n' +
          '示例: GET /collections',
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
      // 始终提取不含 JSON 块的路径
      path = rest.substring(0, bodyStart).trim()
      if (options?.body) {
        // 同时提供了内联 JSON 和 options.body - 报错
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

    const response = await qdrantApiRequest(
      port,
      method,
      path,
      body,
      30000,
      options?.password,
    )

    if (response.status >= 400) {
      throw new Error(
        `Qdrant API 错误 (${response.status}): ${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * 列出 Qdrant 的数据库。
   * Qdrant 使用集合而非数据库。返回已配置的数据库。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // Qdrant 使用集合而非数据库
    // 返回容器已配置的 database
    return [container.database]
  }

  /**
   * 创建/更新 Qdrant 的全局 API 密钥。
   *
   * Qdrant 仅支持单个全局 API 密钥（在 config.yaml 中设置）。
   * 多次调用 createUser 会覆盖之前的密钥。
   * 调用者提供的 username 会存储在凭据文件中用于记录，
   * 但对 Qdrant 本身无效 —— 认证仅通过 api-key 头部进行。
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, name } = container

    // Qdrant 在 config.yaml 中使用单个全局 API 密钥。
    // 读取当前配置，设置/替换 api_key，写回并重启。
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'config.yaml')

    const currentConfig = await readFile(configPath, 'utf-8')

    // 逐行解析 YAML 配置以找到 service 段和 api_key。
    // 假设 2 空格缩进，api_key 行无内联注释，值为简单标量。
    // 这是轻量级字符串编辑方案；如需支持更复杂情况应使用 YAML 解析器。
    const lines = currentConfig.split('\n')
    const serviceIdx = lines.findIndex((l) => /^service:/.test(l))

    if (serviceIdx < 0) {
      throw new Error('在 Qdrant 配置中未找到 service 段')
    }

    // 扫描 service 段，查找已有的 api_key 和最后一个属性行
    let apiKeyIdx = -1
    let lastServicePropIdx = serviceIdx
    for (let i = serviceIdx + 1; i < lines.length; i++) {
      if (/^\s+\S/.test(lines[i])) {
        lastServicePropIdx = i
        if (/^\s+api_key:/.test(lines[i])) {
          apiKeyIdx = i
        }
      } else if (/^\S/.test(lines[i]) && lines[i].trim() !== '') {
        break // 下一个顶级段
      }
    }

    const yamlSafePassword = JSON.stringify(password)
    if (apiKeyIdx >= 0) {
      lines[apiKeyIdx] = `  api_key: ${yamlSafePassword}`
    } else {
      lines.splice(lastServicePropIdx + 1, 0, `  api_key: ${yamlSafePassword}`)
    }

    const updatedConfig = lines.join('\n')

    // 在写入前验证修改后的配置结构是否健全
    // 检查 service 段和 api_key 行是否存在
    const updatedLines = updatedConfig.split('\n')
    const hasService = updatedLines.some((l) => /^service:/.test(l))
    const hasApiKey = updatedLines.some((l) => /^\s+api_key:/.test(l))
    if (!hasService || !hasApiKey) {
      throw new Error(
        '更新 Qdrant 配置失败: 修改后的 YAML 结构无效。' +
          'service 段或 api_key 条目在修改后缺失。',
      )
    }

    // 仅在容器当前运行时才重启
    const statusResult = await this.status(container)
    if (statusResult.running) {
      logWarning(
        `正在重启 Qdrant 容器 "${name}" 以应用 API 密钥更改。` +
          '活动客户端连接将被断开。',
      )
      await this.stop(container)
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
      await this.start(container)
    } else {
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
    }

    logDebug(`已配置 Qdrant 全局 API 密钥（凭据标签: ${username}）`)

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

export const qdrantEngine = new QdrantEngine()