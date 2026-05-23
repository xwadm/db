/**
 * CockroachDB 引擎实现
 *
 * CockroachDB 是一款分布式 SQL 数据库，兼容 PostgreSQL 通信协议。
 * 提供水平扩展、强一致性和内置的存活性能力。
 *
 * 关键特性：
 * - 默认 SQL 端口：26257
 * - HTTP 管理界面端口：SQL 端口 + 1（默认 26258）
 * - 使用 PostgreSQL 通信协议进行客户端连接
 * - 单一二进制文件：`cockroach`（负责服务器、SQL 客户端和管理任务）
 * - 默认数据库：`defaultdb`
 * - 默认本地管理员用户：`root`，通过生成的客户端证书认证
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
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
import { findBinary } from '../../core/dependency-manager'
import { processManager } from '../../core/process-manager'
import { cockroachdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  COCKROACHDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
  escapeSqlValue,
  parseCsvLine,
  parseCsvRecords,
  isInsecureConnection,
  buildLocalCockroachSqlArgs,
  buildSecureCockroachConnectionString,
  buildInsecureCockroachConnectionString,
  getCockroachCertsDir,
  getCockroachCaCertPath,
  getCockroachCaKeyPath,
  getCockroachClientCertPath,
  getCockroachClientKeyPath,
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
import { parseCSVToQueryResult } from '../../core/query-parser'

const ENGINE = 'cockroachdb'
const engineDef = getEngineDefaults(ENGINE)

async function runCockroachCommand(
  cockroachPath: string,
  args: string[],
  spawnOptions: SpawnOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cockroachPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
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
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr || `cockroach 退出码 ${code}`))
      }
    })
  })
}

async function ensureSecureLocalAssets(
  cockroachPath: string,
  containerName: string,
  bindAddress?: string,
): Promise<void> {
  const certsDir = getCockroachCertsDir(containerName)
  const caKey = getCockroachCaKeyPath(containerName)
  const nodeCert = join(certsDir, 'node.crt')
  const nodeKey = join(certsDir, 'node.key')
  const rootClientCert = getCockroachClientCertPath(containerName, 'root')
  const rootClientKey = getCockroachClientKeyPath(containerName, 'root')

  await mkdir(certsDir, { recursive: true })

  if (!existsSync(join(certsDir, 'ca.crt')) || !existsSync(caKey)) {
    await runCockroachCommand(cockroachPath, [
      'cert',
      'create-ca',
      '--certs-dir',
      certsDir,
      '--ca-key',
      caKey,
    ])
  }

  if (!existsSync(nodeCert) || !existsSync(nodeKey)) {
    const hosts = new Set(['127.0.0.1', 'localhost', '::1'])
    if (bindAddress && bindAddress !== '0.0.0.0' && bindAddress !== '::') {
      hosts.add(bindAddress)
    }

    await runCockroachCommand(cockroachPath, [
      'cert',
      'create-node',
      ...Array.from(hosts),
      '--certs-dir',
      certsDir,
      '--ca-key',
      caKey,
    ])
  }

  if (!existsSync(rootClientCert) || !existsSync(rootClientKey)) {
    await runCockroachCommand(cockroachPath, [
      'cert',
      'create-client',
      'root',
      '--certs-dir',
      certsDir,
      '--ca-key',
      caKey,
    ])
  }
}

export class CockroachDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'CockroachDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息以用于二进制操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退方案获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '25' -> '25.4.2'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return COCKROACHDB_VERSION_MAP[version] || version
  }

  // 获取特定版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'cockroachdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 CockroachDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
    return existsSync(cockroachPath)
  }

  // 检查特定 CockroachDB 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return cockroachdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 CockroachDB 二进制文件可用
   * 如果尚未安装，则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await cockroachdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
    if (existsSync(cockroachPath)) {
      await configManager.setBinaryPath('cockroach', cockroachPath, 'bundled')
    }

    return binPath
  }

  /**
   * 初始化新的 CockroachDB 数据目录
   * 为 CockroachDB 存储创建目录结构
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // 创建数据目录
    await mkdir(dataDir, { recursive: true })

    logDebug(`已创建 CockroachDB 数据目录：${dataDir}`)

    return dataDir
  }

  // 获取特定版本的 cockroach 二进制文件路径
  async getCockroachPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'cockroachdb',
      version: fullVersion,
      platform,
      arch,
    })
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)

    if (existsSync(cockroachPath)) {
      return cockroachPath
    }

    throw new Error(
      `CockroachDB ${version} 未安装。请运行：spindb engines download cockroachdb ${version}`,
    )
  }

  /**
   * 启动 CockroachDB 服务器
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

    // 获取 CockroachDB 二进制文件路径
    let cockroachBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `cockroach${ext}`)
      if (existsSync(serverPath)) {
        cockroachBinary = serverPath
        logDebug(`使用已存储的二进制文件路径：${cockroachBinary}`)
      }
    }

    if (!cockroachBinary) {
      try {
        cockroachBinary = await this.getCockroachPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `CockroachDB ${version} 未安装。请运行：spindb engines download cockroachdb ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = join(containerDir, 'cockroach.log')
    const pidFile = join(containerDir, 'cockroach.pid')
    const httpPort = port + 1 // HTTP 管理界面端口

    onProgress?.({ stage: 'starting', message: '正在启动 CockroachDB...' })

    logDebug(`正在使用数据目录 ${dataDir} 启动 CockroachDB`)

    await ensureSecureLocalAssets(cockroachBinary!, name, container.bindAddress)

    // CockroachDB 启动命令
    // 本地容器以安全模式运行，使用每个容器独立的证书。
    const args = [
      'start-single-node',
      '--certs-dir',
      getCockroachCertsDir(name),
      '--store',
      dataDir,
      '--listen-addr',
      `${container.bindAddress ?? '127.0.0.1'}:${port}`,
      '--http-addr',
      `${container.bindAddress ?? '127.0.0.1'}:${httpPort}`,
      '--pid-file',
      pidFile,
      '--log-dir',
      containerDir,
    ]

    // Unix 上使用 --background 标志分叉守护进程
    // Windows 上不使用 --background - Windows 没有相同的分叉模型，
    // 且 CockroachDB 的后台模式可能静默失败。改为手动分离。
    const isWindows = process.platform === 'win32'
    if (!isWindows) {
      args.push('--background')
    }

    // 重要：所有平台上使用 'ignore' 处理所有 stdio。
    // 使用 'pipe' 会保持文件描述符打开，阻止 proc.unref()
    // 允许 Node.js 退出，导致 spawn 超时，即使进程启动成功。
    const proc = spawn(cockroachBinary!, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      // Windows 上设置 cwd 到容器目录，以确保正确的文件句柄行为
      cwd: isWindows ? containerDir : undefined,
      // Windows 上隐藏控制台窗口以防止阻塞
      windowsHide: true,
    })

    // Windows 上不使用 --background，自行写入 PID 文件
    //（Unix 上 --background 会让 CockroachDB 写入守护进程 PID）
    if (isWindows && proc.pid) {
      try {
        await writeFile(pidFile, proc.pid.toString(), 'utf-8')
        logDebug(`已写入 PID 文件：${pidFile}（pid：${proc.pid}）`)
      } catch (err) {
        // PID 文件写入失败 - 杀死进程并快速失败
        // 没有 PID 文件，后续无法停止容器
        const errMsg = `写入 PID 文件失败：${err instanceof Error ? err.message : String(err)}`
        logDebug(errMsg)
        try {
          process.kill(proc.pid, 'SIGTERM')
        } catch {
          // 进程可能已退出
        }
        throw new Error(errMsg)
      }
    }

    // 等待进程生成
    // Windows 上分离进程的 'spawn' 事件不可靠，
    // 因此使用简单延迟，让 waitForReady() 负责检测。
    // Unix 上使用 --background，等待 spawn 事件。
    if (isWindows) {
      // 添加错误处理器以捕获 Windows 上的 spawn 失败
      await new Promise<void>((resolve, reject) => {
        proc.on('error', (err) => {
          logDebug(`Windows 上 CockroachDB spawn 错误：${err}`)
          reject(err)
        })
        proc.unref()
        logDebug(
          `Windows：等待固定延迟以启动 CockroachDB（pid：${proc.pid}）`,
        )
        setTimeout(resolve, 3000)
      })
    } else {
      const spawnTimeout = 30000 // 生成超时 30 秒
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(
            new Error(
              `CockroachDB 进程未在 ${spawnTimeout}ms 内生成`,
            ),
          )
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`CockroachDB spawn 错误：${err}`)
          reject(err)
        })
        proc.on('spawn', () => {
          clearTimeout(timeoutId)
          logDebug(`CockroachDB 进程已生成（pid：${proc.pid}）`)
          proc.unref()
          setTimeout(resolve, 500)
        })
      })
    }

    // 等待服务器就绪
    // Windows 需要更长的超时时间，因为 CockroachDB 初始化耗时更长
    const timeout = isWindows ? 120000 : 60000
    logDebug(
      `等待 CockroachDB 服务器在端口 ${port} 就绪...（超时：${timeout}ms）`,
    )
    const ready = await this.waitForReady(name, port, version, timeout)
    logDebug(`waitForReady 返回：${ready}`)

    if (!ready) {
      // 抛出异常前清理已生成的进程和 PID 文件
      try {
        const pidStr = await readFile(pidFile, 'utf-8').catch(() => null)
        if (pidStr) {
          const pid = parseInt(pidStr.trim(), 10)
          if (!isNaN(pid)) {
            logDebug(`正在清理启动失败的 CockroachDB 进程（pid：${pid}）`)
            await platformService.terminateProcess(pid, true)
          }
        }
        await unlink(pidFile).catch(() => {})
      } catch {
        // 忽略清理错误
      }
      throw new Error(
        `CockroachDB 启动超时。请查阅日志：${logFile}`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // 等待 CockroachDB 就绪
  private async waitForReady(
    containerName: string,
    port: number,
    version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady 已调用，端口 ${port}，版本 ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let cockroach: string
    try {
      logDebug('正在获取 cockroach 二进制文件路径...')
      cockroach = await this.getCockroachPath(version)
      logDebug(`已获取 cockroach 二进制文件路径：${cockroach}`)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logDebug(`获取 cockroach 二进制文件路径出错：${errorMessage}`)
      logWarning(
        `未找到 CockroachDB 二进制文件，无法验证服务器是否就绪：${errorMessage}`,
      )
      return false
    }

    logDebug(`开始连接循环，超时：${timeoutMs}ms`)
    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`连接尝试第 ${attempt} 次...`)
      try {
        const args = buildLocalCockroachSqlArgs({
          containerName,
          port,
        })
        args.push('--execute', 'SELECT 1')
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cockroach, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          proc.on('close', (code) => {
            logDebug(`客户端进程已关闭，退出码 ${code}`)
            if (code === 0) resolve()
            else reject(new Error(`退出码 ${code}`))
          })
          proc.on('error', (err) => {
            logDebug(`客户端进程错误：${err}`)
            reject(err)
          })
        })
        logDebug(`CockroachDB 在端口 ${port} 已就绪`)
        return true
      } catch (err) {
        logDebug(`第 ${attempt} 次尝试失败：${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`CockroachDB 在 ${timeoutMs}ms 内未就绪`)
    return false
  }

  /**
   * 停止 CockroachDB 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'cockroach.pid')

    logDebug(`正在停止 CockroachDB 容器 "${name}"（端口 ${port}）`)

    // 通过跨平台辅助函数查找 PID
    let pid: number | null = null

    // 尝试按端口查找 CockroachDB 进程
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        pid = pids[0]
      }
    } catch {
      // 忽略
    }

    // 如果找到进程则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 CockroachDB 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        // 等待优雅终止
        // Windows 上 CockroachDB 的 RocksDB 使用内存映射文件，
        // 释放时间更长，因此等待更长时间以避免 EBUSY 错误
        const gracefulWait = process.platform === 'win32' ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，正在强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
          // Windows 上强制终止后额外等待，以释放文件句柄
          if (process.platform === 'win32') {
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
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
        // 忽略
      }
    }

    // 如果为此容器运行了 pgweb，则终止它
    await this.stopPgweb(name)

    logDebug('CockroachDB 已停止')
  }

  // 获取 CockroachDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port, version } = container

    // 尝试连接
    try {
      const cockroach = await this.getCockroachPath(version)
      const args = buildLocalCockroachSqlArgs({
        containerName: name,
        port,
      })
      args.push('--execute', 'SELECT 1')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`退出码 ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'CockroachDB 正在运行' }
    } catch {
      return { running: false, message: 'CockroachDB 未运行' }
    }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 恢复备份
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
      database: options.database || container.database || 'defaultdb',
      version,
      clean: options.clean,
    })
  }

  /**
   * 获取连接字符串
   * 格式：postgresql://root@127.0.0.1:PORT/DATABASE?sslmode=verify-full...
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { name, port } = container
    const db = database || container.database || 'defaultdb'

    const legacyInsecureRunning =
      container.status === 'running' &&
      !existsSync(getCockroachCaCertPath(name))

    if (legacyInsecureRunning) {
      return buildInsecureCockroachConnectionString({
        port,
        database: db,
      })
    }

    return buildSecureCockroachConnectionString({
      containerName: name,
      port,
      database: db,
    })
  }

  // 打开 cockroach sql 交互式终端
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { name, port, version } = container
    const db = database || container.database || 'defaultdb'

    const cockroach = await this.getCockroachPath(version)
    const args = buildLocalCockroachSqlArgs({
      containerName: name,
      port,
      database: db,
    })

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        cockroach,
        args,
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
    const { name, port, version } = container

    // 验证数据库标识符以防止 SQL 注入
    validateCockroachIdentifier(database, 'database')
    const escapedDb = escapeCockroachIdentifier(database)

    const cockroach = await this.getCockroachPath(version)

    const args = buildLocalCockroachSqlArgs({
      containerName: name,
      port,
    })
    args.push('--execute', `CREATE DATABASE IF NOT EXISTS ${escapedDb}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已创建 CockroachDB 数据库：${database}`)
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
    const { name, port, version } = container

    // 禁止删除系统数据库
    const systemDatabases = ['defaultdb', 'postgres', 'system']
    if (systemDatabases.includes(database.toLowerCase())) {
      throw new Error(`无法删除系统数据库：${database}`)
    }

    // 验证数据库标识符以防止 SQL 注入
    validateCockroachIdentifier(database, 'database')
    const escapedDb = escapeCockroachIdentifier(database)

    const cockroach = await this.getCockroachPath(version)

    const args = buildLocalCockroachSqlArgs({
      containerName: name,
      port,
    })
    args.push('--execute', `DROP DATABASE IF EXISTS ${escapedDb}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已删除 CockroachDB 数据库：${database}`)
          resolve()
        } else {
          reject(new Error(`删除数据库失败：${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 使用 CockroachDB 原生的 ALTER DATABASE RENAME 重命名数据库
   */
  async renameDatabase(
    container: ContainerConfig,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const { name, port, version } = container

    const systemDatabases = ['defaultdb', 'postgres', 'system']
    if (systemDatabases.includes(oldName.toLowerCase())) {
      throw new Error(`无法重命名系统数据库：${oldName}`)
    }
    if (systemDatabases.includes(newName.toLowerCase())) {
      throw new Error(`无法重命名为系统数据库名称：${newName}`)
    }

    validateCockroachIdentifier(oldName, 'database')
    validateCockroachIdentifier(newName, 'database')
    const escapedOld = escapeCockroachIdentifier(oldName)
    const escapedNew = escapeCockroachIdentifier(newName)

    const cockroach = await this.getCockroachPath(version)

    const args = buildLocalCockroachSqlArgs({
      containerName: name,
      port,
    })
    args.push('--execute', `ALTER DATABASE ${escapedOld} RENAME TO ${escapedNew}`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已重命名 CockroachDB 数据库：${oldName} -> ${newName}`)
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
    const { name, port, version, database } = container
    const db = database || 'defaultdb'

    try {
      const cockroach = await this.getCockroachPath(version)
      validateCockroachIdentifier(db, 'database')

      // CockroachDB 查询数据库大小
      const query = `SELECT sum(range_size_mb) * 1024 * 1024 as size_bytes FROM [SHOW RANGES FROM DATABASE ${escapeCockroachIdentifier(db)}]`

      const result = await new Promise<string>((resolve, reject) => {
        const args = buildLocalCockroachSqlArgs({
          containerName: name,
          port,
          database: db,
        })
        args.push('--execute', query, '--format=csv')

        const proc = spawn(cockroach, args, {
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

      // 解析 CSV 输出 - 跳过表头
      const lines = result.split('\n')
      if (lines.length >= 2) {
        const size = parseFloat(lines[1])
        return isNaN(size) ? null : Math.round(size)
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * 从远程 CockroachDB 连接导出（dump）
   * 使用 cockroach sql 导出架构和数据
   *
   * 连接字符串格式：postgresql://[user[:password]@]host[:port][/database][?sslmode=...]
   *
   * 同时支持非安全（本地开发）和安全（生产）连接：
   * - sslmode=disable 或无 sslmode 的 localhost：使用 --insecure 标志
   * - 其他 SSL 模式：直接传递连接字符串（通过 URL 参数处理证书）
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串
    let url: URL
    try {
      url = new URL(connectionString)
    } catch {
      // 在错误消息中脱敏凭据信息
      const sanitized = connectionString.replace(/\/\/([^@]+)@/, '//***@')
      throw new Error(
        `无效的连接字符串：${sanitized}\n` +
          '期望格式：postgresql://[user[:password]@]host[:port][/database][?sslmode=...]',
      )
    }

    const host = url.hostname || '127.0.0.1'
    const port = parseInt(url.port, 10) || 26257
    const database = url.pathname.replace(/^\//, '') || 'defaultdb'

    logDebug(
      `正在连接远程 CockroachDB：${host}:${port}（数据库：${database}）`,
    )

    // 远程导出需要本地 cockroach 二进制文件
    // 尝试多种方法查找已安装的版本
    let cockroach: string | null = null

    // 1. 尝试配置中的 'cockroach' 键
    const cachedCockroach = await configManager.getBinaryPath('cockroach')
    if (cachedCockroach && existsSync(cachedCockroach)) {
      cockroach = cachedCockroach
      logDebug(
        `通过 'cockroach' 配置键找到 cockroach 二进制文件：${cockroach}`,
      )
    }

    // 2. 尝试通过依赖管理器查找（检查配置 + 系统 PATH）
    if (!cockroach) {
      const binaryResult = await findBinary('cockroach')
      if (binaryResult?.path && existsSync(binaryResult.path)) {
        cockroach = binaryResult.path
        logDebug(`通过依赖管理器找到 cockroach 二进制文件：${cockroach}`)
      }
    }

    // 3. 尝试通过 getCockroachPath 使用已下载的版本
    if (!cockroach) {
      for (const version of SUPPORTED_MAJOR_VERSIONS) {
        try {
          cockroach = await this.getCockroachPath(version)
          logDebug(
            `找到版本 ${version} 的 cockroach 二进制文件：${cockroach}`,
          )
          break
        } catch {
          // 该版本未安装，尝试下一个
        }
      }
    }

    if (!cockroach) {
      throw new Error(
        '未找到 CockroachDB 二进制文件。请运行：spindb engines download cockroachdb 25\n' +
          '需要本地 CockroachDB 二进制文件才能从远程连接导出。',
      )
    }

    const lines: string[] = []
    lines.push('-- CockroachDB 备份，由 SpinDB 生成')
    lines.push(`-- 来源：${host}:${port}`)
    lines.push(`-- 数据库：${database}`)
    lines.push(`-- 日期：${new Date().toISOString()}`)
    lines.push('')

    // 使用 --url 构建连接参数以保留认证/SSL 设置
    const connArgs = ['sql', '--url', connectionString]

    // 仅对本地开发或显式 sslmode=disable 添加 --insecure
    if (isInsecureConnection(connectionString)) {
      connArgs.push('--insecure')
    }

    // 获取表列表
    const tablesQuery = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    const tablesResult = await this.execRemoteQuery(
      cockroach,
      connArgs,
      tablesQuery,
    )
    // 使用记录感知解析器正确解析 CSV 输出，以处理带引号的标识符
    const tableRecords = parseCsvRecords(tablesResult, true) // 跳过表头
    const tables = tableRecords
      .map((line) => {
        const fields = parseCsvLine(line)
        return fields.length > 0 ? fields[0].value : ''
      })
      .filter((t) => t)

    logDebug(`在数据库 ${database} 中找到 ${tables.length} 张表`)

    for (const table of tables) {
      // information_schema 返回的表名是安全的（已被 CSV 解析器解引）
      // 仅验证是否获取到非空名称
      if (!table) {
        continue
      }

      lines.push(`-- 表：${table}`)
      lines.push('')

      // 获取 CREATE TABLE - 使用正确的标识符转义
      try {
        const createQuery = `SHOW CREATE TABLE ${escapeCockroachIdentifier(table)}`
        const createResult = await this.execRemoteQuery(
          cockroach,
          connArgs,
          createQuery,
        )
        // 使用记录感知解析器安全解析 CSV 输出
        // 格式为：table_name,create_statement（CREATE 语句可能包含换行符）
        const createRecords = parseCsvRecords(createResult, true) // 跳过表头
        if (createRecords.length > 0) {
          const columns = parseCsvLine(createRecords[0])
          if (columns.length >= 2) {
            // 第二列是 CREATE TABLE 语句
            const createStatement = columns[1].value.trim()
            lines.push(createStatement + ';')
          } else {
            logWarning(`${table} 的 SHOW CREATE TABLE 输出异常`)
          }
        }
        lines.push('')
      } catch (error) {
        logWarning(`无法获取 ${table} 的 CREATE TABLE 语句：${error}`)
        continue
      }

      // 导出表数据
      try {
        // 先获取列名
        // 转义表名中的单引号用于字符串字面量比较
        const escapedTableForString = table.replace(/'/g, "''")
        const columnsQuery = `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${escapedTableForString}' ORDER BY ordinal_position`
        const columnsResult = await this.execRemoteQuery(
          cockroach,
          connArgs,
          columnsQuery,
        )
        // 正确解析每个 CSV 记录以处理带引号的列名
        const columnRecords = parseCsvRecords(columnsResult, true) // 跳过表头
        const columns = columnRecords
          .map((record) => {
            const fields = parseCsvLine(record)
            return fields.length > 0 ? fields[0].value.trim() : ''
          })
          .filter((c) => c)

        if (columns.length === 0) {
          logDebug(`表 ${table} 未找到列，跳过数据导出`)
          continue
        }

        // 获取所有行 - 使用正确的标识符转义
        const dataQuery = `SELECT * FROM ${escapeCockroachIdentifier(table)}`
        const dataResult = await this.execRemoteQuery(
          cockroach,
          connArgs,
          dataQuery,
        )
        // 使用记录感知解析器处理包含嵌入式换行符的字段
        const dataRecords = parseCsvRecords(dataResult, true) // 跳过表头

        if (dataRecords.length > 0) {
          lines.push(`-- ${table} 的数据`)

          for (const dataRecord of dataRecords) {
            const fields = parseCsvLine(dataRecord)
            if (fields.length !== columns.length) {
              logWarning(
                `表 ${table} 列数不匹配：期望 ${columns.length} 列，实际 ${fields.length} 列`,
              )
              continue
            }

            const escapedCols = columns
              .map((c) => escapeCockroachIdentifier(c))
              .join(', ')
            const escapedVals = fields
              .map((f) => escapeSqlValue(f.value, f.wasQuoted))
              .join(', ')
            lines.push(
              `INSERT INTO ${escapeCockroachIdentifier(table)} (${escapedCols}) VALUES (${escapedVals});`,
            )
          }
          lines.push('')
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
        tables.length === 0
          ? [`数据库 '${database}' 中没有表`]
          : undefined,
    }
  }

  // 在远程 CockroachDB 上执行查询的辅助方法
  private async execRemoteQuery(
    cockroach: string,
    connArgs: string[],
    query: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [...connArgs, '--execute', query, '--format=csv']

      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr || `退出码 ${code}`))
        }
      })
      proc.on('error', reject)
    })
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
    const { name, port, version } = container
    const db = options.database || container.database || 'defaultdb'

    const cockroach = await this.getCockroachPath(version)

    if (options.file) {
      // 运行 SQL 文件
      const args = buildLocalCockroachSqlArgs({
        containerName: name,
        port,
        database: db,
      })
      args.push('--file', options.file)

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: 'inherit',
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else if (code === null) {
            reject(new Error('cockroach sql 被信号终止'))
          } else {
            reject(new Error(`cockroach sql 退出码 ${code}`))
          }
        })
      })
    } else if (options.sql) {
      // 通过标准输入运行内联 SQL
      const args = buildLocalCockroachSqlArgs({
        containerName: name,
        port,
        database: db,
      })

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else if (code === null) {
            reject(new Error('cockroach sql 被信号终止'))
          } else {
            reject(new Error(`cockroach sql 退出码 ${code}`))
          }
        })

        proc.stdin?.write(options.sql)
        proc.stdin?.end()
      })
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  /**
   * 执行 SQL 查询并返回结构化结果
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port, version } = container
    const db = options?.database || container.database || 'defaultdb'

    const cockroach = await this.getCockroachPath(version)

    return new Promise((resolve, reject) => {
      const args = options?.host
        ? (() => {
            const username = options.username || 'root'
            const remoteUrl = new URL(
              `postgresql://${encodeURIComponent(username)}@${options.host}:${port}/${db}`,
            )
            if (options.password) {
              remoteUrl.password = options.password
            }
            remoteUrl.searchParams.set(
              'sslmode',
              options.ssl === false ? 'disable' : 'require',
            )
            return ['sql', '--url', remoteUrl.toString()]
          })()
        : buildLocalCockroachSqlArgs({
            containerName: name,
            port,
            database: db,
            username: options?.username,
            password: options?.password,
          })
      args.push('--execute', query, '--format=csv')

      const proc = spawn(cockroach, args, {
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
          reject(new Error(stderr || `cockroach sql 退出码 ${code}`))
          return
        }

        try {
          resolve(parseCSVToQueryResult(stdout))
        } catch (error) {
          reject(
            new Error(
              `解析查询结果失败：${error instanceof Error ? error.message : error}`,
            ),
          )
        }
      })
    })
  }

  /**
   * 列出所有用户数据库，排除系统数据库（defaultdb、postgres、system）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { name, port, version } = container
    const cockroach = await this.getCockroachPath(version)

    return new Promise((resolve, reject) => {
      const args = buildLocalCockroachSqlArgs({
        containerName: name,
        port,
      })
      args.push('--execute', `SHOW DATABASES`, '--format=csv')

      const proc = spawn(cockroach, args, {
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
          reject(new Error(stderr || `cockroach sql 退出码 ${code}`))
          return
        }

        // 解析 CSV 输出（第一列是 database_name，跳过表头）
        const systemDatabases = ['defaultdb', 'postgres', 'system']
        const lines = stdout.trim().split('\n')
        const databases = lines
          .slice(1) // 跳过表头
          .map((line) => line.split(',')[0].trim())
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
    const { name, port, version } = container
    const db = database || container.database || 'defaultdb'

    validateCockroachIdentifier(username, 'user')
    validateCockroachIdentifier(db, 'database')
    const escapedUser = escapeCockroachIdentifier(username)
    const escapedDb = escapeCockroachIdentifier(db)

    const cockroach = await this.getCockroachPath(version)

    // 本地 CockroachDB 容器启用了 TLS。引导管理员命令
    // 通过生成的客户端证书以 root 身份认证，而最终用户
    // 通过基于密码的认证在 TLS 上连接。
    const escapedPassword = password.replace(/'/g, "''")
    const sql = [
      `CREATE USER IF NOT EXISTS ${escapedUser}`,
      `ALTER USER ${escapedUser} WITH PASSWORD '${escapedPassword}'`,
      `GRANT ALL ON DATABASE ${escapedDb} TO ${escapedUser}`,
      `GRANT ALL ON SCHEMA public TO ${escapedUser}`,
      `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${escapedUser}`,
      `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${escapedUser}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${escapedUser}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${escapedUser}`,
    ].join('; ') + ';'

    const args = buildLocalCockroachSqlArgs({
      containerName: name,
      port,
      database: db,
    })

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`创建用户失败：${stderr}`))
        }
      })
      proc.on('error', reject)

      proc.stdin?.write(sql)
      proc.stdin?.end()
    })

    const connectionString = buildSecureCockroachConnectionString({
      containerName: name,
      port,
      database: db,
      username,
      password,
    })

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

export const cockroachdbEngine = new CockroachDBEngine()