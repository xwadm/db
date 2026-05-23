import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { chmod, mkdir, writeFile, readFile, unlink } from 'fs/promises'
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
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { meilisearchBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { meilisearchApiRequest } from './api-client'
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

const ENGINE = 'meilisearch'
const engineDef = getEngineDefaults(ENGINE)
const MASTER_KEY_FILE = 'master.key'

/**
 * 启动后检查 Meilisearch 是否就绪的初始延迟。
 * Windows 需要更长的延迟，因为进程启动较慢。
 */
const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500

/**
 * 解析 Meilisearch 连接字符串
 * 支持的格式:
 * - http://host:port
 * - https://host:port
 * - meilisearch://host:port（转换为 http）
 * - http://host:port?api_key=KEY（用于 API Key 认证）
 */
function parseMeilisearchConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL
  let scheme = 'http'

  // 将 meilisearch:// 协议转换为 http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('meilisearch://')) {
    normalized = normalized.replace('meilisearch://', 'http://')
  }

  // 确保存在协议前缀
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `无效的 Meilisearch 连接字符串: ${connectionString}\n` +
        '期望格式: http://host:port 或 meilisearch://host:port',
    )
  }

  // 提取 API Key（如有提供）
  const apiKey = url.searchParams.get('api_key')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // 构建不含查询参数的基础 URL
  const port = url.port || '7700'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * 向远程 Meilisearch 服务器发送 HTTP 请求
 */
