/**
 * QuestDB 引擎实现
 *
 * QuestDB 是一个高性能时序数据库，内置支持通过 PostgreSQL 线协议进行 SQL 查询。
 *
 * 主要特性：
 * - 默认 PostgreSQL 线协议端口：8812
 * - 默认 HTTP 端口：9000（REST API 和 Web 控制台）
 * - 默认 ILP（InfluxDB 行协议）端口：9009
 * - 基于 Java，附带捆绑 JRE（无需单独安装 Java）
 * - 启动脚本：questdb.sh（Unix）或 questdb.exe（Windows）
 * - 默认数据库：qdb（根数据库）
 * - 默认用户：admin（密码：quest）
 * - 查询语言：SQL（含时序扩展）
 * - Web 控制台地址：http://localhost:9000
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { findBinary } from '../../core/dependency-manager'
import { processManager } from '../../core/process-manager'
import { questdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  QUESTDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import { loadLocalQuestAuth } from './auth'
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
} from '../../types'
import { parseCSVToQueryResult } from '../../core/query-parser'

const ENGINE = 'questdb'
const engineDef = getEngineDefaults(ENGINE)

export class QuestDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'QuestDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息，用于二进制文件操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退列表中获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载地址
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本号（例如 '9' -> '9.2.3'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return QUESTDB_VERSION_MAP[version] || version
  }

  // 获取指定版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'questdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 QuestDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    // 同时检查根目录和 bin/ 子目录（不同平台目录结构不同）
    const { platform } = this.getPlatformInfo()
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      return existsSync(exePathRoot) || existsSync(exePathBin)
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      return existsSync(shPathRoot) || existsSync(shPathBin)
    }
  }

  // 检查指定版本的 QuestDB 是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return questdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 QuestDB 二进制文件可用
   * 若尚未安装则从 hostdb 下载
   * 返回安装目录路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await questdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 确保启动脚本具有可执行权限
    await questdbBinaryManager.postExtract(binPath, platform)

    // 在配置中注册启动脚本——同时检查两个可能的位置
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      const exePath = existsSync(exePathRoot) ? exePathRoot : exePathBin
      if (existsSync(exePath)) {
        await configManager.setBinaryPath('questdb', exePath, 'bundled')
      }
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      const shPath = existsSync(shPathRoot) ? shPathRoot : shPathBin
      if (existsSync(shPath)) {
        await configManager.setBinaryPath('questdb', shPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 QuestDB 数据目录
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

    logDebug(`已创建 QuestDB 数据目录：${dataDir}`)

    return dataDir
  }

  // 获取指定版本的 QuestDB 启动脚本路径
  async getQuestDBPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)

    const binPath = paths.getBinaryPath({
      engine: 'questdb',
      version: fullVersion,
      platform,
      arch,
    })

    // 同时检查根目录和 bin/ 子目录（不同平台目录结构不同）
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      if (existsSync(exePathRoot)) return exePathRoot
      if (existsSync(exePathBin)) return exePathBin
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      if (existsSync(shPathRoot)) return shPathRoot
      if (existsSync(shPathBin)) return shPathBin
    }

    throw new Error(
      `QuestDB ${version} 尚未安装。请运行：spindb engines download questdb ${version}`,
    )
  }

  /**
   * 启动 QuestDB 服务
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

    // 获取 QuestDB 二进制文件路径——同时检查根目录和 bin/ 子目录
    let questdbBinary: string | null = null
    const { platform } = this.getPlatformInfo()

    if (binaryPath && existsSync(binaryPath)) {
      if (platform === 'win32') {
        const exePathRoot = join(binaryPath, 'questdb.exe')
        const exePathBin = join(binaryPath, 'bin', 'questdb.exe')
        if (existsSync(exePathRoot)) {
          questdbBinary = exePathRoot
          logDebug(`使用已存储的二进制路径：${questdbBinary}`)
        } else if (existsSync(exePathBin)) {
          questdbBinary = exePathBin
          logDebug(`使用已存储的二进制路径 (bin/)：${questdbBinary}`)
        }
      } else {
        const shPathRoot = join(binaryPath, 'questdb.sh')
        const shPathBin = join(binaryPath, 'bin', 'questdb.sh')
        if (existsSync(shPathRoot)) {
          questdbBinary = shPathRoot
          logDebug(`使用已存储的二进制路径：${questdbBinary}`)
        } else if (existsSync(shPathBin)) {
          questdbBinary = shPathBin
          logDebug(`使用已存储的二进制路径 (bin/)：${questdbBinary}`)
        }
      }
    }

    if (!questdbBinary) {
      try {
        questdbBinary = await this.getQuestDBPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `QuestDB ${version} 尚未安装。请运行：spindb engines download questdb ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'questdb.pid')

    // 计算 HTTP 端口（默认为 PG 端口 + 188，即 8812 + 188 = 9000）
    const httpPort = port + 188

    onProgress?.({ stage: 'starting', message: '正在启动 QuestDB...' })

    logDebug(`正在启动 QuestDB，数据目录：${dataDir}`)

    const isWindows = platform === 'win32'

    // QuestDB 启动命令
    // Windows：questdb.exe 不支持可靠的 'start' 子命令（GitHub #1222）
    //          直接运行，不带 'start' 命令——以交互/前台模式启动
    // Unix：questdb.sh start -d ... -t ... -n 可正确以守护进程模式运行
    // -t tag：唯一进程标签，允许同时运行多个 QuestDB 实例
    //         若不设置此参数，QuestDB 会通过进程标签检测其他实例并拒绝启动
    const args = isWindows
      ? ['-d', dataDir, '-t', name] // Windows：不带 'start' 命令，不带 '-n' 参数
      : ['start', '-d', dataDir, '-t', name, '-n'] // Unix：完整守护进程模式

    // QuestDB 配置环境变量
    // 注意：不要设置 QDB_LOG_W_FILE_LOCATION——QuestDB 期望使用含 $ 的滚动日志模式
    // 日志默认写入 dataDir/log/ 目录
    //
    // 基于基础 PostgreSQL 端口的端口偏移：
    // - HTTP 服务：+188（默认 9000）
    // - HTTP Min 服务：+191（默认 9003）——用于健康检查/指标
    // - ILP TCP：+197（默认 9009）
    const env = {
      ...process.env,
      QDB_HTTP_BIND_TO: `${container.bindAddress ?? '0.0.0.0'}:${httpPort}`,
      QDB_HTTP_MIN_NET_BIND_TO: `${container.bindAddress ?? '0.0.0.0'}:${port + 191}`, // HTTP Min 服务（健康检查/指标）
      QDB_PG_NET_BIND_TO: `${container.bindAddress ?? '0.0.0.0'}:${port}`,
      QDB_LINE_TCP_NET_BIND_TO: `${container.bindAddress ?? '0.0.0.0'}:${port + 197}`, // ILP 端口
    }

    // 重要：所有 stdio 使用 'ignore' 以防止进程挂起
    // QuestDB 以守护进程方式运行，我们不需要保持文件描述符打开
    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      env,
      windowsHide: true,
    }

    logDebug(`正在生成 QuestDB 进程：${questdbBinary} ${args.join(' ')}`)

    const proc = spawn(questdbBinary, args, spawnOptions)

    // 允许进程立即分离
    // 注意：此处不写入 PID 文件，因为 questdb.sh 会 fork Java
    // 进程后退出。Shell 的 PID 在几毫秒内就会失效。
    // QuestDB 会将自己的 PID 文件写入 {dataDir}/questdb.pid，
    // 我们将在等待服务器就绪后读取该文件。
    proc.unref()

    // 等待服务器就绪
    const timeout = isWindows ? 150000 : 120000
    logDebug(
      `正在等待 QuestDB 在端口 ${port} 上就绪...（超时：${timeout}ms）`,
    )

    // 给 QuestDB 一点时间启动，然后再检查
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const ready = await this.waitForReady(port, version, timeout)
    logDebug(`waitForReady 返回结果：${ready}`)

    if (!ready) {
      // 启动失败时清理——尝试通过端口查找并终止 QuestDB 进程
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          logDebug(`正在清理启动失败的 QuestDB 进程（PID：${pids[0]}）`)
          await platformService.terminateProcess(pids[0], true)
        }
      } catch {
        // 忽略清理错误
      }
      throw new Error(
        `QuestDB 在超时时间内未能启动。请检查日志：${dataDir}/log/`,
      )
    }

    // QuestDB 已就绪——通过端口查找实际的 Java 进程 PID
    // QuestDB 在守护进程模式下不会创建 PID 文件，因此通过端口查找进程
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        const actualPid = pids[0]
        await writeFile(pidFile, actualPid.toString(), 'utf-8')
        logDebug(`已写入 PID 文件：${pidFile}（PID：${actualPid}）`)
      } else {
        logDebug(
          '无法通过端口找到 QuestDB 进程——未创建 PID 文件',
        )
      }
    } catch (err) {
      logDebug(
        `无法获取 QuestDB PID：${err instanceof Error ? err.message : String(err)}`,
      )
      // 不抛出异常——QuestDB 正在运行，只是无法跟踪其 PID
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // 通过 HTTP 健康检查等待 QuestDB 就绪
  // 优先使用 HTTP 而非 psql，因为 HTTP 不需要认证，
  // 因此无论配置了什么凭据都能正常工作
  private async waitForReady(
    port: number,
    _version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady 已调用，端口 ${port}`)
    return this.waitForReadyHttp(port + 188, timeoutMs)
  }

  private async waitForReadyHttp(
    httpPort: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${httpPort}/exec?query=SELECT%201`,
        )
        if (response.ok) {
          logDebug(`QuestDB HTTP 已在端口 ${httpPort} 上就绪`)
          return true
        }
      } catch {
        // 尚未就绪
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    return false
  }

  /**
   * 停止 QuestDB 服务
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'questdb.pid')

    logDebug(`正在停止 QuestDB 容器 "${name}"，端口 ${port}`)

    // 优先通过端口查找进程（最可靠的方式）
    // QuestDB 不会创建 PID 文件，因此端口查找是主要手段
    let pid: number | null = null
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        pid = pids[0]
      }
    } catch {
      // 回退到我们的 PID 文件
      try {
        const pidStr = await readFile(pidFile, 'utf-8')
        const parsedPid = parseInt(pidStr.trim(), 10)
        if (!isNaN(parsedPid)) {
          pid = parsedPid
        }
      } catch {
        // 忽略
      }
    }

    // 如果找到进程则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 QuestDB 进程 ${pid}`)
      const { platform } = this.getPlatformInfo()
      const isWindows = platform === 'win32'

      try {
        await platformService.terminateProcess(pid, false)
        // 等待优雅终止——Windows 上 Java 释放文件锁需要更多时间
        const gracefulWait = isWindows ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，强制终止进程 ${pid}`)
          await platformService.terminateProcess(pid, true)
          // Windows 上强制终止后的额外等待
          if (isWindows) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    // 清理我们的 PID 文件
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // 忽略
      }
    }

    logDebug('QuestDB 已停止')
  }

  // 获取 QuestDB 服务状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port } = container

    // 优先尝试 HTTP 健康检查
    const httpPort = port + 188
    try {
      const response = await fetch(
        `http://127.0.0.1:${httpPort}/exec?query=SELECT%201`,
      )
      if (response.ok) {
        return { running: true, message: 'QuestDB 正在运行' }
      }
    } catch {
      // 未运行或未响应
    }

    return { running: false, message: 'QuestDB 未在运行' }
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
      database: options.database || container.database || 'qdb',
      version,
      clean: options.clean,
    })
  }

  /**
   * 获取连接字符串
   * 格式：postgresql://admin:quest@127.0.0.1:端口/数据库名
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'qdb'
    return `postgresql://admin:quest@127.0.0.1:${port}/${db}`
  }

  // 打开 psql 交互式终端
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'qdb'
    const auth = await loadLocalQuestAuth(container.name)

    // 查找 psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          '未找到 psql。请安装 PostgreSQL 客户端工具，或使用 Web 控制台：' +
            `http://127.0.0.1:${port + 188}`,
        )
      }
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      env: { ...process.env, PGPASSWORD: auth.password },
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        psqlPath!,
        ['-h', '127.0.0.1', '-p', String(port), '-U', auth.user, '-d', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * 注意：QuestDB 采用单数据库模型，但支持 schema
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    logDebug(
      `QuestDB 采用单数据库模型。数据库 "${database}" 将作为 schema 创建。`,
    )
    // QuestDB 没有传统的 CREATE DATABASE 命令
    // 所有表都存在于默认数据库中
  }

  /**
   * 删除数据库（在 QuestDB 中为 schema）
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    logDebug(
      `QuestDB 采用单数据库模型。无法删除数据库 "${database}"。`,
    )
  }

  /**
   * 获取数据库大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })
    if (!existsSync(dataDir)) return null

    try {
      let totalSize = 0
      const entries = await readdir(dataDir, {
        withFileTypes: true,
        recursive: true,
      })
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = join(entry.parentPath ?? dataDir, entry.name)
          const stats = await stat(filePath)
          totalSize += stats.size
        }
      }
      return totalSize
    } catch {
      return null
    }
  }

  /**
   * 从远程 QuestDB 连接导出数据
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { host, port, database, user, password } =
      parseConnectionString(connectionString)

    logDebug(
      `正在连接远程 QuestDB：${host}:${port}（数据库：${database}）`,
    )

    // 查找用于远程操作的 psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          '未找到 psql。请安装 PostgreSQL 客户端工具以从远程 QuestDB 导出数据。',
        )
      }
    }

    const lines: string[] = []
    lines.push('-- QuestDB 备份，由 SpinDB 生成')
    lines.push(`-- 来源：${host}:${port}`)
    lines.push(`-- 数据库：${database}`)
    lines.push(`-- 日期：${new Date().toISOString()}`)
    lines.push('')

    // 获取表列表
    const tablesQuery = `SELECT table_name FROM tables() WHERE table_name NOT LIKE 'sys.%'`
    const tablesResult = await this.execRemoteQuery(
      psqlPath,
      host,
      port,
      user,
      password ?? '',
      database,
      tablesQuery,
    )
    const tables = tablesResult.split('\n').filter((t) => t.trim())

    logDebug(`找到 ${tables.length} 张表`)

    for (const table of tables) {
      if (!table.trim()) continue

      lines.push(`-- 表：${table}`)
      lines.push('')

      try {
        const createQuery = `SHOW CREATE TABLE "${table}"`
        const createResult = await this.execRemoteQuery(
          psqlPath,
          host,
          port,
          user,
          password ?? '',
          database,
          createQuery,
        )
        if (createResult) {
          lines.push(createResult + ';')
          lines.push('')
        }
      } catch (error) {
        logWarning(`无法获取 ${table} 的 CREATE TABLE 语句：${error}`)
      }
    }

    const content = lines.join('\n')
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        tables.length === 0 ? ['数据库中未找到任何表'] : undefined,
    }
  }

  private async execRemoteQuery(
    psqlPath: string,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    query: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-h',
        host,
        '-p',
        String(port),
        '-U',
        user,
        '-d',
        database,
        '-t',
        '-A',
        '-c',
        query,
      ]

      const proc = spawn(psqlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: password },
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
          resolve(stdout.trim())
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
    const { port } = container
    const db = options.database || container.database || 'qdb'
    const auth = await loadLocalQuestAuth(container.name)

    // 查找 psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error('未找到 psql。请安装 PostgreSQL 客户端工具。')
      }
    }

    if (options.file) {
      // 运行 SQL 文件
      const args = [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        auth.user,
        '-d',
        db,
        '-f',
        options.file,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(psqlPath!, args, {
          stdio: 'inherit',
          env: { ...process.env, PGPASSWORD: auth.password },
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`psql 以退出码 ${code} 结束`))
          }
        })
      })
    } else if (options.sql) {
      // 运行内联 SQL
      const args = [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        auth.user,
        '-d',
        db,
        '-c',
        options.sql,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(psqlPath!, args, {
          stdio: 'inherit',
          env: { ...process.env, PGPASSWORD: auth.password },
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`psql 以退出码 ${code} 结束`))
          }
        })
      })
    } else {
      throw new Error('必须提供 file 或 sql 参数')
    }
  }

  /**
   * 执行 SQL 查询并返回结构化结果
   * 通过 psql 使用 PostgreSQL 线协议
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'qdb'
    const defaultAuth = await loadLocalQuestAuth(container.name)
    const auth = {
      user: options?.username || defaultAuth.user,
      password: options?.password || defaultAuth.password,
    }

    // 查找 psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          '未找到 psql。请安装 PostgreSQL 客户端工具或使用 Web 控制台。',
        )
      }
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-X', // 跳过 ~/.psqlrc 以确保 CSV 输出的一致性
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        auth.user,
        '-d',
        db,
        '--csv',
        '-c',
        query,
      ]

      const proc = spawn(psqlPath!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: auth.password },
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
          reject(new Error(stderr || `psql 以退出码 ${code} 结束`))
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
   * 列出 QuestDB 的数据库。
   * QuestDB 只有一个数据库 'qdb'。返回已配置的数据库。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // QuestDB 只有一个数据库 'qdb'
    // 返回容器已配置的数据库
    return [container.database]
  }
}

export const questdbEngine = new QuestDBEngine()
