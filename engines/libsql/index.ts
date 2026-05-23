import { generateKeyPairSync, sign } from 'crypto'
import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  UnsupportedOperationError,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import {
  loadCredentials,
  saveCredentials,
  getDefaultUsername,
  credentialsExist,
} from '../../core/credential-manager'
import { libsqlBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { libsqlQuery, hranaValueToJs, libsqlApiRequest } from './api-client'
import {
  Engine,
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

const ENGINE = 'libsql'
const engineDef = getEngineDefaults(ENGINE)

const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500
const JWT_KEY_FILE = 'jwt-key.pem'

/**
 * 从凭证管理器加载容器的认证令牌（如果可用）。
 * 未存储凭证时返回 undefined。
 */
async function loadAuthToken(
  containerName: string,
): Promise<string | undefined> {
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(containerName, Engine.LibSQL, username)
  return creds?.apiKey ?? undefined
}

/** 默认 JWT 有效期：10 年（对于本地开发来说实际上永不过期） */
const DEFAULT_JWT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60

/**
 * 创建一个使用 Ed25519 私钥签名的 JWT 令牌。
 * 头部：{"alg":"EdDSA","typ":"JWT"}
 * 负载：{"a":"rw","exp":...}（带过期时间的读写权限）
 */
function createJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ttlSeconds = DEFAULT_JWT_TTL_SECONDS,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }),
  ).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = Buffer.from(JSON.stringify({ a: 'rw', exp })).toString(
    'base64url',
  )
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString(
    'base64url',
  )
  return `${signingInput}.${signature}`
}

export class LibSQLEngine extends BaseEngine {
  name = ENGINE
  displayName = 'libSQL'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  async fetchDeprecatedVersions(): Promise<Set<string>> {
    return new Set()
  }

  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'libsql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `sqld${ext}`)
    return existsSync(serverPath)
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return libsqlBinaryManager.isInstalled(version, platform, arch)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await libsqlBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    const ext = platformService.getExecutableExtension()
    const sqldPath = join(binPath, 'bin', `sqld${ext}`)
    if (existsSync(sqldPath)) {
      await configManager.setBinaryPath('sqld', sqldPath, 'bundled')
    }