async function remoteMeilisearchRequest(
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

    // 尝试解析为 JSON，失败则退回纯文本
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
        `远程 Meilisearch 请求超时（超过 ${timeoutMs / 1000}s）: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function getMasterKeyPath(containerName: string): string {
  const containerDir = paths.getContainerPath(containerName, { engine: ENGINE })
  return join(containerDir, MASTER_KEY_FILE)
}

async function readMasterKey(containerName: string): Promise<string | null> {
  const masterKeyPath = getMasterKeyPath(containerName)
  if (!existsSync(masterKeyPath)) {
    return null
  }

  const masterKey = (await readFile(masterKeyPath, 'utf-8')).trim()
  return masterKey || null
}

export class MeilisearchEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Meilisearch'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息以进行二进制操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退数据中获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载链接
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本号（如 '1' -> '1.33.1'）
  resolveFullVersion(version: string): string {
    // 使用 normalizeVersion，它可处理所有情况:
    // - 映射已知版本（1 -> 1.33.1、1.33 -> 1.33.1）
    // - 保持完整版本不变（1.33.1 -> 1.33.1）
    // - 对未知版本原样返回并发出警告（避免无效的 4 段式版本号）
    return normalizeVersion(version)
  }

  // 获取某版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'meilisearch',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 Meilisearch 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `meilisearch${ext}`)
    return existsSync(serverPath)
  }

  // 检查特定 Meilisearch 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return meilisearchBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 Meilisearch 二进制文件可用
   * 如果尚未安装，则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await meilisearchBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['meilisearch'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 Meilisearch 数据目录
   * 创建目录结构
   *
   * 重要: snapshots 目录必须是 data 目录的平级目录，而不是其子目录。
   * 若 --snapshot-dir 指向 --db-path 内部，Meilisearch 会启动失败。
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

    // 如果不存在则创建容器目录
    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    // 如果不存在则创建数据目录
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 Meilisearch 数据目录: ${dataDir}`)
    }

    // 将 snapshots 目录创建为 data 的平级目录（而非子目录！）
    // 若 --snapshot-dir 位于 --db-path 内部，
    // Meilisearch 将失败并提示 "failed to infer the version of the database"
    const snapshotsDir = join(containerDir, 'snapshots')
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
      logDebug(`已创建 Meilisearch snapshots 目录: ${snapshotsDir}`)
    }

    return dataDir
  }

  // 获取指定版本的 meilisearch 服务器路径
  async getMeilisearchServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'meilisearch',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `meilisearch${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Meilisearch ${version} 未安装。请运行: spindb engines download meilisearch ${version}`,
    )
  }

  // 获取 meilisearch 二进制文件路径
  async getMeilisearchPath(version?: string): Promise<string> {
    // 先检查配置缓存
    const cached = await configManager.getBinaryPath('meilisearch')
    if (cached && existsSync(cached)) {
      return cached
    }

    // 如果提供了版本，则使用已下载的二进制文件
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'meilisearch',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const meilisearchPath = join(binPath, 'bin', `meilisearch${ext}`)
      if (existsSync(meilisearchPath)) {
        return meilisearchPath
      }
    }

    throw new Error(
      '未找到 meilisearch。请运行: spindb engines download meilisearch <version>',
    )
  }

  /**
   * 启动 Meilisearch 服务器
   * CLI 命令: meilisearch --db-path /path/to/data --http-addr 127.0.0.1:PORT --env development
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

    // 如果可用，使用存储的二进制文件路径（来自容器创建时）
    let meilisearchServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `meilisearch${ext}`)
      if (existsSync(serverPath)) {
        meilisearchServer = serverPath
        logDebug(`使用存储的二进制路径: ${meilisearchServer}`)
      }
    }

    // 如果上述步骤未找到二进制文件，回退到常规路径
    if (!meilisearchServer) {
      try {
        meilisearchServer = await this.getMeilisearchServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Meilisearch ${version} 未安装。请运行: spindb engines download meilisearch ${version}\n` +
            `  原始错误: ${originalMessage}`,
        )
      }
    }

    logDebug(`对版本 ${version} 使用 meilisearch: ${meilisearchServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    // 重要: snapshots 必须是 data 的平级目录，而非其子目录
    // 若 --snapshot-dir 位于 --db-path 内部，Meilisearch 将失败并提示 "failed to infer database version"
    const snapshotsDir = join(containerDir, 'snapshots')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    // 在 Windows 上，等待端口释放的时间更长（TIME_WAIT 状态可能持续存在）
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    // 检查 HTTP 端口是否可用
    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`HTTP 端口 ${port} 已被占用。`)
      }
      logDebug(`等待 HTTP 端口 ${port} 变为可用...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // 确保 snapshots 目录存在
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
    }

    // 检查是否有待导入的快照（由 restore 操作创建）
    const importMarkerPath = join(containerDir, 'pending-snapshot-import')
    let pendingSnapshotImport: string | null = null
    if (existsSync(importMarkerPath)) {
      try {
        pendingSnapshotImport = (
          await readFile(importMarkerPath, 'utf-8')
        ).trim()
        logDebug(`发现待导入快照: ${pendingSnapshotImport}`)
      } catch {
        logDebug('读取待导入快照标记文件失败')
      }
    }

    onProgress?.({ stage: 'starting', message: '正在启动 Meilisearch...' })

    // 构建命令参数
    // Meilisearch 使用 --db-path 指定数据目录，--http-addr 指定绑定地址
    const args = [
      '--db-path',
      dataDir,
      '--http-addr',
      `${container.bindAddress ?? '127.0.0.1'}:${port}`,
      '--env',
      'development',
      '--no-analytics',
      '--snapshot-dir',
      snapshotsDir,
    ]

    // 如果有待导入的快照，添加相应标志
    if (pendingSnapshotImport && existsSync(pendingSnapshotImport)) {
      args.push('--import-snapshot', pendingSnapshotImport)
      logDebug(`即将导入快照: ${pendingSnapshotImport}`)
    }

    const masterKey = await readMasterKey(name)
    const processEnv = { ...process.env }
    if (masterKey) {
      processEnv.MEILI_MASTER_KEY = masterKey
      logDebug(`对 ${name} 使用已持久化的 Meilisearch master key`)
    }

    logDebug(`使用参数启动 meilisearch: ${args.join(' ')}`)

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
        // 日志文件可能尚未创建
      }
      return null
    }

    // Meilisearch 以前台模式运行，因此需要以脱离方式启动
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
          env: processEnv,
        }

        const proc = spawn(meilisearchServer, args, spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(
            new Error(`无法启动 Meilisearch 服务器: ${err.message}`),
          )
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
          reject(
            new Error(
              `Meilisearch 进程意外退出（${reason}）。\n` +
                `Stderr: ${stderrOutput || '(无)'}\n` +
                `Stdout: ${stdoutOutput || '(无)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`meilisearch stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`meilisearch stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(
              new Error('Meilisearch 服务器进程启动失败（无 PID）'),
            )
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
            settled = true
            // 如果存在，清理待导入快照的标记文件
            if (existsSync(importMarkerPath)) {
              try {
                await unlink(importMarkerPath)
                logDebug('已清理待导入快照的标记文件')
              } catch {
                // 非致命错误
              }
            }
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true

            // 在 reject 之前清理脱离的孤立进程
            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // 忽略清理错误 — 尽力而为
              }
            }

            const portError = await checkLogForError()

            const errorDetails = [
              portError || 'Meilisearch 在超时内未能启动。',
              `二进制文件: ${meilisearchServer}`,
              `日志文件: ${logFile}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, START_CHECK_DELAY_MS)
      })
    }

    // macOS/Linux: 使用忽略 stdio 的方式启动，以便 Node.js 可正常退出
    const proc = spawn(meilisearchServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env: processEnv,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('Meilisearch 服务器进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    // 等待 Meilisearch 就绪
    const ready = await this.waitForReady(port)

    if (ready) {
      // 如果存在，清理待导入快照的标记文件
      if (existsSync(importMarkerPath)) {
        try {
          await unlink(importMarkerPath)
          logDebug('已清理待导入快照的标记文件')
        } catch {
          // 非致命错误
        }
      }
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 在抛出异常之前清理脱离的孤立进程
    if (proc.pid) {
      try {
        // 先尝试杀死进程组（POSIX）
        process.kill(-proc.pid, 'SIGTERM')
        logDebug(`已终止进程组 ${proc.pid}`)
      } catch {
        // 进程组终止失败，尝试终止单个进程
        try {
          process.kill(proc.pid, 'SIGTERM')
          logDebug(`已终止进程 ${proc.pid}`)
        } catch {
          // 忽略 — 进程可能已经退出
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
      portError || 'Meilisearch 在超时内未能启动。',
      `二进制文件: ${meilisearchServer}`,
      `日志文件: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // 等待 Meilisearch 准备好接收连接
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // 使用 REST API 健康检查
        // Meilisearch 使用 /health（而非 Qdrant 的 /healthz）
        const response = await meilisearchApiRequest(port, 'GET', '/health')
        if (response.status === 200) {
          logDebug(`Meilisearch 在端口 ${port} 已就绪`)
          return true
        }
      } catch {
        // 连接失败，等待后重试
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Meilisearch 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 Meilisearch 服务器
   * 使用进程终止方式
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    logDebug(`正在停止 Meilisearch 容器 "${name}"（端口 ${port}）`)

    // 获取 PID 并终止
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    // 如果正在运行，则终止进程
    // 在 Windows 上，直接使用强制终止（优雅关闭通常不会释放资源）
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 Meilisearch 进程 ${pid}`)
      try {
        // 在 Windows 上，跳过优雅终止 — 通常不会释放文件句柄
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
    if (isWindows()) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // 终止所有仍在监听该端口的进程
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
      const portWaitTimeout = 30000 // 最长 30 秒
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

    logDebug('Meilisearch 已停止')
  }

  // 获取 Meilisearch 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    // 尝试通过 REST API 进行健康检查
    try {
      const response = await meilisearchApiRequest(port, 'GET', '/health')
      if (response.status === 200) {
        return { running: true, message: 'Meilisearch 正在运行' }
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
            message: `Meilisearch 正在运行（PID: ${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'Meilisearch 未在运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
   * 重要: 恢复前 Meilisearch 必须处于停止状态
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // 检查容器是否在运行 — 快照恢复前 Meilisearch 必须停止
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Meilisearch 容器 "${name}" 必须在恢复前停止。` +
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

  // 打开 HTTP API（Meilisearch 使用 REST API，无交互式 shell）
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`Meilisearch REST API 地址: ${url}`)
    console.log(`Meilisearch 仪表盘: ${url}`)
    console.log('')
    console.log('示例命令:')
    console.log(`  curl ${url}/indexes`)
    console.log(`  curl ${url}/health`)
    console.log(`  curl ${url}/stats`)
  }

  /**
   * 创建新索引
   * Meilisearch 使用 indexes 而非传统数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // 以给定名称作为主键创建索引
    const response = await meilisearchApiRequest(port, 'POST', '/indexes', {
      uid: database,
      primaryKey: 'id',
    })

    // Meilisearch 对异步操作返回 202 Accepted
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `无法创建索引: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已创建 Meilisearch 索引: ${database}`)
  }

  /**
   * 删除索引
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await meilisearchApiRequest(
      port,
      'DELETE',
      `/indexes/${encodeURIComponent(database)}`,
    )

    // Meilisearch 对异步删除返回 202 Accepted
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `无法删除索引: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`已删除 Meilisearch 索引: ${database}`)
  }

  /**
   * 使用 Meilisearch 原生的 PATCH /indexes/{uid} 重命名索引
   * 自 Meilisearch v1.18.0 起可用
   */
  async renameDatabase(
    container: ContainerConfig,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const { port } = container

    const response = await meilisearchApiRequest(
      port,
      'PATCH',
      `/indexes/${encodeURIComponent(oldName)}`,
      { uid: newName },
    )

    // Meilisearch 对异步操作返回 202 Accepted
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `无法重命名索引: ${JSON.stringify(response.data)}`,
      )
    }

    // 轮询直到异步任务完成
    const taskData = response.data as { taskUid?: number }
    if (response.status === 202 && taskData?.taskUid === undefined) {
      throw new Error(
        `Meilisearch 返回 202 但无 taskUid — 无法验证重命名是否完成`,
      )
    }
    if (taskData?.taskUid !== undefined) {
      const startTime = Date.now()
      const timeoutMs = 30000
      const checkInterval = 500
      let succeeded = false

      while (Date.now() - startTime < timeoutMs) {
        const taskResponse = await meilisearchApiRequest(
          port,
          'GET',
          `/tasks/${taskData.taskUid}`,
        )

        if (taskResponse.status === 200) {
          const task = taskResponse.data as { status?: string }
          if (task.status === 'succeeded') {
            succeeded = true
            break
          }
          if (task.status === 'failed' || task.status === 'canceled') {
            throw new Error(`索引重命名任务失败: ${JSON.stringify(task)}`)
          }
        } else {
          logDebug(
            `Meilisearch 任务轮询返回 HTTP ${taskResponse.status}，正在重试...`,
          )
        }

        await new Promise((r) => setTimeout(r, checkInterval))
      }

      if (!succeeded) {
        // 轮询超时 — 进行最后一次检查
        const finalCheck = await meilisearchApiRequest(
          port,
          'GET',
          `/tasks/${taskData.taskUid}`,
        )
        const finalTask = finalCheck.data as { status?: string }
        if (finalTask?.status !== 'succeeded') {
          throw new Error(
            `索引重命名在 ${timeoutMs / 1000}s 后超时。任务 ${taskData.taskUid} 状态: ${finalTask?.status ?? '未知'}`,
          )
        }
      }
    }

    logDebug(`已重命名 Meilisearch 索引: ${oldName} -> ${newName}`)
  }

  /**
   * 获取 Meilisearch 实例的存储大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      const response = await meilisearchApiRequest(port, 'GET', '/stats')
      if (response.status === 200) {
        const stats = response.data as { databaseSize?: number }
        return stats.databaseSize ?? null
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 从远程 Meilisearch 连接导出数据
   * 使用 Meilisearch 的 REST API 创建并下载转储文件
   *
   * 连接字符串格式: http://host:port 或 meilisearch://host:port
   * 使用 API Key 认证: http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串
    const { baseUrl, headers } =
      parseMeilisearchConnectionString(connectionString)

    logDebug(`正在连接到远程 Meilisearch，地址: ${baseUrl}`)

    // 检查连通性并获取索引数量
    const indexesResponse = await remoteMeilisearchRequest(
      baseUrl,
      'GET',
      '/indexes',
      headers,
    )
    if (indexesResponse.status !== 200) {
      throw new Error(
        `无法连接到 Meilisearch（${baseUrl}）: ${JSON.stringify(indexesResponse.data)}`,
      )
    }

    const indexesData = indexesResponse.data as {
      results?: Array<{ uid: string }>
    }
    const indexCount = indexesData.results?.length ?? 0

    logDebug(`在远程服务器上找到 ${indexCount} 个索引`)

    // 在远程服务器上创建转储文件
    logDebug('正在远程服务器上创建转储文件...')
    const dumpResponse = await remoteMeilisearchRequest(
      baseUrl,
      'POST',
      '/dumps',
      headers,
    )

    // Meilisearch 返回 202 Accepted
    if (dumpResponse.status !== 202 && dumpResponse.status !== 200) {
      throw new Error(
        `无法在远程 Meilisearch 上创建转储文件: ${JSON.stringify(dumpResponse.data)}`,
      )
    }

    const dumpData = dumpResponse.data as { taskUid?: number }
    const taskUid = dumpData?.taskUid

    if (taskUid === undefined) {
      throw new Error('Meilisearch 转储文件创建失败: 未返回任务 UID')
    }

    logDebug(`远程转储任务已创建: ${taskUid}`)

    // 等待任务完成
    const maxWait = 5 * 60 * 1000 // 5 分钟
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      const taskResponse = await remoteMeilisearchRequest(
        baseUrl,
        'GET',
        `/tasks/${taskUid}`,
        headers,
      )

      if (taskResponse.status === 200) {
        const task = taskResponse.data as {
          status?: string
          details?: { dumpUid?: string }
        }

        if (task.status === 'succeeded') {
          logDebug(`转储任务成功: ${task.details?.dumpUid}`)
          // 注意: Meilisearch 将转储文件存储在服务器本地
          // 无法像 Qdrant 快照那样通过 REST API 下载
          // 用户需要访问服务器的文件系统

          return {
            filePath: outputPath,
            warnings: [
              `已在远程服务器上创建转储文件。Meilisearch 不支持通过 REST API 下载转储文件。`,
              `转储文件存储在服务器的 dumps 目录中。`,
              indexCount === 0
                ? '远程 Meilisearch 实例没有索引'
                : undefined,
            ].filter((w): w is string => w !== undefined),
          }
        }

        if (task.status === 'failed') {
          throw new Error(
            `Meilisearch 转储任务失败: ${JSON.stringify(task)}`,
          )
        }
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    throw new Error('Meilisearch 转储任务在超时内未完成')
  }

  // 创建备份
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // 运行命令 — Meilisearch 使用 REST API，而非命令文件
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Meilisearch 不支持命令文件。请直接使用 REST API。\n' +
          `示例: curl -X POST http://127.0.0.1:${port}/indexes`,
      )
    }

    if (options.sql) {
      // 尝试解释为简单命令（如 "LIST INDEXES"）
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST INDEXES' || command === 'SHOW INDEXES') {
        const response = await meilisearchApiRequest(port, 'GET', '/indexes')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Meilisearch 使用 REST API 进行操作。请使用 curl 或 Meilisearch 客户端库。\n' +
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
   *   GET /indexes
   *   POST /indexes/movies/search {"q": "action"}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port } = container
    const savedCreds =
      options?.password
        ? null
        : await loadCredentials(
            name,
            Engine.Meilisearch,
            getDefaultUsername(Engine.Meilisearch),
          )
    const apiKey = options?.password || savedCreds?.apiKey

    // 解析查询字符串: METHOD /path [body]
    const trimmed = query.trim()
    const spaceIdx = trimmed.indexOf(' ')

    if (spaceIdx === -1) {
      throw new Error(
        '无效的查询格式。期望: METHOD /path [body]\n' +
          '示例: GET /indexes',
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
        // 同时提供了内联 JSON 和 options.body — 报错
        throw new Error(
          '不能同时在查询中指定内联 JSON body 和 options.body。请二选一。',
        )
      }
      try {
        body = JSON.parse(rest.substring(bodyStart)) as Record<string, unknown>
      } catch {
        throw new Error('查询中的 JSON body 无效')
      }
    } else {
      path = rest
    }

    // 确保路径以 / 开头
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    const response = await meilisearchApiRequest(
      port,
      method,
      path,
      body,
      30000,
      apiKey,
    )

    if (response.status >= 400) {
      throw new Error(
        `Meilisearch API 错误（${response.status}）: ${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * 列出 Meilisearch 的数据库。
   * Meilisearch 使用 indexes，因此查询 /indexes 端点。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { name, port } = container
    const savedCreds = await loadCredentials(
      name,
      Engine.Meilisearch,
      getDefaultUsername(Engine.Meilisearch),
    )

    try {
      const response = await meilisearchApiRequest(
        port,
        'GET',
        '/indexes',
        undefined,
        30000,
        savedCreds?.apiKey,
      )
      if (response.status === 200 && response.data) {
        // 响应格式: { results: [{ uid: "index_name", ... }, ...], ... }
        const data = response.data as { results?: Array<{ uid: string }> }
        if (Array.isArray(data.results)) {
          const indexes = data.results.map((index) => index.uid)
          return indexes.length > 0 ? indexes : [container.database]
        }
      }
      // 回退到已配置的数据库
      return [container.database]
    } catch {
      // 出错时，回退到已配置的数据库
      return [container.database]
    }
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { name, port } = container
    const { username, password } = options
    assertValidUsername(username)
    const masterKeyPath = getMasterKeyPath(name)

    let masterKey = await readMasterKey(name)
    const nextMasterKey = (password || '').trim()
    const shouldRotateKey =
      nextMasterKey.length > 0 && nextMasterKey !== masterKey

    if (!masterKey || shouldRotateKey) {
      if (!nextMasterKey) {
        throw new Error(
          'Meilisearch 认证需要一个非空的 master key 密码',
        )
      }
      masterKey = nextMasterKey
      await writeFile(masterKeyPath, `${masterKey}\n`, 'utf-8')
      await chmod(masterKeyPath, 0o600)

      const statusResult = await this.status(container)
      if (statusResult.running) {
        logWarning(
          `正在重启 Meilisearch 容器 "${name}" 以应用 master key 变更。` +
            '活跃的客户端连接将被断开。',
        )
        await this.stop(container)
        await this.start(container)
      }

      logDebug(`已为 ${name} 配置持久化的 Meilisearch master key`)
    }

    const connectionString = `http://127.0.0.1:${port}`

    return {
      username,
      password: '',
      connectionString,
      engine: container.engine,
      container: name,
      apiKey: masterKey,
    }
  }
}

export const meilisearchEngine = new MeilisearchEngine()