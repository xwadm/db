/**
 * TigerBeetle 引擎实现
 *
 * TigerBeetle 是一个用 Zig 编写的高性能金融分类账数据库，
 * 使用自定义二进制协议（非 REST，非 SQL）。
 *
 * 关键特性：
 * - 默认端口：3000
 * - 单一二进制文件：`tigerbeetle`（服务器 + REPL 客户端）
 * - 两步初始化：`tigerbeetle format` 然后 `tigerbeetle start`
 * - 无认证，无多数据库，自定义二进制协议
 * - 健康检查：PID + TCP 端口（无 HTTP 端点）
 * - 备份：停止并复制单个数据文件
 * - REPL：`tigerbeetle repl --cluster=0 --addresses=port`
 * - 本地开发需要 `--development` 标志
 * - 突然关闭（SIGTERM/SIGKILL）在设计上安全
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises'
import { connect, type Socket } from 'net'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { spawnAsync } from '../../core/spawn-utils'
import { tigerbeetleBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  TIGERBEETLE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
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

const ENGINE = 'tigerbeetle'
const engineDef = getEngineDefaults(ENGINE)

/**
 * 本地单节点开发的默认集群 ID。
 * TigerBeetle 的 format、start 和 REPL 命令都需要集群 ID。
 * 集群 0 是本地/单节点使用的标准默认值。
 */
const DEFAULT_CLUSTER_ID = 0