    return binPath
  }

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

    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 libSQL 数据目录：${dataDir}`)
    }

    return dataDir
  }

  async getSqldServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'libsql',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `sqld${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `libSQL ${version} 未安装。请运行：spindb engines download libsql ${version}`,
    )
  }

  async getSqldPath(version?: string): Promise<string> {
    const cached = await configManager.getBinaryPath('sqld')
    if (cached && existsSync(cached)) {
      return cached
    }

    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'libsql',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const sqldPath = join(binPath, 'bin', `sqld${ext}`)
      if (existsSync(sqldPath)) {
        return sqldPath
      }
    }

    throw new Error(
      '未找到 sqld。请运行：spindb engines download libsql <version>',
    )
  }

  /**
   * 启动 libSQL 服务器 (sqld)
   * 命令行：sqld --http-listen-addr 127.0.0.1:PORT --db-path /path/to/data.db
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    let sqldServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `sqld${ext}`)
      if (existsSync(serverPath)) {
        sqldServer = serverPath
        logDebug(`使用存储的二进制路径：${sqldServer}`)
      }
    }

    if (!sqldServer) {
      try {
        sqldServer = await this.getSqldServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `libSQL ${version} 未安装。请运行：spindb engines download libsql ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    logDebug(`使用版本 ${version} 的 sqld：${sqldServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'libsql.pid')
    const dbPath = join(dataDir, 'data.db')

    // 检查 HTTP 端口是否可用
    if (!(await portManager.isPortAvailable(port))) {
      throw new Error(`HTTP 端口 ${port} 已被占用。`)
    }

    onProgress?.({ stage: 'starting', message: '正在启动 libSQL...' })

    const bindAddr = container.bindAddress ?? '127.0.0.1'
    const args = [
      '--http-listen-addr',
      `${bindAddr}:${port}`,
      '--db-path',
      dbPath,
    ]

    // 如果 JWT 密钥文件存在，则启用 JWT 认证
    const jwtKeyPath = join(containerDir, JWT_KEY_FILE)
    if (existsSync(jwtKeyPath)) {
      args.push('--auth-jwt-key-file', jwtKeyPath)
      logDebug(`已通过密钥文件启用 JWT 认证：${jwtKeyPath}`)
    }

    logDebug(`使用参数启动 sqld：${args.join(' ')}`)

    const checkLogForError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000)

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `端口 ${port} 已被占用`
        }
      } catch {
        // 日志文件可能尚不存在
      }
      return null
    }

    // 以分离模式启动进程，将 stderr 重定向到 logFile 以便调试
    const logFd = openSync(logFile, 'a')
    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', logFd],
      detached: true,
    }

    const proc = spawn(sqldServer, args, spawnOpts)

    // 写入 PID 文件
    if (proc.pid) {
      await writeFile(pidFile, proc.pid.toString())
      logDebug(`libSQL 服务器 PID：${proc.pid}`)
    }

    proc.unref()
    closeSync(logFd)

    // 等待服务器准备就绪
    await new Promise((resolve) => setTimeout(resolve, START_CHECK_DELAY_MS))

    // 健康检查循环
    const maxRetries = 30
    const retryDelay = 500
    let ready = false

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await libsqlApiRequest(port, 'GET', '/health', 2000)
        if (response.status === 200) {
          ready = true
          break
        }
      } catch {
        // 尚未就绪
      }

      // 检查日志中的启动错误
      const logError = await checkLogForError()
      if (logError) {
        throw new Error(`libSQL 启动失败：${logError}`)
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }

    if (!ready) {
      throw new Error(
        `libSQL 在 ${(maxRetries * retryDelay) / 1000}秒 后未能启动。查看日志：${logFile}`,
      )
    }

    onProgress?.({ stage: 'ready', message: 'libSQL 已就绪' })

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  /**
   * 停止 libSQL 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'libsql.pid')

    logDebug(`正在停止端口 ${port} 上的 libSQL 容器 "${name}"`)

    let pid: number | null = null
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 libSQL 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logDebug(`优雅终止失败，正在强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
        }
      } catch (error) {
        logDebug(`进程终止错误：${error}`)
      }
    }

    // 终止仍在占用该端口的任何进程
    const portPids = await platformService.findProcessByPort(port)
    for (const portPid of portPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`正在终止仍占用端口 ${port} 的进程 ${portPid}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // 忽略
        }
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
  }

  /**
   * 检查 libSQL 是否正在运行
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const running = await processManager.isRunning(name, { engine: ENGINE })

    if (running) {
      // 验证服务器是否响应
      try {
        const response = await libsqlApiRequest(port, 'GET', '/health', 2000)
        if (response.status === 200) {
          return { running: true, message: `libSQL 正在端口 ${port} 上运行` }
        }
      } catch {
        // 进程存在但未响应
      }
      return {
        running: true,
        message: `libSQL 进程正在运行，但端口 ${port} 无响应`,
      }
    }

    return { running: false, message: 'libSQL 未运行' }
  }

  /**
   * 连接到 libSQL - 打开 HTTP URL
   * libSQL 是一个 REST API 引擎，没有原生 CLI Shell
   */
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { name, port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`libSQL HTTP API：${url}`)
    console.log(`查询端点：${url}/v2/pipeline`)
    console.log(`健康检查：${url}/health`)

    const authToken = await loadAuthToken(name)
    if (authToken) {
      console.log('')
      console.log('已启用认证。请携带认证令牌请求头：')
      console.log(`  Authorization: Bearer ${authToken}`)
    }

    console.log('')
    console.log('可使用任何 HTTP 客户端或 libSQL SDK 进行连接。')
    console.log('curl 示例：')
    const authHeader = authToken
      ? ` -H "Authorization: Bearer ${authToken}"`
      : ''
    console.log(
      `  curl -s ${url}/v2/pipeline -H "Content-Type: application/json"${authHeader} -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}'`,
    )
  }

  getConnectionString(container: ContainerConfig, _database?: string): string {
    return `http://127.0.0.1:${container.port}`
  }

  /**
   * 通过 Hrana HTTP 协议执行 SQL 查询
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    const port = container.port

    // 如果凭证可用，则从中加载认证令牌
    const authToken = await loadAuthToken(container.name)

    const result = await libsqlQuery(port, query, {
      authToken,
    })

    const columns = result.cols.map((col) => col.name)
    const rows = result.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      result.cols.forEach((col, i) => {
        obj[col.name] = hranaValueToJs(row[i])
      })
      return obj
    })

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  /**
   * 列出数据库 - libSQL 每个实例运行单个数据库
   */
  async listDatabases(_container: ContainerConfig): Promise<string[]> {
    return ['main']
  }

  /**
   * 创建数据库 - 不支持（每个实例单个数据库）
   */
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'createDatabase',
      'libSQL',
      'libSQL 每个服务器实例运行单个 SQLite 数据库。请使用 "spindb create" 创建新实例。',
    )
  }

  /**
   * 删除数据库 - 不支持（每个实例单个数据库）
   */
  async dropDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'dropDatabase',
      'libSQL',
      'libSQL 每个服务器实例运行单个 SQLite 数据库。请使用 "spindb delete" 删除实例。',
    )
  }

  /**
   * 创建备份
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /**
   * 从备份恢复
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options?: { format?: string },
  ): Promise<RestoreResult> {
    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    const dataDir = join(containerDir, 'data')

    return restoreBackup(backupPath, {
      containerName: container.name,
      dataDir,
      port: container.port,
      format: options?.format as 'sql' | 'binary' | undefined,
    })
  }

  /**
   * 从文件检测备份格式
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * 从远程连接字符串导出数据
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 解析连接字符串以获取 host:port
    let url: URL
    let normalized = connectionString.trim()
    if (
      !normalized.startsWith('http://') &&
      !normalized.startsWith('https://')
    ) {
      normalized = `http://${normalized}`
    }
    try {
      url = new URL(normalized)
    } catch {
      throw new Error(
        `无效的 libSQL 连接字符串：${connectionString}\n` +
          '期望格式：http://host:port',
      )
    }

    const port = parseInt(url.port || '8080', 10)

    // 为备份创建临时容器配置
    const tmpContainer: ContainerConfig = {
      name: '__remote_dump__',
      engine: 'libsql' as ContainerConfig['engine'],
      version: '0',
      port,
      database: 'main',
      created: new Date().toISOString(),
      status: 'running',
    }

    const result = await createBackup(tmpContainer, outputPath, {
      database: 'main',
      format: 'sql',
    })

    return {
      filePath: result.path,
    }
  }

  /**
   * 获取数据库大小
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    // sqld 的 data.db 是一个目录；实际的 SQLite 文件在里面
    const sqliteFile = join(
      containerDir,
      'data',
      'data.db',
      'dbs',
      'default',
      'data',
    )

    if (!existsSync(sqliteFile)) {
      return null
    }

    try {
      const { size } = await stat(sqliteFile)
      return size
    } catch {
      return null
    }
  }

  /**
   * 运行脚本文件 - REST API 引擎不支持
   */
  async runScript(
    _container: ContainerConfig,
    _options: { scriptPath: string; database?: string },
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'runScript',
      'libSQL',
      'libSQL 是 REST API 引擎。请使用 HTTP API 或 libSQL SDK 运行脚本。',
    )
  }

  /**
   * 为 libSQL 创建 JWT 认证令牌。
   *
   * 生成 Ed25519 密钥对，将公钥写入容器目录以便 sqld 验证令牌，
   * 创建一个具有读写权限的 JWT，并通过凭证管理器存储。
   *
   * 幂等性：如果密钥文件和凭证已存在，则返回现有凭证而不重新生成。
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username } = options
    assertValidUsername(username)

    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    const jwtKeyPath = join(containerDir, JWT_KEY_FILE)

    // 幂等：如果密钥文件存在且凭证已存储，则返回现有凭证
    if (
      existsSync(jwtKeyPath) &&
      credentialsExist(container.name, Engine.LibSQL, username)
    ) {
      const existing = await loadCredentials(
        container.name,
        Engine.LibSQL,
        username,
      )
      if (existing) {
        logDebug(`找到 ${username} 的现有 libSQL JWT 凭证`)
        return existing
      }
    }

    // 生成 Ed25519 密钥对
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')

    // 将公钥以 PEM 格式写入，供 sqld 使用
    const publicKeyPem = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string
    await writeFile(jwtKeyPath, publicKeyPem, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    logDebug(`已将 JWT 公钥写入 ${jwtKeyPath}`)

    // 创建一个具有读写权限的 JWT 令牌
    const token = createJwt(privateKey)

    // 重启 sqld 使其加载新的密钥文件
    const isRunning = await processManager.isRunning(container.name, {
      engine: ENGINE,
    })
    if (isRunning) {
      logDebug('正在重启 sqld 以加载 JWT 密钥文件')
      await this.stop(container)
      await this.start(container)
    }

    // 通过凭证管理器存储凭证
    const connectionString = this.getConnectionString(container)
    const credentials: UserCredentials = {
      username,
      password: '',
      connectionString,
      engine: container.engine,
      container: container.name,
      apiKey: token,
    }

    await saveCredentials(container.name, Engine.LibSQL, credentials)
    logDebug(`已保存 ${username} 的 libSQL JWT 凭证`)

    return credentials
  }
}

export const libsqlEngine = new LibSQLEngine()
