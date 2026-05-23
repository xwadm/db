/**
 * MongoDB 引擎实现
 * 使用从 hostdb 下载的二进制文件管理 MongoDB 数据库容器
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import net from 'net'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, basename } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import {
  logDebug,
  logWarning,
  assertValidDatabaseName,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { mongodbBinaryManager } from './binary-manager'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
import { getBinaryUrl } from './binary-urls'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import { buildMongoUri, normalizeMongoHost, type MongoWireAuth } from '../mongo-uri'
import {
  Engine,
  Platform,
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
import { parseMongoDBResult } from '../../core/query-parser'

const ENGINE = 'mongodb'
const engineDef = getEngineDefaults(ENGINE)

type LocalMongoAuth = MongoWireAuth

// 构建 mongosh 命令，用于内联执行 JavaScript 脚本
export function buildMongoshCommand(
  mongoshPath: string,
  port: number,
  database: string,
  script: string,
  options?: { quiet?: boolean },
): string {
  const quietFlag = options?.quiet ? ' --quiet' : ''
  if (isWindows()) {
    // Windows：使用双引号
    const escaped = script.replace(/"/g, '\\"')
    return `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database}${quietFlag} --eval "${escaped}"`
  } else {
    // Unix：使用单引号
    const escaped = script.replace(/'/g, "'\\''")
    return `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database}${quietFlag} --eval '${escaped}'`
  }
}

/**
 * 从可能包含额外消息/提示的 mongosh 输出中提取 JSON
 * 返回解析后的 JSON 对象，提取失败则返回 null
 */
