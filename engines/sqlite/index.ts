/**
 * SQLite 引擎
 *
 * SQLite 是基于文件的嵌入式数据库，无服务端进程。
 * 与 PostgreSQL/MySQL 的主要区别：
 * - 无启动/停止操作（基于文件）
 * - 无端口管理
 * - 数据库文件默认存储在 ~/.spindb/containers/sqlite/<name>/ 目录下
 * - 使用注册表追踪文件路径
 *
 * 二进制文件来源：
 * - 从 hostdb 下载 sqlite3 及相关工具
 * - 包含：sqlite3、sqldiff、sqlite3_analyzer、sqlite3_rsync
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, createWriteStream, createReadStream } from 'fs'
import { copyFile, unlink, mkdir, open, writeFile } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { BaseEngine } from '../base-engine'
import { sqliteRegistry } from './registry'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { sqliteBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { SUPPORTED_MAJOR_VERSIONS, normalizeVersion } from './version-maps'
import { fetchAvailableVersions } from './hostdb-releases'
import { logDebug } from '../../core/error-handler'
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

const execFileAsync = promisify(execFile)

export class SQLiteEngine extends BaseEngine {
  name = 'sqlite'
  displayName = 'SQLite'
  defaultPort = 0 // 基于文件，无需端口
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取从 hostdb 下载 SQLite 二进制文件的 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  async verifyBinary(): Promise<boolean> {
    return this.isBinaryInstalled('3')
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = platformService.getPlatformInfo()
    return sqliteBinaryManager.isInstalled(version, platform, arch)
  }

  // 确保 SQLite 二进制文件已从 hostdb 下载并注册工具
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = platformService.getPlatformInfo()

    // 从 hostdb 下载
    const binPath = await sqliteBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册所有 SQLite 工具
    const ext = platformService.getExecutableExtension()
    const tools = [
      'sqlite3',
      'sqldiff',
      'sqlite3_analyzer',
      'sqlite3_rsync',
    ] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  // 获取 sqlite3 二进制文件的路径 - 优先检查已下载的二进制文件
  override async getSqlite3Path(version?: string): Promise<string | null> {
    // 先检查配置管理器（已下载二进制文件的缓存路径）
    const configPath = await configManager.getBinaryPath('sqlite3')
    if (configPath && existsSync(configPath)) {
      return configPath
    }

    // 如果提供了版本号，直接检查已下载的二进制文件路径
    if (version) {
      const { platform, arch } = platformService.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'sqlite',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const sqlite3Path = join(binPath, 'bin', `sqlite3${ext}`)
      if (existsSync(sqlite3Path)) {
        return sqlite3Path
      }
    }

    // 未找到 - 需要下载
    return null
  }

  async getLitecliPath(): Promise<string | null> {
    // 先检查配置管理器
    const configPath = await configManager.getBinaryPath('litecli')
    if (configPath) {
      return configPath
    }

    // 使用平台服务搜索系统 PATH（适用于 Windows、macOS、Linux）
    return platformService.findToolPath('litecli')
  }

  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    // 确定文件路径 - 默认使用容器目录（而非当前工作目录）
    const pathOption = options.path as string | undefined
    const filePath =
      pathOption ||
      join(
        paths.getContainerPath(containerName, { engine: 'sqlite' }),
        `${containerName}.sqlite`,
      )
    const absolutePath = resolve(filePath)

    // 确保父目录存在
    const dir = dirname(absolutePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // 检查文件是否已存在
    if (existsSync(absolutePath)) {
      throw new Error(`文件已存在：${absolutePath}`)
    }

    // 检查该路径是否已被注册
    if (await sqliteRegistry.isPathRegistered(absolutePath)) {
      throw new Error(`路径已被注册：${absolutePath}`)
    }

    // 通过执行简单查询创建空数据库
    const sqlite3 = await this.requireSqlite3Path()

    await execFileAsync(sqlite3, [absolutePath, 'SELECT 1'])

    // 注册到 SQLite 注册表
    await sqliteRegistry.add({
      name: containerName,
      filePath: absolutePath,
      created: new Date().toISOString(),
    })

    return absolutePath
  }

  // 对于 SQLite 而言，start 为空操作（基于文件，无服务端）。
  async start(
    container: ContainerConfig,
    _onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `SQLite 容器 "${container.name}" 在注册表中未找到`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite 数据库文件未找到：${entry.filePath}`)
    }

    return {
      port: 0,
      connectionString: this.getConnectionString(container),
    }
  }

  // 对于 SQLite 而言，stop 为空操作（基于文件，无服务端）。
  async stop(_container: ContainerConfig): Promise<void> {}

  async status(container: ContainerConfig): Promise<StatusResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      return {
        running: false,
        message: '未在 SQLite 注册表中注册',
      }
    }
    if (!existsSync(entry.filePath)) {
      return {
        running: false,
        message: `文件未找到：${entry.filePath}`,
      }
    }
    return {
      running: true,
      message: '数据库文件存在',
    }
  }

  getConnectionString(container: ContainerConfig, _database?: string): string {
    // container.database 存储 SQLite 的文件路径
    const filePath = container.database
    return `sqlite:///${filePath}`
  }

  // 优先使用 litecli（如果可用），否则回退到 sqlite3。
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `SQLite 容器 "${container.name}" 在注册表中未找到`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite 数据库文件未找到：${entry.filePath}`)
    }

    // 优先尝试 litecli，回退到 sqlite3
    const litecli = await this.getLitecliPath()
    const cmd = litecli ?? (await this.requireSqlite3Path())

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [entry.filePath], { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  // 对于 SQLite，文件本身就是数据库。
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {}

  async dropDatabase(
    container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (entry && existsSync(entry.filePath)) {
      await unlink(entry.filePath)
    }
    await sqliteRegistry.remove(container.name)
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      return null
    }
    const stats = statSync(entry.filePath)
    return stats.size
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    if (filePath.endsWith('.sql')) {
      return {
        format: 'sql',
        description: 'SQLite SQL 导出文件',
        restoreCommand: 'sqlite3 <db> < <file>',
      }
    }
    return {
      format: 'sqlite',
      description: 'SQLite 数据库文件（二进制副本）',
      restoreCommand: 'cp <file> <db>',
    }
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite 数据库文件未找到')
    }

    if (options.format === 'sql') {
      // 使用 .dump 命令导出 SQL 格式
      const sqlite3 = await this.requireSqlite3Path()

      // 将 .dump 输出管道到文件（避免 Shell 注入）
      await this.dumpToFile(sqlite3, entry.filePath, outputPath)
    } else {
      // 二进制格式直接复制文件
      await copyFile(entry.filePath, outputPath)
    }

    const stats = statSync(outputPath)
    return {
      path: outputPath,
      format: options.format ?? 'binary',
      size: stats.size,
    }
  }

  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options?: Record<string, unknown>,
  ): Promise<RestoreResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(`容器 "${container.name}" 未注册`)
    }

    const format = await this.detectBackupFormat(backupPath)

    if (format.format === 'sql') {
      // 还原 SQL 导出文件
      const sqlite3 = await this.requireSqlite3Path()

      // 将文件管道到 sqlite3 的标准输入（避免 Shell 注入）
      await this.runSqlFile(sqlite3, entry.filePath, backupPath)
      return { format: 'sql' }
    } else {
      // 二进制文件复制
      await copyFile(backupPath, entry.filePath)
      return { format: 'sqlite' }
    }
  }

  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    let filePath = connectionString
    let tempFile: string | null = null

    // 处理 HTTP/HTTPS URL - 下载到临时文件
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      tempFile = join(tmpdir(), `spindb-download-${Date.now()}.sqlite`)
      await this.downloadFile(filePath, tempFile)

      // 校验是否为有效的 SQLite 数据库
      if (!(await this.isValidSqliteFile(tempFile))) {
        await unlink(tempFile)
        throw new Error('下载的文件不是有效的 SQLite 数据库')
      }

      filePath = tempFile
    }
    // 处理 sqlite:// URL（去除前缀获取本地文件路径）
    else if (filePath.startsWith('sqlite:///')) {
      filePath = filePath.slice('sqlite:///'.length)
    } else if (filePath.startsWith('sqlite://')) {
      filePath = filePath.slice('sqlite://'.length)
    }

    // 验证本地文件是否存在
    if (!existsSync(filePath)) {
      throw new Error(`SQLite 数据库文件未找到：${filePath}`)
    }

    const sqlite3 = await this.requireSqlite3Path()

    try {
      // 将 .dump 输出管道到文件（避免 Shell 注入）
      await this.dumpToFile(sqlite3, filePath, outputPath)

      return { filePath: outputPath }
    } finally {
      // 清理已下载的临时文件（即使出错也清理）
      if (tempFile && existsSync(tempFile)) {
        await unlink(tempFile)
      }
    }
  }

  // 使用 spawn 避免 Shell 注入。
  private async dumpToFile(
    sqlite3Path: string,
    dbPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const proc = spawn(sqlite3Path, [dbPath, '.dump'])

      proc.stdout.pipe(output)

      proc.stderr.on('data', (data: Buffer) => {
        // 收集 stderr 但不立即失败 - sqlite3 可能输出警告
        console.error(data.toString())
      })

      proc.on('error', (err) => {
        output.close()
        reject(err)
      })

      proc.on('close', (code) => {
        output.close()
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`sqlite3 导出失败，退出码为 ${code}`))
        }
      })
    })
  }

  // 通过标准输入将 SQL 文件流式写入 SQLite 数据库
  private async runSqlFile(
    sqlite3Path: string,
    dbPath: string,
    sqlFilePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 对 stdout 使用 'ignore'，因为不需要输出，且不消费可能导致缓冲区填满并造成死锁
      const proc = spawn(sqlite3Path, [dbPath], {
        stdio: ['pipe', 'ignore', 'pipe'],
      })

      let stderrData = ''
      let streamError: Error | null = null

      proc.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString()
      })

      proc.on('error', (err) => {
        reject(err)
      })

      proc.on('close', (code) => {
        // 如果有流错误，报告它
        if (streamError) {
          reject(streamError)
          return
        }

        if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              `sqlite3 执行失败，退出码为 ${code}${stderrData ? `：${stderrData}` : ''}`,
            ),
          )
        }
      })

      // 处理 stdin 错误（进程提前退出时可能产生 EPIPE）
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          reject(err)
        }
      })

      // 将 SQL 文件流式传输到 sqlite3 的标准输入
      const fileStream = createReadStream(sqlFilePath, { encoding: 'utf-8' })

      fileStream.on('error', (error) => {
        streamError = new Error(`读取 SQL 文件失败：${error.message}`)
        fileStream.destroy()
        proc.stdin.end()
      })

      fileStream.pipe(proc.stdin)
    })
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = 5 * 60 * 1000 // 5 分钟
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `文件未找到（404）：${url}。` +
              `该版本可能已从 hostdb 中移除。` +
              `请尝试其他版本或访问 https://registry.layerbase.host 查看。`,
          )
        }
        throw new Error(
          `下载失败：${response.status} ${response.statusText}`,
        )
      }

      const buffer = await response.arrayBuffer()
      await writeFile(destPath, Buffer.from(buffer))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('下载超时（5 分钟）')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  // SQLite 文件以 "SQLite format 3\0"（前 16 字节）开头。
  private async isValidSqliteFile(filePath: string): Promise<boolean> {
    try {
      const buffer = Buffer.alloc(16)
      const fd = await open(filePath, 'r')
      await fd.read(buffer, 0, 16, 0)
      await fd.close()
      // 检查 SQLite 魔数文件头
      return buffer.toString('utf8', 0, 15) === 'SQLite format 3'
    } catch {
      return false
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite 数据库文件未找到')
    }

    const sqlite3 = await this.requireSqlite3Path()

    if (options.file) {
      // 运行 SQL 文件 - 将文件管道到标准输入（避免 Shell 注入）
      await this.runSqlFile(sqlite3, entry.filePath, options.file)
    } else if (options.sql) {
      // 运行内联 SQL - 作为参数传入，输出到 stdout
      const { stdout, stderr } = await execFileAsync(sqlite3, [
        entry.filePath,
        options.sql,
      ])
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('必须提供 file 或 sql 参数')
    }
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  // 辅助方法：获取 sqlite3 路径，若未找到则抛出提示性错误
  private async requireSqlite3Path(): Promise<string> {
    const sqlite3 = await this.getSqlite3Path()
    if (!sqlite3) {
      throw new Error(
        '未找到 sqlite3。请确保已下载 SQLite 二进制文件：\n' +
          '  spindb engines download sqlite',
      )
    }
    return sqlite3
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite 数据库文件未找到')
    }

    const sqlite3 = await this.requireSqlite3Path()

    // 使用 spawn 而非 execFileAsync，以便流式处理结果
    return new Promise((resolve, reject) => {
      const proc = spawn(sqlite3, ['-csv', '-header', entry.filePath, query])

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
          reject(new Error(stderr || `sqlite3 退出，退出码为 ${code}`))
          return
        }
        if (stderr) {
          logDebug(`SQLite stderr：${stderr}`)
        }
        resolve(parseCSVToQueryResult(stdout))
      })
    })
  }

  /**
   * 列出 SQLite 的数据库。
   * SQLite 基于文件，每个文件对应一个数据库。
   * 将已配置的数据库（文件路径）作为单元素数组返回。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // SQLite 基于文件，每个文件对应一个数据库
    return [container.database]
  }
}

export const sqliteEngine = new SQLiteEngine()