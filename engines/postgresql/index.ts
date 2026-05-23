import { join } from 'path'
import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { BaseEngine } from '../base-engine'
import { postgresqlBinaryManager } from './binary-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
import { containerManager } from '../../core/container-manager'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from '../../core/platform-service'
import { paths } from '../../config/paths'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { getBinaryUrl } from './binary-urls'
import { fetchAvailableVersions, getLatestVersion } from './hostdb-releases'
import {
  SUPPORTED_MAJOR_VERSIONS,
  POSTGRESQL_VERSION_MAP,
} from './version-maps'
import { detectBackupFormat, restoreBackup } from './restore'
import { createBackup } from './backup'
import {
  validateDumpCompatibility,
  type DumpCompatibilityResult,
} from './version-validator'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import {
  assertValidDatabaseName,
  assertValidUsername,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { parseCSVToQueryResult } from '../../core/query-parser'
import { Engine } from '../../types'
import type {
  Platform,
  Arch,
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
  QueryResult,
  QueryOptions,
  CreateUserOptions,
  UserCredentials,
} from '../../types'

const execAsync = promisify(exec)

/**
 * 构建适用于 Windows 的 psql 命令字符串，支持文件或内联 SQL。
 * 此函数导出用于单元测试。
 */
export function buildWindowsPsqlCommand(
  psqlPath: string,
  port: number,
  user: string,
  db: string,
  options: { file?: string; sql?: string },
): string {
  if (!options.file && !options.sql) {
    throw new Error('必须提供 file 或 sql 参数')
  }

  let cmd = `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${db}`

  if (options.file) {
    cmd += ` -f "${options.file}"`
  } else if (options.sql) {
    // 转义 SQL 中的双引号，以保留外层双引号
    const escaped = options.sql.replace(/"/g, '\\"')
    cmd += ` -c "${escaped}"`
  }

  return cmd
}

export class PostgreSQLEngine extends BaseEngine {
  name = 'postgresql'
  displayName = 'PostgreSQL'
  defaultPort = getEngineDefaults('postgresql').defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    const info = platformService.getPlatformInfo()
    return {
      platform: info.platform,
      arch: info.arch,
    }
  }

  // 将版本字符串解析为完整版本（例如 '17' -> '17.7.0'）
  resolveFullVersion(version: string): string {
    // 检查是否已经是完整版本（至少包含一个点号和后续数字）
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // 是主版本，使用回退映射表解析（同步，无网络请求）
    return POSTGRESQL_VERSION_MAP[version] || `${version}.0.0`
  }

  async resolveFullVersionAsync(version: string): Promise<string> {
    // 检查是否已经是完整版本
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // 从网络/缓存解析
    return getLatestVersion(version)
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  /**
   * 获取二进制文件路径，带有自修复回退逻辑。
   *
   * 如果精确版本的二进制文件不存在：
   * 1. 查找同主版本的已安装二进制文件
   * 2. 如果找到，使用它们并可选地更新容器配置
   * 3. 如果未找到，下载该主版本的当前支持版本
   *
   * @param version - 容器配置中的版本（例如 "17.7.0"）
   * @param containerName - 容器名称，用于配置更新（可选）
   * @param onProgress - 下载进度回调
   * @returns 包含 binPath 和 actualVersion 的对象（可能与请求版本不同）
   */
  async getBinaryPathWithFallback(
    version: string,
    containerName?: string,
    onProgress?: ProgressCallback,
  ): Promise<{ binPath: string; actualVersion: string; wasHealed: boolean }> {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()

    // 检查精确版本的二进制文件是否存在
    const expectedPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(expectedPath, 'bin', `pg_ctl${ext}`)

    if (existsSync(pgCtlPath)) {
      return {
        binPath: expectedPath,
        actualVersion: fullVersion,
        wasHealed: false,
      }
    }

    // 二进制文件不存在 - 尝试查找同主版本
    const majorVersion = fullVersion.split('.')[0]

    // 检查是否有该主版本的已安装二进制文件
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      p,
      a,
    )

    if (installed) {
      // 找到兼容的二进制文件 - 验证是否可用
      const installedPgCtl = join(installed.path, 'bin', `pg_ctl${ext}`)
      if (existsSync(installedPgCtl)) {
        // 如果提供了容器名称，则更新容器配置
        if (containerName) {
          await containerManager.updateConfig(containerName, {
            version: installed.version,
          })
        }
        return {
          binPath: installed.path,
          actualVersion: installed.version,
          wasHealed: true,
        }
      }
    }

    // 未找到兼容的二进制文件 - 下载当前支持版本
    const targetVersion = POSTGRESQL_VERSION_MAP[majorVersion]
    if (!targetVersion) {
      throw new Error(
        `PostgreSQL 主版本 ${majorVersion} 不受支持。` +
          `支持的版本：${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
      )
    }

    onProgress?.({
      stage: 'downloading',
      message: `未找到 PostgreSQL ${fullVersion} 的二进制文件，正在下载 ${targetVersion}...`,
    })

    const binPath = await this.ensureBinaries(targetVersion, onProgress)

    // 如果提供了容器名称，则更新容器配置
    if (containerName && targetVersion !== fullVersion) {
      await containerManager.updateConfig(containerName, {
        version: targetVersion,
      })
    }

    return {
      binPath,
      actualVersion: targetVersion,
      wasHealed: targetVersion !== fullVersion,
    }
  }

  getBinaryUrl(version: string, plat: Platform, arc: Arch): string {
    return getBinaryUrl(version, plat, arc)
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    // 从类似 "postgresql-17.7.0-darwin-arm64" 的路径中提取版本号
    const match = binPath.match(/postgresql-(\d+(?:\.\d+)*)/)
    if (!match) {
      throw new Error(
        `无法从路径中提取 PostgreSQL 版本：${binPath}`,
      )
    }
    const version = match[1]
    return postgresqlBinaryManager.verify(version, p, a)
  }

  // 下载二进制文件并在配置中注册所有工具（服务端和客户端）。
  // hostdb 打包了所有平台的所有 PostgreSQL 二进制文件。
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await postgresqlBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // 在配置中注册下载包中的所有二进制文件
    const ext = platformService.getExecutableExtension()

    // hostdb 下载中打包的所有 PostgreSQL 工具
    const allTools = [
      // 服务端二进制文件
      'postgres',
      'pg_ctl',
      'initdb',
      // 客户端工具
      'psql',
      'pg_dump',
      'pg_restore',
      'pg_basebackup',
    ] as const

    for (const tool of allTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return postgresqlBinaryManager.isInstalled(version, p, a)
  }

  /**
   * 检查指定版本是否有兼容的二进制文件已安装。
   * 如果精确版本或同主版本的二进制文件存在，则返回 true。
   * CLI 使用此方法判断是否需要提示用户下载。
   */
  hasCompatibleBinaries(version: string): boolean {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()

    // 检查精确版本是否存在
    const expectedPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(expectedPath, 'bin', `pg_ctl${ext}`)

    if (existsSync(pgCtlPath)) {
      return true
    }

    // 检查同主版本是否存在
    const majorVersion = fullVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      p,
      a,
    )

    return installed !== null
  }

  async initDataDir(
    containerName: string,
    version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const initdbPath = join(binPath, 'bin', `initdb${ext}`)
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })

    await processManager.initdb(initdbPath, dataDir, {
      superuser: (options.superuser as string) || defaults.superuser,
    })

    // 在 initdb 创建 postgresql.conf 后配置 max_connections
    const maxConnections =
      (options.maxConnections as number) ||
      getEngineDefaults('postgresql').maxConnections
    await this.setConfigValue(
      dataDir,
      'max_connections',
      String(maxConnections),
    )

    return dataDir
  }

  getConfigPath(containerName: string): string {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })
    return join(dataDir, 'postgresql.conf')
  }

  // 更新或追加 postgresql.conf 中的配置值
  async setConfigValue(
    dataDir: string,
    key: string,
    value: string,
  ): Promise<void> {
    const configPath = join(dataDir, 'postgresql.conf')
    let content = await readFile(configPath, 'utf8')

    // 同时匹配注释行（#key = ...）和非注释行（key = ...）
    const regex = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm')

    if (regex.test(content)) {
      // 更新已有行（无论是否被注释）
      content = content.replace(regex, `${key} = ${value}`)
    } else {
      // 追加到文件末尾
      content = content.trimEnd() + `\n${key} = ${value}\n`
    }

    await writeFile(configPath, content, 'utf8')
  }

  async getConfigValue(dataDir: string, key: string): Promise<string | null> {
    const configPath = join(dataDir, 'postgresql.conf')
    const content = await readFile(configPath, 'utf8')

    // 仅匹配非注释行
    const regex = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm')
    const match = content.match(regex)

    if (match) {
      // 移除引号（如果存在）
      return match[1].replace(/^['"]|['"]$/g, '')
    }
    return null
  }

  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, version, port } = container

    // 检查是否已在运行（幂等行为）
    const alreadyRunning = await processManager.isRunning(name, {
      engine: this.name,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // 获取二进制文件路径（带自修复回退）
    const { binPath, wasHealed } = await this.getBinaryPathWithFallback(
      version,
      name,
      onProgress,
    )

    if (wasHealed) {
      onProgress?.({
        stage: 'info',
        message: '容器版本已更新以匹配可用的二进制文件',
      })
    }

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })
    const logFile = paths.getContainerLogPath(name, { engine: this.name })

    onProgress?.({ stage: 'starting', message: '正在启动 PostgreSQL...' })

    await processManager.start(pgCtlPath, dataDir, {
      port,
      logFile,
      bindAddress: container.bindAddress,
    })

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  async stop(container: ContainerConfig): Promise<void> {
    const { name, version } = container

    // 获取二进制文件路径（带自修复回退，停止操作无进度回调）
    const { binPath } = await this.getBinaryPathWithFallback(version, name)

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    await processManager.stop(pgCtlPath, dataDir)

    // 如果该容器的 pgweb 正在运行则停止它
    await this.stopPgweb(name)
  }

  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, version } = container

    // 获取二进制文件路径（带自修复回退，状态查询无进度回调）
    const { binPath } = await this.getBinaryPathWithFallback(version, name)

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    return processManager.status(pgCtlPath, dataDir)
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormat(filePath)
  }

  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { version, port } = container
    const binPath = this.getBinaryPath(version)
    const database = (options.database as string) || container.name
    const savedCreds = await loadCredentials(
      container.name,
      Engine.PostgreSQL,
      getDefaultUsername(Engine.PostgreSQL),
    )

    // 首先创建数据库（如果不存在）
    if (options.createDatabase !== false) {
      await this.createDatabase(container, database, savedCreds)
    }

    return restoreBackup(binPath, backupPath, {
      port,
      database,
      user: savedCreds?.username || defaults.superuser,
      password: savedCreds?.password,
      pgRestorePath: options.pgRestorePath as string, // 如果提供了自定义路径则使用
      containerVersion: version, // 传递容器版本用于版本匹配的二进制文件查找
      ...(options as { format?: string }),
    })
  }

  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'postgres'
    return `postgresql://${defaults.superuser}@127.0.0.1:${port}/${db}`
  }

  async getPsqlPath(): Promise<string> {
    const psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      throw new Error(
        '未找到 psql。请下载 PostgreSQL 二进制文件：\n' +
          '  spindb engines download postgresql',
      )
    }
    return psqlPath
  }

  async getPgRestorePath(): Promise<string> {
    const pgRestorePath = await configManager.getBinaryPath('pg_restore')
    if (!pgRestorePath) {
      throw new Error(
        '未找到 pg_restore。请下载 PostgreSQL 二进制文件：\n' +
          '  spindb engines download postgresql',
      )
    }
    return pgRestorePath
  }

  async getPgDumpPath(): Promise<string> {
    const pgDumpPath = await configManager.getBinaryPath('pg_dump')
    if (!pgDumpPath) {
      throw new Error(
        '未找到 pg_dump。请下载 PostgreSQL 二进制文件：\n' +
          '  spindb engines download postgresql',
      )
    }
    return pgDumpPath
  }

  /**
   * 获取兼容的 pg_dump 路径，用于从远程数据库导出
   *
   * 此方法检查远程数据库版本并查找兼容的 pg_dump：
   * 1. 首先检查当前 pg_dump 是否兼容
   * 2. 如果不兼容，尝试查找兼容版本的直接路径
   * 3. 如果失败，尝试切换 Homebrew 链接
   * 4. 如果以上都失败，抛出错误并提供安装说明
   */
  async getCompatiblePgDumpPath(connectionString: string): Promise<{
    path: string
    switched: boolean
    warnings: string[]
  }> {
    const warnings: string[] = []

    // 获取当前 pg_dump 路径并进行版本验证
    const { path, versionMismatch, cachedVersion, actualVersion } =
      await configManager.getBinaryPathWithVersionCheck('pg_dump')

    if (!path) {
      throw new SpinDBError(
        ErrorCodes.DEPENDENCY_MISSING,
        '未找到 pg_dump。',
        'fatal',
        '请下载 PostgreSQL 二进制文件：spindb engines download postgresql',
      )
    }

    if (versionMismatch) {
      warnings.push(
        `pg_dump 磁盘上的版本已变更：${cachedVersion} -> ${actualVersion}`,
      )
    }

    // 检查与远程数据库的兼容性
    let compatibility: DumpCompatibilityResult
    try {
      compatibility = await validateDumpCompatibility({
        connectionString,
        pgDumpPath: path,
      })
    } catch (error) {
      // 连接或版本检测失败
      const e = error as Error
      throw new SpinDBError(
        ErrorCodes.CONNECTION_FAILED,
        `检测远程数据库版本失败：${e.message}`,
        'fatal',
        '请检查连接字符串并确保数据库可访问。',
      )
    }

    if (compatibility.compatible) {
      return { path, switched: false, warnings }
    }

    if (
      compatibility.requiredAction === 'use_bundled' &&
      compatibility.alternativePath
    ) {
      warnings.push(
        `正在使用内置的 PostgreSQL ${compatibility.targetMajor} pg_dump（远程数据库版本为 v${compatibility.remoteDbVersion.majorVersion}）`,
      )
      return {
        path: compatibility.alternativePath,
        switched: false,
        warnings,
      }
    }

    // 没有内置二进制文件可以读取此服务器 —— 提示用户下载
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      compatibility.error ||
        `你的 pg_dump 版本（${compatibility.localToolVersion.major}）无法导出 PostgreSQL ${compatibility.remoteDbVersion.majorVersion} 的数据`,
      'fatal',
      `请下载匹配的 PostgreSQL 客户端工具：\n` +
        `  spindb engines download postgresql ${compatibility.remoteDbVersion.majorVersion}`,
      { compatibility },
    )
  }

  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        psqlPath,
        [
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          defaults.superuser,
          '-d',
          db,
        ],
        spawnOptions,
      )

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  async createDatabase(
    container: ContainerConfig,
    database: string,
    auth?: { username?: string; password?: string } | null,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container
    const psqlPath = await this.getPsqlPath()
    const user = auth?.username || defaults.superuser
    const sql = `CREATE DATABASE "${database}"`
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      'postgres',
      '-c',
      sql,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: auth?.password
          ? { ...process.env, PGPASSWORD: auth.password }
          : process.env,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        const output = `${stdout}\n${stderr}`.trim()
        if (code === 0 || output.includes('already exists')) {
          resolve()
          return
        }
        reject(
          new Error(output || `psql 以退出码 ${code ?? 'unknown'} 退出`),
        )
      })
    })
  }

  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // 在 Windows 上，cmd.exe 不支持单引号 - 使用双引号并转义内部引号
    const sql = `DROP DATABASE IF EXISTS "${database}"`
    const cmd = isWindows()
      ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c "${sql.replace(/"/g, '\\"')}"`
      : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c '${sql}'`

    try {
      await execAsync(cmd)
    } catch (error) {
      const err = error as Error
      // 忽略"数据库不存在"错误
      if (!err.message.includes('does not exist')) {
        throw error
      }
    }
  }

  /**
   * 使用 PostgreSQL 原生的 ALTER DATABASE RENAME 重命名数据库。
   * 首先终止活动连接（PG 要求目标数据库零连接）。
   */
  async renameDatabase(
    container: ContainerConfig,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const systemDatabases = ['postgres', 'template0', 'template1']
    if (systemDatabases.includes(oldName)) {
      throw new Error(`无法重命名系统数据库：${oldName}`)
    }
    if (systemDatabases.includes(newName)) {
      throw new Error(`无法重命名为系统数据库名称：${newName}`)
    }

    assertValidDatabaseName(oldName)
    assertValidDatabaseName(newName)
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // PostgreSQL 要求被重命名的数据库没有活动连接
    await this.terminateConnections(container, oldName)

    const sql = `ALTER DATABASE "${oldName}" RENAME TO "${newName}"`
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      'postgres',
      '-c',
      sql,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`重命名数据库失败：${stderr.trim()}`))
        }
      })
      proc.on('error', reject)
    })
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'postgres'

    // 验证数据库名称以防止 SQL 注入
    assertValidDatabaseName(db)

    try {
      const psqlPath = await this.getPsqlPath()
      // 查询指定数据库的 pg_database_size
      // 在 Windows 上使用转义双引号；在 Unix 上使用单引号
      const sql = `SELECT pg_database_size('${db}')`
      const cmd = isWindows()
        ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -t -A -c "${sql.replace(/'/g, "''")}"`
        : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -t -A -c "${sql}"`
      const { stdout } = await execAsync(cmd)
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      // 容器未运行或查询失败
      return null
    }
  }

  /**
   * 将远程数据库导出到文件
   *
   * 此方法自动检测远程数据库版本并使用兼容的 pg_dump 二进制文件。
   * 如果当前 pg_dump 不兼容，将尝试查找或切换到兼容版本。
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 获取兼容的 pg_dump 路径（可能切换版本或使用直接路径）
    const { path: pgDumpPath, warnings } =
      await this.getCompatiblePgDumpPath(connectionString)

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const args = [connectionString, '-Fc', '-f', outputPath]

      const proc = spawn(pgDumpPath, args, spawnOptions)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code,
            warnings,
          })
        } else {
          // pg_dump 执行失败
          const errorMessage = stderr || `pg_dump 以退出码 ${code} 退出`
          reject(new Error(errorMessage))
        }
      })
    })
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  async terminateConnections(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // 终止到该数据库的所有连接（除了我们自己的）
    const sql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`

    // 连接到 'postgres' 数据库执行管理操作
    // 转义 shell 中的单引号：' 变成 '\''（结束引号、转义引号、开始引号）
    const shellEscapedSql = sql.replace(/'/g, "'\\''")
    const cmd = isWindows()
      ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c "${sql.replace(/"/g, '\\"')}"`
      : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c '${shellEscapedSql}'"`

    try {
      await execAsync(cmd)
    } catch {
      // 忽略错误 - 连接可能已经不存在
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    // 在 Windows 上，构建单个命令字符串并使用 exec，
    // 以避免传递带有 shell:true 的 args 数组（DEP0190 和引号问题）。
    if (isWindows()) {
      const cmd = buildWindowsPsqlCommand(
        psqlPath,
        port,
        defaults.superuser,
        db,
        options,
      )
      try {
        const { stdout, stderr } = await execAsync(cmd)
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
        return
      } catch (error) {
        const err = error as Error
        throw new Error(`psql 执行失败：${err.message}`)
      }
    }

    // 非 Windows：直接使用 spawn 和参数（不通过 shell）
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      db,
    ]

    if (options.file) {
      args.push('-f', options.file)
    } else if (options.sql) {
      args.push('-c', options.sql)
    } else {
      throw new Error('必须提供 file 或 sql 参数')
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, spawnOptions)

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`psql 以退出码 ${code} 退出`))
        }
      })
    })
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'postgres'
    const psqlPath = await this.getPsqlPath()
    const host = options?.host ?? '127.0.0.1'
    const user = options?.username || defaults.superuser

    // 使用 --csv 获取机器可读的输出
    const args = [
      '-X', // 跳过 ~/.psqlrc 以确保 CSV 输出的一致性
      '-h',
      host,
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      db,
      '--csv',
      '-c',
      query,
    ]

    // 通过环境变量传递密码和 SSL 模式（用于远程容器）
    const env = { ...process.env }
    if (options?.password) {
      env.PGPASSWORD = options.password
    }
    if (options?.ssl) {
      env.PGSSLMODE = 'require'
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(parseCSVToQueryResult(stdout))
        } else {
          reject(new Error(stderr || `psql 以退出码 ${code} 退出`))
        }
      })
    })
  }

  /**
   * 列出所有用户数据库，排除系统数据库（template0、template1、postgres）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // 查询 pg_database 获取所有非系统数据库
    const sql = `SELECT datname FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres') AND datistemplate = false ORDER BY datname`

    const args = [
      '-X', // 跳过 ~/.psqlrc
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      'postgres',
      '-t', // 仅输出元组（无表头）
      '-A', // 非对齐输出
      '-c',
      sql,
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          const databases = stdout
            .trim()
            .split('\n')
            .map((db) => db.trim())
            .filter((db) => db.length > 0)
          resolve(databases)
        } else {
          reject(new Error(stderr || `psql 以退出码 ${code} 退出`))
        }
      })
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port } = container
    const db = database || container.database
    if (!db) {
      throw new Error(
        '未指定目标数据库。请使用 --database 提供数据库名称，或确保容器已设置默认数据库。',
      )
    }
    assertValidDatabaseName(db)
    const psqlPath = await this.getPsqlPath()

    // 通过 stdin 传递 SQL（psql -f -），避免在进程列表中暴露密码
    const psqlBaseArgs = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      'postgres',
      '-f',
      '-',
    ]

    const runPsqlViaStdin = (sql: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(psqlPath, psqlBaseArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          ...getWindowsSpawnOptions(),
        })

        let stderr = ''
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('error', reject)

        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr || `psql 以退出码 ${code} 退出`))
        })

        proc.stdin?.write(sql)
        proc.stdin?.end()
      })

    // 转义用户名用于安全标识符插值（纵深防御）
    const escapedIdent = username.replace(/"/g, '""')
    const escapedPass = password.replace(/'/g, "''")

    // 创建具有登录权限和密码的角色
    const createRoleSql = `CREATE ROLE "${escapedIdent}" WITH LOGIN PASSWORD '${escapedPass}'`

    try {
      await runPsqlViaStdin(createRoleSql)
    } catch (error) {
      const err = error as Error
      if (err.message.includes('already exists')) {
        // 用户已存在 —— 改为更新密码
        const alterSql = `ALTER ROLE "${escapedIdent}" WITH PASSWORD '${escapedPass}'`
        await runPsqlViaStdin(alterSql)
      } else {
        throw error
      }
    }

    // 授予目标数据库的所有权限
    const grantSql = `GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${escapedIdent}"`
    await runPsqlViaStdin(grantSql)

    const connectionString = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const postgresqlEngine = new PostgreSQLEngine()