function extractJson(output: string): unknown | null {
  const trimmed = output.trim()

  // 查找第一个 '{' 和最后一个 '}' 以提取 JSON 对象
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }

  try {
    return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

export class MongoDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MongoDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取当前平台和架构信息
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  /**
   * 从回退版本映射中返回可用的 MongoDB 版本。
   *
   * 注意：此方法返回的是 FALLBACK_VERSION_MAP 中的缓存/回退数据，不会执行
   * 网络请求。这与其他引擎维护与 hostdb releases.json 同步的
   * 静态版本映射的行为一致。
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}

    for (const [majorMinor, full] of Object.entries(FALLBACK_VERSION_MAP)) {
      versions[majorMinor] = [full]
    }

    return versions
  }

  // 从 hostdb 获取二进制文件下载地址
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本号（例如 '8' -> '8.0.17'）
  resolveFullVersion(version: string): string {
    // 检查是否已经是完整版本号（至少包含两个点号）
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // 是主版本号或主.次版本号，使用回退映射进行解析
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  // 获取指定版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  /**
   * 验证 MongoDB 二进制文件是否可用且功能正常
   *
   * 委托给 mongodbBinaryManager.verify()，该方法会：
   * 1. 检查文件是否存在
   * 2. 执行 `mongod --version`
   * 3. 验证版本输出是否与预期版本匹配
   *
   * @param binPath - MongoDB 二进制文件目录路径（例如 ~/.spindb/bin/mongodb-8.0.17-darwin-arm64）
   * @param version - 可选的显式版本号，用于验证
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    // 如果提供了显式版本号则直接使用
    if (version) {
      return mongodbBinaryManager.verify(version, p, a)
    }

    // 回退：从目录名中提取版本号（格式：mongodb-{version}-{platform}-{arch}）
    // 使用 basename 以避免父目录名中包含短横线导致的问题
    const dirName = basename(binPath)
    const match = dirName.match(/^mongodb-([\d.]+)-/)
    if (match) {
      const extractedVersion = match[1]
      return mongodbBinaryManager.verify(extractedVersion, p, a)
    }

    // 最后手段：仅检查文件是否存在
    const ext = platformService.getExecutableExtension()
    const mongodPath = join(binPath, 'bin', `mongod${ext}`)
    return existsSync(mongodPath)
  }

  // 检查指定版本的 MongoDB 是否已安装
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return mongodbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 MongoDB 二进制文件可用
   * 从 hostdb 下载所有平台的二进制文件
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    // 从 hostdb 下载
    const binPath = await mongodbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件（包括服务端和客户端工具）
    const ext = platformService.getExecutableExtension()
    const bundledTools = [
      'mongod', // 服务端
      'mongosh', // Shell 客户端
      'mongodump', // 备份工具
      'mongorestore', // 恢复工具
    ] as const

    for (const tool of bundledTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * 初始化新的 MongoDB 数据目录
   * 与 MySQL 不同，MongoDB 不需要初始化——只需创建目录即可
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // 如果数据目录不存在则创建
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`已创建 MongoDB 数据目录：${dataDir}`)
    }

    return dataDir
  }

  /**
   * 启动 MongoDB 服务
   * CLI 命令：mongod --dbpath {dir} --port {port} --bind_ip 127.0.0.1
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
    // 这确保版本一致性——容器使用创建时的同一二进制文件
    let mongod: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath 是目录路径（例如 ~/.spindb/bin/mongodb-8.0.17-linux-arm64）
      // 需要构建 mongod 的完整路径
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `mongod${ext}`)
      if (existsSync(serverPath)) {
        mongod = serverPath
        logDebug(`使用存储的二进制文件路径：${mongod}`)
      }
    }

    // 如果上面没有找到二进制文件，回退到常规路径
    if (!mongod) {
      // 从配置获取 mongod 路径，或按需下载
      const mongodPath = await configManager.getBinaryPath('mongod')
      if (mongodPath && existsSync(mongodPath)) {
        mongod = mongodPath
        logDebug(`使用已注册的二进制文件路径：${mongod}`)
      } else {
        // 尝试确保二进制文件可用
        const binPath = await this.ensureBinaries(version, onProgress)
        const ext = platformService.getExecutableExtension()
        mongod = join(binPath, 'bin', `mongod${ext}`)

        if (!existsSync(mongod)) {
          throw new Error(
            `MongoDB ${version} 未安装。` +
              `请运行：spindb engines download mongodb ${version}`,
          )
        }
      }
    }

    logDebug(`正在使用版本 ${version} 的 mongod：${mongod}`)

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')

    onProgress?.({ stage: 'starting', message: '正在启动 MongoDB...' })

    const args = [
      '--dbpath',
      dataDir,
      '--port',
      String(port),
      '--bind_ip',
      container.bindAddress ?? '127.0.0.1',
      '--logpath',
      logFile,
      '--logappend',
    ]

    // 如果启用了认证，则要求客户端提供凭据
    if (container.authEnabled) {
      args.push('--auth')
    }

    // 注意：macOS（Sonoma 及以上版本）不支持 --fork，因此我们在 macOS 和 Windows 上
    // 使用分离式 spawn。只有 Linux 仍然支持 --fork。
    const { platform } = platformService.getPlatformInfo()
    const useDetachedSpawn =
      platform === Platform.Win32 || platform === Platform.Darwin

    if (!useDetachedSpawn) {
      // Linux：可以使用 --fork 进行原生守护进程化
      args.push('--fork')
    }

    logDebug(`启动 mongod，参数：${args.join(' ')}`)

    if (useDetachedSpawn) {
      // macOS/Windows：以分离模式启动进程
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      }
      if (isWindows()) {
        spawnOpts.windowsHide = true
      }

      const proc = spawn(mongod, args, spawnOpts)

      proc.unref()

      // 写入 PID 文件
      if (proc.pid) {
        await writeFile(pidFile, String(proc.pid))
      }
    } else {
      // Linux：mongod --fork 自行处理守护进程化
      return new Promise((resolve, reject) => {
        const proc = spawn(mongod, args, {
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

        proc.on('close', async (code) => {
          if (code === 0) {
            // MongoDB 分叉成功，等待其就绪
            const ready = await this.waitForReady(container)
            if (ready) {
              // 从锁文件读取 PID
              const lockFile = join(dataDir, 'mongod.lock')
              try {
                const pid = await readFile(lockFile, 'utf8')
                await writeFile(pidFile, pid.trim())
              } catch {
                // 锁文件可能尚不存在
              }
              resolve({
                port,
                connectionString: this.getConnectionString(container),
              })
            } else {
              reject(new Error('MongoDB 在超时时间内未能启动'))
            }
          } else {
            reject(
              new Error(stderr || stdout || `mongod 以退出码 ${code} 退出`),
            )
          }
        })

        proc.on('error', reject)
      })
    }

    // 等待 MongoDB 就绪（Windows 路径）
    const ready = await this.waitForReady(container)
    if (!ready) {
      throw new Error('MongoDB 在超时时间内未能启动')
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // 检查 TCP 端口是否正在接受连接
  private checkPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.connect(port, '127.0.0.1')
    })
  }

  private async getLocalAuth(
    containerName: string,
  ): Promise<LocalMongoAuth | null> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.MongoDB,
      getDefaultUsername(Engine.MongoDB),
    )
    if (!savedCreds) {
      return null
    }

    return {
      username: savedCreds.username,
      password: savedCreds.password,
      authDatabase: savedCreds.database || 'admin',
    }
  }

  private async buildLocalMongoshArgs(
    container: ContainerConfig,
    database: string,
    options?: { quiet?: boolean },
  ): Promise<string[]> {
    const savedCreds = await this.getLocalAuth(container.name)
    const host = normalizeMongoHost(container.bindAddress)
    const args = savedCreds
      ? [
          buildMongoUri(
            container.port,
            database,
            savedCreds,
            host,
          ),
        ]
      : ['--host', host, '--port', String(container.port), database]

    if (options?.quiet) {
      args.push('--quiet')
    }

    return args
  }

  private async runLocalMongosh(
    container: ContainerConfig,
    database: string,
    options: { eval?: string; file?: string; quiet?: boolean; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const mongosh = await this.getMongoshPath()
    const args = await this.buildLocalMongoshArgs(container, database, {
      quiet: options.quiet,
    })

    if (options.eval) {
      args.push('--eval', options.eval)
    }
    if (options.file) {
      args.push('--file', options.file)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(mongosh, args, {
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

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(
          new Error(
            `${options.file ? 'mongosh 文件执行' : 'mongosh 命令'}在 ${(options.timeoutMs ?? 10000) / 1000} 秒后超时`,
          ),
        )
      }, options.timeoutMs ?? 10000)

      proc.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(stderr || `mongosh 以退出码 ${code} 退出`))
          return
        }
        resolve({ stdout, stderr })
      })
    })
  }

  /**
   * 等待 MongoDB 就绪，可以接受连接
   *
   * 根据工具可用性使用两种策略：
   * 1. **首选（mongosh 可用）**：通过 mongosh 执行 `db.runCommand({ping:1})`
   *    验证 MongoDB 已完全运行并可以响应命令。
   * 2. **回退（mongosh 不可用）**：通过 checkPortOpen() 进行 TCP 端口检查。
   *    TCP 连通性检查不如 mongosh ping 全面——它只能确认端口正在接受连接，
   *    而不能确认 MongoDB 已完全初始化并准备好处理查询。但对于本地开发容器，
   *    这是可接受的，因为 MongoDB 通常在就绪后很快就会开始接受连接，
   *    而且这避免了要求安装 mongosh。
   */
  private async waitForReady(
    container: ContainerConfig,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const { port } = container
    const startTime = Date.now()
    const checkInterval = 500

    const mongosh = await configManager.getBinaryPath('mongosh')
    if (!mongosh) {
      // 回退：当 mongosh 不可用时使用 TCP 端口检查
      // 不如 db.runCommand({ping:1}) 全面，但对本地开发容器已足够
      logDebug(
        `未找到 mongosh，对端口 ${port} 上的 MongoDB 使用 TCP 端口检查`,
      )
      while (Date.now() - startTime < timeoutMs) {
        const isOpen = await this.checkPortOpen(port)
        if (isOpen) return true
        await new Promise((r) => setTimeout(r, checkInterval))
      }
      return false
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.runLocalMongosh(container, 'admin', {
          eval: 'db.runCommand({ping:1})',
          quiet: true,
          timeoutMs: 5000,
        })
        return true
      } catch {
        // mongosh 可能因 --auth 而失败。回退到 TCP 端口检查——
        // 端口上有任何监听器即表示 mongod 已启动，即使需要认证。
        const isOpen = await this.checkPortOpen(port)
        if (isOpen) return true
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    return false
  }

  /**
   * 停止 MongoDB 服务
   * 通过 mongosh 执行 db.adminCommand({shutdown:1}) 或发送 SIGTERM 信号
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')
    const lockFile = join(dataDir, 'mongod.lock')

    logDebug(`正在停止端口 ${port} 上的 MongoDB 容器 "${name}"`)

    // 尝试通过 mongosh 优雅关闭
    const mongosh = await configManager.getBinaryPath('mongosh')
    if (mongosh) {
      try {
        await this.runLocalMongosh(container, 'admin', {
          eval: 'db.adminCommand({shutdown:1})',
          timeoutMs: 10000,
        })
        logDebug('已发送 MongoDB 关闭命令')
        // 等待进程退出
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`mongosh 关闭失败：${error}`)
        // 继续执行基于 PID 的关闭
      }
    }

    // 获取 PID，必要时强制终止
    let pid: number | null = null

    // 首先尝试 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // 忽略
      }
    }

    // 如果 PID 文件中没有获取到 PID，尝试锁文件
    if (!pid && existsSync(lockFile)) {
      try {
        const content = await readFile(lockFile, 'utf8')
        const parsed = parseInt(content.trim(), 10)
        if (!isNaN(parsed) && parsed > 0) {
          pid = parsed
        }
      } catch {
        // 忽略
      }
    }

    // 如果进程仍在运行则终止
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`正在终止 MongoDB 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，正在强制终止进程 ${pid}`)
          await platformService.terminateProcess(pid, true)
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

    logDebug('MongoDB 已停止')
  }

  // 获取 MongoDB 服务状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')
    const lockFile = join(dataDir, 'mongod.lock')

    // 尝试使用 mongosh 进行 ping 检测
    const mongosh = await configManager.getBinaryPath('mongosh')
    if (mongosh) {
      try {
        await this.runLocalMongosh(container, 'admin', {
          eval: 'db.runCommand({ping:1})',
          quiet: true,
          timeoutMs: 5000,
        })
        return { running: true, message: 'MongoDB 正在运行' }
      } catch {
        // 未响应，检查 PID
      }
    }

    // 检查 PID 文件
    for (const file of [pidFile, lockFile]) {
      if (existsSync(file)) {
        try {
          const content = await readFile(file, 'utf8')
          const pid = parseInt(content.trim(), 10)
          if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
            return {
              running: true,
              message: `MongoDB 正在运行（PID：${pid}）`,
            }
          }
        } catch {
          // 忽略
        }
      }
    }

    return { running: false, message: 'MongoDB 未运行' }
  }

  // 检测备份格式
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  // 恢复备份
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { port, version } = container
    const database = (options.database as string) || container.database

    return restoreBackup(backupPath, {
      containerName: container.name,
      port,
      database,
      drop: options.drop !== false,
      validateVersion: options.validateVersion !== false,
      containerVersion: version,
    })
  }

  // 获取连接字符串
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'test'
    return `mongodb://127.0.0.1:${port}/${db}`
  }

  // 获取 mongosh 路径
  override async getMongoshPath(): Promise<string> {
    const cached = await configManager.getBinaryPath('mongosh')
    if (cached && existsSync(cached)) return cached

    // 尝试从 PATH 中查找作为回退
    const detected = await platformService.findToolPath('mongosh')
    if (detected) {
      await configManager.setBinaryPath('mongosh', detected, 'system')
      return detected
    }

    throw new Error(
      '未找到 mongosh。请下载 MongoDB 二进制文件：\n' +
        '  运行：spindb engines download mongodb <version>\n' +
        '  或从以下地址安装 mongosh：https://www.mongodb.com/try/download/shell',
    )
  }

  // 打开 mongosh 交互式 Shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const db = database || container.database || 'test'

    const mongosh = await this.getMongoshPath()
    const args = await this.buildLocalMongoshArgs(container, db)

    // 注意：不要使用 shell 模式——spawn 在 shell: false（默认值）时
    // 能正确处理包含空格的路径。Shell 模式会破坏类似 "C:\Program Files\..." 的路径
    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(mongosh, args, spawnOptions)

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * MongoDB 在首次写入时隐式创建数据库。
   * 为强制立即创建，我们创建一个临时集合并将其删除。
   * 这样可以在不留下任何标记集合的情况下使数据库在工具中可见。
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)

    // MongoDB 在首次写入时隐式创建数据库。
    // 创建一个临时集合并立即删除，以强制创建数据库
    // 而不留下任何可见的标记集合。
    // 首先删除任何已有的 _spindb_init 集合（忽略错误），然后创建并删除。
    // 这确保即使之前的 createDatabase 被中断也能正确清理。
    // 注意：使用 db.getCollection() 而不是 db._spindb_init 简写形式，因为
    // mongosh 不支持下划线开头的集合名使用简写形式。
    await this.runLocalMongosh(container, database, {
      eval: 'try { db.getCollection("_spindb_init").drop(); } catch(e) {} db.createCollection("_spindb_init"); db.getCollection("_spindb_init").drop();',
      timeoutMs: 10000,
    })
  }

  // 删除数据库
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)

    try {
      await this.runLocalMongosh(container, database, {
        eval: 'db.dropDatabase()',
        timeoutMs: 10000,
      })
    } catch (error) {
      const err = error as Error
      // 忽略"数据库不存在"的情况
      logDebug(`dropDatabase 结果：${err.message}`)
    }
  }

  // 获取数据库大小（字节）
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { database } = container
    const db = database || 'test'

    try {
      const { stdout } = await this.runLocalMongosh(container, db, {
        eval: 'JSON.stringify(db.stats())',
        quiet: true,
        timeoutMs: 10000,
      })

      // 防御性地从输出中提取 JSON（可能包含额外消息）
      const stats = extractJson(stdout) as { dataSize?: number } | null
      return stats?.dataSize || null
    } catch {
      return null
    }
  }

  // 从远程数据库创建转储
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const mongodump = await getMongodumpPath()
    if (!mongodump) {
      throw new Error(MONGODUMP_NOT_FOUND_ERROR)
    }

    const parsed = parseConnectionString(connectionString)

    // 始终使用 --uri 以避免将凭据作为单独的 CLI 参数暴露
    // URI 将凭据嵌入其中（在进程列表中仍然可见，
    // 但这是 MongoDB 推荐的方式，且能处理所有边界情况）
    const args = [
      '--uri',
      connectionString,
      '--db',
      parsed.database,
      '--archive=' + outputPath,
      '--gzip',
    ]

    // 注意：不要使用 shell 模式——spawn 在 shell: false（默认值）时
    // 能正确处理包含空格的路径。Shell 模式会破坏类似 "C:\Program Files\..." 的路径
    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(mongodump, args, spawnOptions)

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
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code,
          })
        } else {
          reject(new Error(stderr || `mongodump 以退出码 ${code} 退出`))
        }
      })
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

  // 对数据库执行 JavaScript 文件或内联脚本
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const db = options.database || container.database || 'test'

    if (options.file) {
      await this.runLocalMongosh(container, db, {
        file: options.file,
        timeoutMs: 60000,
      })
    } else if (options.sql) {
      // 执行内联脚本（使用 sql 字段以保持兼容性，但实际执行的是 JS）
      const { stdout, stderr } = await this.runLocalMongosh(container, db, {
        eval: options.sql,
        timeoutMs: 60000,
      })
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'test'
    const normalizedHost = normalizeMongoHost(container.bindAddress)

    const mongosh = await this.getMongoshPath()

    // 拒绝 "use " Shell 辅助命令——它不适用于 JSON 输出
    const trimmedQuery = query.trim()
    if (trimmedQuery.toLowerCase().startsWith('use ')) {
      throw new Error(
        'executeQuery 中不支持 "use" 命令。' +
          '要切换数据库，请设置 options.database 或 container.database。',
      )
    }

    // 如果尚未包含 db. 前缀，则自动添加（用于集合方法）
    // 但不对 Shell 辅助函数添加前缀
    let script = trimmedQuery
    const shellFunctions = [
      'print',
      'printjson',
      'sleep',
      'ObjectId',
      'ISODate',
      'NumberLong',
      'NumberInt',
      'NumberDecimal',
      'UUID',
      'BinData',
      'Timestamp',
      'MinKey',
      'MaxKey',
    ]
    const startsWithShellFunction = shellFunctions.some(
      (fn) => script.startsWith(`${fn}(`) || script.startsWith(`${fn} (`),
    )
    if (!script.startsWith('db.') && !startsWithShellFunction) {
      script = `db.${script}`
    }

    // 使用 JSON.stringify 包装以生成可解析的输出
    // 同时处理 toArray() 结果和单文档结果
    const wrappedScript = `JSON.stringify(${script})`

    // 构建参数数组（通过不经过 Shell 传递来避免 Shell 注入）
    let args: string[]
    if (options?.host) {
      // 远程：为 mongosh 构建连接 URI
      const user = options.username ? encodeURIComponent(options.username) : ''
      const pass = options.password ? encodeURIComponent(options.password) : ''
      const auth = user ? `${user}:${pass}@` : ''
      const host = options.host
      const isSrv = options.scheme === 'mongodb+srv'
      const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
      const portSuffix = isSrv ? '' : `:${port}`
      const sslParam = options.ssl && !isSrv ? 'tls=true' : ''
      const uri = `${scheme}://${auth}${host}${portSuffix}/${db}${sslParam ? `?${sslParam}` : ''}`
      args = [uri, '--quiet', '--eval', wrappedScript]
    } else if (options?.password) {
      // 本地带认证：构建包含凭据的 URI
      const uri = buildMongoUri(port, db, {
        username: options.username || 'admin',
        password: options.password,
        authDatabase: 'admin',
      }, normalizedHost)
      args = [uri, '--quiet', '--eval', wrappedScript]
    } else {
      const savedCreds = await this.getLocalAuth(container.name)
      args = savedCreds
        ? [
            buildMongoUri(
              port,
              db,
              savedCreds,
              normalizedHost,
            ),
            '--quiet',
            '--eval',
            wrappedScript,
          ]
        : [
            '--host',
            normalizedHost,
            '--port',
            String(port),
            db,
            '--quiet',
            '--eval',
            wrappedScript,
          ]
    }

    const { stdout, stderr } = await new Promise<{
      stdout: string
      stderr: string
    }>((resolve, reject) => {
      const proc = spawn(mongosh, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdoutBuf = ''
      let stderrBuf = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString()
      })

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error('查询在 60 秒后超时'))
      }, 60000)

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(
            new Error(
              `${stderrBuf || `mongosh 以退出码 ${code} 退出`}${stdoutBuf ? `\n输出：${stdoutBuf}` : ''}`,
            ),
          )
          return
        }
        resolve({ stdout: stdoutBuf, stderr: stderrBuf })
      })
    })

    if (stderr && !stdout.trim()) {
      throw new Error(`${stderr}${stdout ? `\n输出：${stdout}` : ''}`)
    }

    // 从输出中提取 JSON（mongosh 可能包含额外输出）
    const jsonMatch = stdout.match(/\[[\s\S]*\]|\{[\s\S]*\}/)
    if (!jsonMatch) {
      // 处理标量结果
      return {
        columns: ['result'],
        rows: [{ result: stdout.trim() }],
        rowCount: 1,
      }
    }

    return parseMongoDBResult(jsonMatch[0])
  }

  /**
   * 列出所有用户数据库，排除系统数据库（admin、config、local）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const mongosh = await this.getMongoshPath()

    return new Promise((resolve, reject) => {
      // 使用 JSON 输出以实现可靠解析
      const script = `JSON.stringify(db.adminCommand({listDatabases: 1}).databases.map(d => d.name))`
      const launch = async () => {
        const args = await this.buildLocalMongoshArgs(container, 'admin', {
          quiet: true,
        })
        args.push('--eval', script)
        const proc = spawn(mongosh, args, {
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
            reject(new Error(stderr || `mongosh 以退出码 ${code} 退出`))
            return
          }

          try {
            const allDatabases = JSON.parse(stdout.trim()) as string[]
            const systemDatabases = ['admin', 'config', 'local']
            const databases = allDatabases.filter(
              (db) => !systemDatabases.includes(db),
            )
            resolve(databases)
          } catch (error) {
            reject(new Error(`解析数据库列表失败：${error}`))
          }
        })
      }

      void launch().catch(reject)
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port } = container
    const db = database || container.database || 'admin'
    assertValidDatabaseName(db)
    const mongosh = await this.getMongoshPath()

    // 在目标数据库上创建具有 readWrite 角色的用户
    // 无论认证模式如何都会创建用户。当 authEnabled=true 时，会向 mongod 传递 --auth，
    // 连接时需要提供凭据。
    // 使用 JSON.stringify 对密码进行转义，以在 JS 上下文中安全处理所有特殊字符
    // 通过 stdin 传递脚本以避免在进程列表中暴露密码
    const jsonPwd = JSON.stringify(password)
    const script = `db.getSiblingDB('${db}').createUser({user:'${username}',pwd:${jsonPwd},roles:[{role:'readWrite',db:'${db}'}]})`

    const mongoshArgs = await this.buildLocalMongoshArgs(container, 'admin')

    const runMongoshViaStdin = (js: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(mongosh, mongoshArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stderr = ''
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM')
          reject(new Error('mongosh 在 10 秒后超时'))
        }, 10000)

        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })

        proc.on('close', (code) => {
          clearTimeout(timeout)
          if (code === 0) resolve()
          else reject(new Error(stderr || `mongosh 以退出码 ${code} 退出`))
        })

        proc.stdin?.write(js)
        proc.stdin?.end()
      })

    try {
      await runMongoshViaStdin(script)
    } catch (error) {
      const err = error as Error
      if (
        err.message.includes('51003') ||
        err.message.includes('already exists')
      ) {
        // 用户已存在——更新密码
        const updateScript = `db.getSiblingDB('${db}').updateUser('${username}',{pwd:${jsonPwd}})`
        await runMongoshViaStdin(updateScript)
      } else {
        throw error
      }
    }

    const connectionString = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const mongodbEngine = new MongoDBEngine()
