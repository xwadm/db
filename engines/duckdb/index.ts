/**
 * DuckDB 引擎
 *
 * DuckDB 是一款基于文件的嵌入式 OLAP 数据库，无需服务端进程。
 * 与 PostgreSQL/MySQL 的主要区别：
 * - 无需启动/停止操作（基于文件）
 * - 无需端口管理
 * - 数据库文件默认存储在 ~/.spindb/containers/duckdb/<name>/
 * - 使用注册表来追踪文件路径
 *
 * 二进制来源：
 * - 从 hostdb 下载 duckdb 命令行工具
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, createWriteStream, createReadStream } from 'fs'
import { copyFile, unlink, mkdir, open, writeFile } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { BaseEngine } from '../base-engine'
import { duckdbRegistry } from './registry'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { duckdbBinaryManager } from './binary-manager'
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

export class DuckDBEngine extends BaseEngine {
  name = 'duckdb'
  displayName = 'DuckDB'
  defaultPort = 0 // 基于文件，无需端口
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 从 hostdb 获取 DuckDB 二进制的下载链接
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  async verifyBinary(): Promise<boolean> {
    return this.isBinaryInstalled('1')
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = platformService.getPlatformInfo()
    return duckdbBinaryManager.isInstalled(version, platform, arch)
  }

  // 确保从 hostdb 下载 DuckDB 二进制并注册工具路径
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = platformService.getPlatformInfo()

    // 从 hostdb 下载
    const binPath = await duckdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册所有的 DuckDB 工具
    const ext = platformService.getExecutableExtension()
    const tools = ['duckdb'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  // 获取 duckdb 二进制路径 - 优先检查已下载的二进制
  override async getDuckDBPath(version?: string): Promise<string | null> {
    // 先检查配置管理器（已下载二进制的缓存路径）
    const configPath = await configManager.getBinaryPath('duckdb')
    if (configPath && existsSync(configPath)) {
      return configPath
    }

    // 若提供了版本号，直接检查已下载的二进制路径
    if (version) {
      const { platform, arch } = platformService.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'duckdb',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const duckdbPath = join(binPath, 'bin', `duckdb${ext}`)
      if (existsSync(duckdbPath)) {
        return duckdbPath
      }
    }

    // 未找到 - 需要下载
    return null
  }

  async initDataDir(
    containerName: string,
    version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    // 确定文件路径 - 默认使用容器目录（而非当前工作目录）
    const pathOption = options.path as string | undefined
    const filePath =
      pathOption ||
      join(
        paths.getContainerPath(containerName, { engine: 'duckdb' }),
        `${containerName}.duckdb`,
      )
    const absolutePath = resolve(filePath)

    // 确保父目录存在
    const dir = dirname(absolutePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // 检查文件是否已存在
    if (existsSync(absolutePath)) {
      throw new Error(`文件已存在: ${absolutePath}`)
    }

    // 检查该路径是否已被注册
    if (await duckdbRegistry.isPathRegistered(absolutePath)) {
      throw new Error(`路径已被注册: ${absolutePath}`)
    }

    // 通过执行简单查询来创建空数据库
    const duckdb = await this.requireDuckDBPath(version)

    await execFileAsync(duckdb, [absolutePath, '-c', 'SELECT 1'])

    // 注册到 DuckDB 注册表
    await duckdbRegistry.add({
      name: containerName,
      filePath: absolutePath,
      created: new Date().toISOString(),
    })

    return absolutePath
  }

  // DuckDB 无需启动操作（基于文件，无服务端进程）
  async start(
    container: ContainerConfig,
    _onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `DuckDB 容器 "${container.name}" 未在注册表中找到`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`DuckDB 数据库文件未找到: ${entry.filePath}`)
    }

    return {
      port: 0,
      connectionString: this.getConnectionString(container),
    }
  }

  // DuckDB 无需停止操作（基于文件，无服务端进程）
  async stop(_container: ContainerConfig): Promise<void> {}

  async status(container: ContainerConfig): Promise<StatusResult> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      return {
        running: false,
        message: '未在 DuckDB 注册表中注册',
      }
    }
    if (!existsSync(entry.filePath)) {
      return {
        running: false,
        message: `文件未找到: ${entry.filePath}`,
      }
    }
    return {
      running: true,
      message: '数据库文件存在',
    }
  }

  getConnectionString(container: ContainerConfig, _database?: string): string {
    // container.database 保存的是 DuckDB 的文件路径
    const filePath = container.database
    return `duckdb:///${filePath}`
  }

  // 打开交互式 duckdb 命令行
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `DuckDB 容器 "${container.name}" 未在注册表中找到`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`DuckDB 数据库文件未找到: ${entry.filePath}`)
    }

    const cmd = await this.requireDuckDBPath()

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [entry.filePath], { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  // 在 DuckDB 中，文件即数据库本身
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {}

  async dropDatabase(
    container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (entry && existsSync(entry.filePath)) {
      await unlink(entry.filePath)
    }
    await duckdbRegistry.remove(container.name)
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const entry = await duckdbRegistry.get(container.name)
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
        description: 'DuckDB SQL 导出文件',
        restoreCommand: 'duckdb <db> < <file>',
      }
    }
    return {
      format: 'duckdb',
      description: 'DuckDB 数据库文件（二进制拷贝）',
      restoreCommand: 'cp <file> <db>',
    }
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('DuckDB 数据库文件未找到')
    }

    if (options.format === 'sql') {
      // SQL 格式使用 EXPORT DATABASE
      const duckdb = await this.requireDuckDBPath()

      // DuckDB 导出到目录，这里需要用查询来导出 schema 和数据
      await this.dumpToFile(duckdb, entry.filePath, outputPath)
    } else {
      // 二进制格式直接拷贝文件
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
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(`容器 "${container.name}" 未注册`)
    }

    const format = await this.detectBackupFormat(backupPath)

    if (format.format === 'sql') {
      // 还原 SQL 导出文件
      const duckdb = await this.requireDuckDBPath()

      // 将文件通过标准输入传入 duckdb（避免 shell 注入）
      await this.runSqlFile(duckdb, entry.filePath, backupPath)
      return { format: 'sql' }
    } else {
      // 二进制文件拷贝
      await copyFile(backupPath, entry.filePath)
      return { format: 'duckdb' }
    }
  }

  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    let filePath = connectionString
    let tempFile: string | null = null

    // 处理 HTTP/HTTPS 链接 - 下载到临时文件
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      tempFile = join(tmpdir(), `spindb-download-${Date.now()}.duckdb`)
      await this.downloadFile(filePath, tempFile)

      // 校验是否为有效的 DuckDB 数据库文件
      if (!(await this.isValidDuckDBFile(tempFile))) {
        await unlink(tempFile)
        throw new Error('下载的文件不是有效的 DuckDB 数据库文件')
      }

      filePath = tempFile
    }
    // 处理 duckdb:// 链接（去掉前缀以获取本地文件路径）
    else if (filePath.startsWith('duckdb:///')) {
      filePath = filePath.slice('duckdb:///'.length)
    } else if (filePath.startsWith('duckdb://')) {
      filePath = filePath.slice('duckdb://'.length)
    }

    // 验证本地文件是否存在
    if (!existsSync(filePath)) {
      throw new Error(`DuckDB 数据库文件未找到: ${filePath}`)
    }

    const duckdb = await this.requireDuckDBPath()

    try {
      // 导出到文件（避免 shell 注入）
      await this.dumpToFile(duckdb, filePath, outputPath)

      return { filePath: outputPath }
    } finally {
      // 清理临时文件（即使出错也要清理）
      if (tempFile && existsSync(tempFile)) {
        await unlink(tempFile)
      }
    }
  }

  /**
   * 将 DuckDB 数据库导出为 SQL 文件。
   *
   * 采用两步方案：
   * 1. 获取 schema（CREATE TABLE 语句）
   * 2. 对每张表输出 INSERT 语句
   *
   * 使用 spawn 以避免 shell 注入。
   */
  private async dumpToFile(
    duckdbPath: string,
    dbPath: string,
    outputPath: string,
  ): Promise<void> {
    // 第一步：获取表列表
    const tablesResult = await execFileAsync(duckdbPath, [
      dbPath,
      '-csv',
      '-noheader',
      '-c',
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'",
    ])
    const tables = tablesResult.stdout
      .trim()
      .split('\n')
      .filter((t) => t.length > 0)

    // 第二步：构建导出脚本 - 先 schema，再每张表的数据
    const dumpCommands = [
      '.schema', // 输出 CREATE TABLE 语句
    ]

    for (const table of tables) {
      // 给表名加引号并转义内嵌的双引号
      const escapedTable = table.replace(/"/g, '""')
      // 为每张表设置 insert 模式
      dumpCommands.push(`.mode insert ${escapedTable}`)
      dumpCommands.push(`SELECT * FROM "${escapedTable}";`)
    }

    const dumpScript = dumpCommands.join('\n')

    // 第三步：执行导出脚本并写入文件
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const proc = spawn(duckdbPath, [dbPath])
      let rejected = false

      const rejectOnce = (err: Error) => {
        if (!rejected) {
          rejected = true
          output.close()
          reject(err)
        }
      }

      // 将标准输出导入文件并处理错误
      proc.stdout.pipe(output)
      proc.stdout.on('error', (err) => {
        rejectOnce(new Error(`标准输出错误: ${err.message}`))
      })
      output.on('error', (err) => {
        rejectOnce(new Error(`输出文件错误: ${err.message}`))
      })

      // 处理标准输入错误（如子进程提前退出导致的 EPIPE）
      proc.stdin.on('error', (err) => {
        rejectOnce(new Error(`标准输入错误: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        // 记录标准错误输出但不视为失败（警告很常见）
        logDebug('duckdb dump stderr', { message: data.toString() })
      })

      proc.on('error', (err) => {
        rejectOnce(err)
      })

      proc.on('close', (code) => {
        output.close()
        if (!rejected) {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`duckdb 导出失败，退出码: ${code}`))
          }
        }
      })

      // 将导出脚本写入标准输入，处理背压
      const writeOk = proc.stdin.write(dumpScript)
      if (writeOk) {
        proc.stdin.end()
      } else {
        // 处理背压：等待 drain 事件后再结束
        proc.stdin.once('drain', () => {
          proc.stdin.end()
        })
      }
    })
  }

  // 将 SQL 文件通过标准输入导入 DuckDB 数据库
  private async runSqlFile(
    duckdbPath: string,
    dbPath: string,
    sqlFilePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 标准输出设为 'ignore'，因为不需要输出且不消费会填满缓冲区导致死锁
      const proc = spawn(duckdbPath, [dbPath], {
        stdio: ['pipe', 'ignore', 'pipe'],
      })

      let stderrData = ''
      let rejected = false

      const rejectOnce = (err: Error) => {
        if (!rejected) {
          rejected = true
          reject(err)
        }
      }

      // 处理标准输入错误（如子进程提前退出导致的 EPIPE）
      proc.stdin.on('error', (err) => {
        rejectOnce(new Error(`标准输入错误: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString()
      })

      proc.on('error', (err) => {
        rejectOnce(err)
      })

      proc.on('close', (code) => {
        if (!rejected) {
          if (code === 0) {
            resolve()
          } else {
            reject(
              new Error(
                `duckdb 执行失败，退出码: ${code}${stderrData ? `: ${stderrData}` : ''}`,
              ),
            )
          }
        }
      })

      // 将 SQL 文件流式传入 duckdb 标准输入
      const fileStream = createReadStream(sqlFilePath, { encoding: 'utf-8' })

      fileStream.on('error', (error) => {
        rejectOnce(new Error(`读取 SQL 文件失败: ${error.message}`))
        fileStream.destroy()
        proc.stdin.end()
      })

      fileStream.pipe(proc.stdin)
    })
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = 5 * 60 * 1000 // 5 分钟超时
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `文件未找到 (404): ${url}。` +
              `该版本可能已从 hostdb 中移除。` +
              `请尝试其他版本或访问 https://registry.layerbase.host 查看`,
          )
        }
        throw new Error(
          `下载失败: ${response.status} ${response.statusText}`,
        )
      }

      const buffer = await response.arrayBuffer()
      await writeFile(destPath, Buffer.from(buffer))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('下载超时（超过5分钟）')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 验证文件是否为有效 DuckDB 数据库文件。
   *
   * DuckDB 文件有特定的二进制头部。检查规则：
   * 1. 文件非空且达到最小体积（DuckDB 文件至少 4KB）
   * 2. 文件头部字节不是 ASCII 文本（排除 SQL 文件）
   * 3. 尝试执行简单查询以验证是否为有效数据库
   */
  private async isValidDuckDBFile(filePath: string): Promise<boolean> {
    try {
      // 检查最小文件体积（DuckDB 数据库至少几 KB）
      const stats = statSync(filePath)
      if (stats.size < 4096) {
        return false
      }

      // 读取前 16 字节检查文本内容
      const buffer = Buffer.alloc(16)
      const fd = await open(filePath, 'r')
      await fd.read(buffer, 0, 16, 0)
      await fd.close()

      // 检查文件是否以常见 SQL 文本模式开头（非 DuckDB 二进制文件）
      const header = buffer.toString('utf8', 0, 16).toLowerCase()
      const textPatterns = [
        'create',
        'insert',
        'select',
        'drop',
        '--',
        '/*',
        'pragma',
      ]
      for (const pattern of textPatterns) {
        if (header.startsWith(pattern)) {
          return false // 是 SQL 文本文件，非 DuckDB 二进制文件
        }
      }

      // 最终验证：尝试用 DuckDB 打开并执行简单查询
      const duckdb = await this.getDuckDBPath()
      if (duckdb) {
        try {
          await execFileAsync(duckdb, [filePath, '-c', 'SELECT 1'], {
            timeout: 5000,
          })
          return true
        } catch {
          return false
        }
      }

      // 如果无法运行 DuckDB，退回二进制头部检查
      // DuckDB 文件头部应包含非可打印字节
      const hasNonPrintable = buffer.some((b) => b !== 0 && (b < 32 || b > 126))
      return hasNonPrintable
    } catch {
      return false
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('DuckDB 数据库文件未找到')
    }

    const duckdb = await this.requireDuckDBPath()

    if (options.file) {
      // 运行 SQL 文件 - 将文件导入标准输入（避免 shell 注入）
      await this.runSqlFile(duckdb, entry.filePath, options.file)
    } else if (options.sql) {
      // 运行内联 SQL - 作为参数传入，结果输出到标准输出
      const { stdout, stderr } = await execFileAsync(duckdb, [
        entry.filePath,
        '-c',
        options.sql,
      ])
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('必须提供 file 或 sql 选项之一')
    }
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  // 辅助方法：获取 duckdb 路径，若未找到则抛出友好提示
  private async requireDuckDBPath(version?: string): Promise<string> {
    const duckdb = await this.getDuckDBPath(version)
    if (!duckdb) {
      throw new Error(
        '未找到 duckdb。请确保 DuckDB 二进制已下载：\n' +
          '  spindb engines download duckdb',
      )
    }
    return duckdb
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('DuckDB 数据库文件未找到')
    }

    const duckdb = await this.requireDuckDBPath()

    // 使用 spawn 而非 execFileAsync 以流式传输结果
    return new Promise((resolve, reject) => {
      const proc = spawn(duckdb, [
        '-csv',
        '-header',
        entry.filePath,
        '-c',
        query,
      ])

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
          reject(new Error(stderr || `duckdb 退出码: ${code}`))
          return
        }
        // 若有标准错误输出，作为调试信息记录但不抛出
        if (stderr) {
          logDebug(`DuckDB stderr: ${stderr}`)
        }
        resolve(parseCSVToQueryResult(stdout))
      })
    })
  }

  /**
   * 列出 DuckDB 的数据库。
   * DuckDB 基于文件，每个文件一个数据库。
   * 返回配置的数据库（文件路径）作为单元素数组。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // DuckDB 基于文件，每个文件一个数据库
    return [container.database]
  }
}

export const duckdbEngine = new DuckDBEngine()