export class TigerBeetleEngine extends BaseEngine {
  name = ENGINE
  displayName = 'TigerBeetle'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return TIGERBEETLE_VERSION_MAP[version] || version
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'tigerbeetle',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `tigerbeetle${ext}`)
    return existsSync(serverPath)
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return tigerbeetleBinaryManager.isInstalled(version, platform, arch)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await tigerbeetleBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const toolPath = join(binPath, 'bin', `tigerbeetle${ext}`)
    if (existsSync(toolPath)) {
      await configManager.setBinaryPath('tigerbeetle', toolPath, 'bundled')
    }

    return binPath
  }

  /**
   * 初始化新的 TigerBeetle 数据目录。
   * 创建目录并运行 `tigerbeetle format` 初始化数据文件。
   *
   * `tigerbeetle format` 即使在 `--development` 标志下也会预分配约 1.06 GiB 磁盘空间
   * （该标志仅缩小缓存/批次大小，不影响数据文件）。
   * 在慢速 CI 运行器（Windows 虚拟磁盘、繁忙的 GitHub Actions macOS x64 主机、
   * Linux 上的网络 /tmp）上，分配可能需要超过 30 秒，这是之前的超时时间。
   * 当这种情况发生时，测试会显示为 `Failed to format TigerBeetle data file: ETIMEDOUT`，
   * 整个 TigerBeetle 测试套件会失败；重新运行通常会通过，因为磁盘已经预热。
   * QA 扫描跟踪器中的 BUG-7 记录了此不稳定问题。
   *
   * 这里的修复有两个方面：
   *   1. 使用异步 spawn（非 execFileSync），超时时间为 120 秒 —— 足够覆盖最差的 CI 分配情况，
   *      又不会太长以至于真正的挂起会阻塞整个套件。
   *   2. format 返回 0 后，等待数据文件可见且完全分配（大小与 TigerBeetle 报告的一致）。
   *      在慢速文件系统上，format 进程可能在元数据刷新之前退出；
   *      紧接着的 `start()` 会看到部分文件并无法启动守护进程。
   */
  async initDataDir(
    containerName: string,
    version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 TigerBeetle 数据目录：${dataDir}`)
    }

    const dataFile = join(dataDir, '0_0.tigerbeetle')

    // 如果数据文件已存在则跳过格式化（例如从备份恢复）
    if (existsSync(dataFile)) {
      logDebug(`TigerBeetle 数据文件已存在：${dataFile}`)
      return dataDir
    }

    // 获取 format 命令的二进制文件路径
    const tigerbeetleBinary = await this.getTigerBeetlePath(version)

    // 运行 tigerbeetle format 初始化数据文件
    logDebug(`正在格式化 TigerBeetle 数据文件：${dataFile}`)

    try {
      const { stderr } = await spawnAsync(
        tigerbeetleBinary,
        [
          'format',
          `--cluster=${DEFAULT_CLUSTER_ID}`,
          '--replica=0',
          '--replica-count=1',
          '--development',
          dataFile,
        ],
        { timeout: 120_000 },
      )
      logDebug(`TigerBeetle 数据文件格式化成功：${dataFile}`)
      if (stderr) {
        logDebug(`tigerbeetle format stderr: ${stderr}`)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('PermissionDenied')) {
        throw new Error(
          "TigerBeetle 需要 io_uring 系统调用，但被 Docker 的默认 seccomp 配置文件阻止。\n" +
            '请使用以下命令运行容器：docker run --security-opt seccomp=unconfined ...',
        )
      }
      throw new Error(`格式化 TigerBeetle 数据文件失败：${msg}`)
    }

    // format 命令可能在慢速 CI 文件系统上数据文件元数据完全刷新之前返回。
    // 轮询文件可见且大小 > 0 后再返回。后续的 `start()` 如果数据文件缺失或为空将拒绝启动守护进程。
    const fileReady = await this.waitForDataFileReady(dataFile)
    if (!fileReady) {
      throw new Error(
        `TigerBeetle 数据文件在格式化后不可见：${dataFile}`,
      )
    }

    return dataDir
  }

  /**
   * 轮询文件系统直到数据文件可见且非空。
   *
   * 导出为方法以便单元测试可以在不调用 `tigerbeetle` 二进制文件的情况下驱动它 —— 参见 BUG-7 回归套件。
   */
  async waitForDataFileReady(
    dataFile: string,
    options: { maxAttempts?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = options.maxAttempts ?? 50
    const intervalMs = options.intervalMs ?? 200

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const stats = await stat(dataFile)
        if (stats.size > 0) {
          logDebug(
            `TigerBeetle 数据文件就绪（尝试 ${attempt}，大小=${stats.size}）：${dataFile}`,
          )
          return true
        }
      } catch (error) {
        logDebug(
          `waitForDataFileReady 尝试 ${attempt}/${maxAttempts}：${error}`,
        )
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
    return false
  }

  // 获取指定版本的 tigerbeetle 二进制文件路径
  async getTigerBeetlePath(version: string): Promise<string> {
    // 首先检查配置缓存
    const cached = await configManager.getBinaryPath('tigerbeetle')
    if (cached && existsSync(cached)) {
      return cached
    }

    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'tigerbeetle',
      version: fullVersion,
      platform,
      arch,
    })
    const tigerbeetlePath = join(binPath, 'bin', `tigerbeetle${ext}`)

    if (existsSync(tigerbeetlePath)) {
      return tigerbeetlePath
    }

    throw new Error(
      `TigerBeetle ${version} 未安装。请运行：spindb engines download tigerbeetle ${version}`,
    )
  }

  /**
   * 启动 TigerBeetle 服务器
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

    // 获取 TigerBeetle 二进制文件路径
    let tigerbeetleBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `tigerbeetle${ext}`)
      if (existsSync(serverPath)) {
        tigerbeetleBinary = serverPath
        logDebug(`使用存储的二进制路径：${tigerbeetleBinary}`)
      }
    }

    if (!tigerbeetleBinary) {
      try {
        tigerbeetleBinary = await this.getTigerBeetlePath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `TigerBeetle ${version} 未安装。请运行：spindb engines download tigerbeetle ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')
    const dataFile = join(dataDir, '0_0.tigerbeetle')

    // 即使在 `initDataDir` 返回成功后，数据文件在慢速 CI 文件系统上可能暂时无法读取 ——
    // 使用短的有界循环重试存在性检查，这样我们就不会因瞬时的 stat() 闪烁而崩溃。
    if (!existsSync(dataFile)) {
      const dataFileReady = await this.waitForDataFileReady(dataFile, {
        maxAttempts: 10,
        intervalMs: 200,
      })
      if (!dataFileReady) {
        throw new Error(
          `TigerBeetle 数据文件未在 ${dataFile} 找到。请运行：spindb create <name> --engine tigerbeetle`,
        )
      }
    }

    onProgress?.({ stage: 'starting', message: '正在启动 TigerBeetle...' })

    logDebug(`正在端口 ${port} 上启动 TigerBeetle`)

    const args = [
      'start',
      `--addresses=${container.bindAddress ?? '127.0.0.1'}:${port}`,
      '--development',
      dataFile,
    ]

    // 通过文件描述符将 stdout/stderr 重定向到日志文件
    const logFd = openSync(logFile, 'a')

    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    }

    if (isWindows()) {
      spawnOpts.windowsHide = true
    }

    const proc = spawn(tigerbeetleBinary!, args, spawnOpts)
    proc.unref()

    // 在父进程中关闭 fd —— 子进程继承了自己的副本
    closeSync(logFd)

    if (!proc.pid) {
      throw new Error('TigerBeetle 服务器进程启动失败（无 PID）')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // 非致命错误
    }

    // 等待 TigerBeetle 就绪。之前的探测使用 `portManager.isPortAvailable` 推断就绪状态，
    // 但它在*任何*东西绑定端口时立即返回 false —— 包括仍在初始化中、尚未完成 accept 循环的 TigerBeetle。
    // 随后来自云（或集成测试助手）的 TCP 连接可能会竞争并观察到 ECONNREFUSED。
    // 改为使用实际的 TCP 连接，这样"就绪"意味着"接受客户端连接"，
    // 并将超时预算加倍以吸收 GitHub 托管的 Windows 运行器上的冷启动差异。
    const ready = await this.waitForReady(port, 60_000)

    // 解析实际的监听器 PID 并刷新 PID 文件。
    // 在 Windows 上（以及偶尔在 Linux 上，当 spawn 父进程 fork 时），
    // spawn 报告的 PID 不是实际持有端口的 PID —— 没有这一步，
    // 后续的 `spindb stop` 会向错误的进程发送信号，导致守护进程泄漏。
    let listenerPid: number | null = null
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        listenerPid = pids[0]
        if (listenerPid !== proc.pid) {
          logDebug(
            `TigerBeetle 实际 PID ${listenerPid} 与 spawn PID ${proc.pid} 不同，正在更新 PID 文件`,
          )
          await writeFile(pidFile, String(listenerPid))
        }
      }
    } catch {
      // 非致命：PID 文件已经有之前写入的 proc.pid。
    }

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 就绪探测失败。如果有进程*实际*绑定到端口，守护进程是活动的，
    // 探测只是遇到了瞬时的故障（lsof 延迟、半绑定套接字的 ECONNREFUSED、繁忙的 CI 运行器）。
    // 信任监听器并将其视为已启动 —— 与 ClickHouse PID 竞争修复相同的模式。
    // 只有当端口上没有东西时才杀死孤儿进程并抛出。
    if (listenerPid && platformService.isProcessRunning(listenerPid)) {
      logWarning(
        `TigerBeetle 就绪探测超时，但守护进程（pid ${listenerPid}）正在监听端口 ${port}；视为已启动`,
      )
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 在抛出之前清理孤立的分离进程
    if (platformService.isProcessRunning(proc.pid)) {
      try {
        await platformService.terminateProcess(proc.pid, true)
      } catch {
        // 忽略清理错误 —— 尽力而为
      }
    }

    // 检查日志中的错误
    let logError = ''
    try {
      const logContent = await readFile(logFile, 'utf-8')
      const recentLog = logContent.slice(-2000)
      if (recentLog.includes('PermissionDenied')) {
        throw new Error(
          "TigerBeetle 需要 io_uring 系统调用，但被 Docker 的默认 seccomp 配置文件阻止。\n" +
            '请使用以下命令运行容器：docker run --security-opt seccomp=unconfined ...',
        )
      }
      if (
        recentLog.includes('Address already in use') ||
        recentLog.includes('address already in use')
      ) {
        logError = `端口 ${port} 已被占用`
      }
    } catch (logReadError) {
      // 重新抛出 io_uring 错误，忽略其他日志读取失败
      if (
        logReadError instanceof Error &&
        logReadError.message.includes('io_uring')
      ) {
        throw logReadError
      }
    }

    const errorDetails = [
      logError || 'TigerBeetle 在超时内未能启动。',
      `二进制文件：${tigerbeetleBinary}`,
      `日志文件：${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  /**
   * 通过完成与监听地址的 TCP 握手来等待 TigerBeetle 就绪。
   * TigerBeetle 没有 HTTP 健康端点，但成功的 TCP 连接足以证明 accept 循环正在运行。
   *
   * 暴露为方法以便单元测试可以在不启动真实 TigerBeetle 守护进程的情况下驱动它。
   */
  async waitForReady(port: number, timeoutMs = 60_000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500
    const connectTimeoutMs = 2_000

    while (Date.now() - startTime < timeoutMs) {
      const connected = await this.tryTcpConnect(
        '127.0.0.1',
        port,
        connectTimeoutMs,
      )
      if (connected) {
        logDebug(`TigerBeetle 在端口 ${port} 上就绪`)
        return true
      }
      // 回退到成本较低的"端口已绑定"检查 —— 当守护进程仍在 listen/accept 窗口中且我们的连接竞争时有用。
      // 将"端口不可用"也视为积极信号，因为端口上的非 spindb 监听器会在更早时导致 spindb start 失败。
      const available = await portManager.isPortAvailable(port)
      if (!available) {
        logDebug(
          `TigerBeetle 端口 ${port} 已绑定但 TCP 连接尚未成功；视为就绪`,
        )
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`TigerBeetle 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 尝试在硬超时内建立到 `host:port` 的单个 TCP 连接。
   * 成功连接时解析为 true（套接字立即关闭），错误或超时时解析为 false。从不抛出。
   */
  private tryTcpConnect(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }

      const socket: Socket = connect({ host, port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
  }

  /**
   * 停止 TigerBeetle 服务器。
   * SIGTERM 在设计上安全 —— TigerBeetle 优雅地处理突然关闭。
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')

    logDebug(`正在停止端口 ${port} 上的 TigerBeetle 容器"${name}"`)

    let pid: number | null = null

    // 从文件读取 PID
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    // 回退：通过端口查找
    if (!pid || !platformService.isProcessRunning(pid)) {
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          pid = pids[0]
        }
      } catch {
        // 忽略
      }
    }

    // 如果找到进程则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 TigerBeetle 进程 ${pid}`)
      try {
        if (isWindows()) {
          await platformService.terminateProcess(pid, true)
        } else {
          await platformService.terminateProcess(pid, false)
          await new Promise((resolve) => setTimeout(resolve, 2000))

          if (platformService.isProcessRunning(pid)) {
            logWarning(`优雅终止失败，强制终止 ${pid}`)
            await platformService.terminateProcess(pid, true)
          }
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    // 等待终止
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // 清理 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 忽略
      }
    }

    logDebug('TigerBeetle 已停止')
  }

  /**
   * 获取 TigerBeetle 服务器状态。
   * 使用 PID 文件 + 进程检查，端口查找作为回退。
   * 没有 HTTP 健康端点可用。
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')

    // 首先检查 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `TigerBeetle 正在运行（PID：${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    // 回退：通过端口检查
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        return {
          running: true,
          message: `TigerBeetle 正在运行（PID：${pids[0]}）`,
        }
      }
    } catch {
      // 忽略
    }

    return { running: false, message: 'TigerBeetle 未运行' }
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份。
   * 恢复前必须停止 TigerBeetle。
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // 检查容器是否正在运行
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `恢复前必须停止 TigerBeetle 容器"${name}"。` +
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
   * 获取连接字符串。
   * TigerBeetle 使用自定义二进制协议 —— 无 URI 方案。
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `127.0.0.1:${port}`
  }

  /**
   * 打开 TigerBeetle REPL（交互式客户端）。
   * 使用来自 SurrealDB 的 stdio: 'inherit' 模式。
   */
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port, version } = container

    const tigerbeetleBinary = await this.getTigerBeetlePath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        tigerbeetleBinary,
        [
          'repl',
          `--cluster=${DEFAULT_CLUSTER_ID}`,
          `--addresses=127.0.0.1:${port}`,
        ],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建数据库 —— 不支持。
   * TigerBeetle 没有数据库概念。
   */
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new Error(
      'TigerBeetle 不支持多数据库。' +
        '每个容器是一个独立的分类账实例。',
    )
  }

  /**
   * 删除数据库 —— 不支持。
   */
  async dropDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new Error(
      'TigerBeetle 不支持多数据库。' +
        '使用 `spindb delete <container>` 移除实例。',
    )
  }

  /**
   * 从数据文件获取数据库大小。
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })
    const dataFile = join(dataDir, '0_0.tigerbeetle')

    try {
      const stats = await stat(dataFile)
      return stats.size
    } catch {
      return null
    }
  }

  /**
   * 从连接字符串转储 —— 不支持。
   * TigerBeetle 使用自定义二进制协议，不支持远程转储。
   */
  async dumpFromConnectionString(
    _connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    throw new Error(
      'TigerBeetle 不支持远程转储。\n' +
        'TigerBeetle 使用需要直接文件访问的自定义二进制协议。\n' +
        '要备份远程 TigerBeetle 实例，请停止服务器并直接复制数据文件。',
    )
  }

  /**
   * 创建备份。
   * TigerBeetle 需要停止服务器才能备份。
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const { name } = container
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    // 验证服务器已停止
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `备份前必须停止 TigerBeetle 容器"${name}"。` +
          `请运行：spindb stop ${name}`,
      )
    }

    return createBackup(dataDir, outputPath, options)
  }

  /**
   * 运行脚本 —— 不支持。
   * TigerBeetle 使用自定义二进制协议，非 SQL 或 REST。
   */
  async runScript(
    _container: ContainerConfig,
    _options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    throw new Error(
      'TigerBeetle 不支持脚本执行。\n' +
        '使用 TigerBeetle REPL 进行交互式操作：spindb connect <container>',
    )
  }

  /**
   * 执行查询 —— 不支持。
   * TigerBeetle 使用自定义二进制协议。
   */
  async executeQuery(
    _container: ContainerConfig,
    _query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    throw new Error(
      'TigerBeetle 不支持 SQL 或 REST 查询。\n' +
        '使用 TigerBeetle REPL 进行交互式操作：spindb connect <container>\n' +
        '或在您的应用程序中使用 TigerBeetle 客户端库。',
    )
  }

  /**
   * 列出数据库 —— TigerBeetle 没有数据库概念。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    return [container.database]
  }

  /**
   * 创建用户 —— 不支持。
   * TigerBeetle 没有认证机制。
   */
  async createUser(
    _container: ContainerConfig,
    _options: CreateUserOptions,
  ): Promise<UserCredentials> {
    throw new Error(
      'TigerBeetle 不支持用户认证。\n' +
        '访问控制在网络层面管理。',
    )
  }
}

export const tigerbeetleEngine = new TigerBeetleEngine()
