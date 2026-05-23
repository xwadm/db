/**
 * MariaDB 引擎实现
 * 使用来自 hostdb 的预构建二进制文件管理 MariaDB 数据库容器
 */

import { spawn, exec, type SpawnOptions } from 'child_process'
import { existsSync, createReadStream } from 'fs'
import { mkdir, writeFile, readFile, unlink, rm } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import {
  platformService,
  isWindows,
} from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import {
  logDebug,
  logWarning,
  ErrorCodes,
  SpinDBError,
  assertValidDatabaseName,
  assertValidUsername,
} from '../../core/error-handler'
import { mariadbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { fetchAvailableVersions, getLatestVersion } from './hostdb-releases'
import { SUPPORTED_MAJOR_VERSIONS, MARIADB_VERSION_MAP } from './version-maps'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import { buildMariaDbEnv } from './env'
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
import { parseTSVToQueryResult } from '../../core/query-parser'
import { getLibraryEnv, detectLibraryError } from '../../core/library-env'

const ENGINE = 'mariadb'
const engineDef = getEngineDefaults(ENGINE)

type LocalMariaDbAuth = {
  user: string
  password?: string
}

/**
 * 运行 MariaDB 二进制文件并返回输出结果
 * 支持超时控制和密码传递
 */
async function runMariaDbBinary(
  binaryPath: string,
  args: string[],
  options: {
    password?: string
    timeout?: number
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildMariaDbEnv(options.password),
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutId: NodeJS.Timeout | undefined
    let timeoutError: Error | null = null

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (error) {
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    }

    // 设置超时，超时后终止进程
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timeoutError = new Error(
          `mariadb 命令在 ${options.timeout}ms 后超时`,
        )
        proc.kill()
      }, options.timeout)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      finish(error)
    })

    proc.on('close', (code) => {
      if (timeoutError) {
        finish(timeoutError)
        return
      }
      if (code === 0) {
        finish()
        return
      }
      finish(new Error(stderr || `mariadb 以退出码 ${code} 退出`))
    })
  })
}

export class MariaDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MariaDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  /** 获取本地管理员认证信息 */
  private async getLocalAdminAuth(
    containerName: string,
  ): Promise<LocalMariaDbAuth> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.MariaDB,
      getDefaultUsername(Engine.MariaDB),
    )

    return {
      user: savedCreds?.username || engineDef.superuser,
      password: savedCreds?.password,
    }
  }

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

  /** 解析完整版本号，支持主版本和完整版本 */
  resolveFullVersion(version: string): string {
    // 检查是否已经是完整版本（至少包含两个点号）
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    // 是主版本，使用回退映射表解析
    return MARIADB_VERSION_MAP[version] || `${version}.0`
  }

  async resolveFullVersionAsync(version: string): Promise<string> {
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    return getLatestVersion(version)
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  getBinaryUrl(version: string, plat: Platform, arc: Arch): string {
    return getBinaryUrl(version, plat, arc)
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const parts = binPath.split('-')
    const version = parts[1]
    return mariadbBinaryManager.verify(version, p, a)
  }

  /** 确保二进制文件已安装，必要时下载并注册所有 MariaDB 工具 */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await mariadbBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // 注册下载包中所有 MariaDB 二进制文件
    // 仅使用原生名称（不使用 mysql 命名的文件，以避免与 MySQL 引擎冲突）
    const ext = platformService.getExecutableExtension()
    const tools = [
      'mariadbd',
      'mariadb-admin',
      'mariadb',
      'mariadb-dump',
    ] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      } else {
        logDebug(`未找到预期的 MariaDB 二进制文件`, { tool, toolPath })
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return mariadbBinaryManager.isInstalled(version, p, a)
  }

  /** 初始化 MariaDB 数据目录 */
  async initDataDir(
    containerName: string,
    version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    let createdDataDir = false

    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      createdDataDir = true
    }

    // 初始化失败时清理数据目录
    const cleanupOnFailure = async () => {
      if (createdDataDir) {
        try {
          await rm(dataDir, { recursive: true, force: true })
          logDebug(`初始化失败后已清理数据目录：${dataDir}`)
        } catch (cleanupErr) {
          logDebug(
            `清理数据目录失败：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          )
        }
      }
    }

    // 优先尝试 mariadb-install-db，然后尝试 mysql_install_db
    let installDb = join(binPath, 'scripts', `mariadb-install-db${ext}`)
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'scripts', `mysql_install_db${ext}`)
    }
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'bin', `mariadb-install-db${ext}`)
    }
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'bin', `mysql_install_db${ext}`)
    }

    if (!existsSync(installDb)) {
      await cleanupOnFailure()
      throw new Error(
        `MariaDB 初始化脚本未在 ${binPath} 中找到。\n` +
          '请重新下载 MariaDB 二进制文件：spindb engines download mariadb',
      )
    }

    // MariaDB 初始化
    // Windows 的 mariadb-install-db.exe 支持的选项有限
    // Unix 支持 --auth-root-authentication-method=normal 用于无密码 root 登录
    if (isWindows()) {
      // Windows 的 mariadb-install-db.exe 仅支持 --datadir
      // 不支持 --auth-root-authentication-method 或 --basedir 选项
      const cmd = `"${installDb}" --datadir="${dataDir}"`

      return new Promise((resolve, reject) => {
        exec(
          cmd,
          {
            timeout: 120000,
            env: { ...process.env, ...getLibraryEnv(binPath) },
          },
          async (error, stdout, stderr) => {
            if (error) {
              await cleanupOnFailure()
              const libError = detectLibraryError(
                stderr || stdout || error.message,
                'MariaDB',
              )
              reject(
                new Error(
                  libError ||
                    `MariaDB 初始化失败，退出码 ${error.code}：${stderr || stdout || error.message}`,
                ),
              )
            } else {
              resolve(dataDir)
            }
          },
        )
      })
    }

    // Unix 路径（Linux/macOS）
    // --no-defaults：防止读取可能包含 MySQL 特定选项的系统 my.cnf 文件
    // --auth-root-authentication-method=normal：允许本地开发时无密码 root 登录
    // --user：非 root 用户运行时必需，但以 root 运行时可跳过以避免
    //         需要系统中存在专用的 'mysql' 用户
    const isRunningAsRoot = process.getuid?.() === 0
    const args = [
      '--no-defaults',
      `--datadir=${dataDir}`,
      '--auth-root-authentication-method=normal',
      `--basedir=${binPath}`,
    ]

    // 仅在非 root 运行时添加 --user
    // 以 root 运行时，mariadb-install-db 无需指定用户即可工作
    if (!isRunningAsRoot && process.env.USER) {
      args.push(`--user=${process.env.USER}`)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(installDb, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...getLibraryEnv(binPath) },
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
          resolve(dataDir)
        } else {
          await cleanupOnFailure()
          const libError = detectLibraryError(stderr || stdout, 'MariaDB')
          reject(
            new Error(
              libError ||
                `MariaDB 初始化失败，退出码 ${code}：${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', async (err) => {
        await cleanupOnFailure()
        reject(err)
      })
    })
  }

  /** 启动 MariaDB 容器 */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version } = container

    const alreadyRunning = await this.isRunning(name)
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()

    // 优先尝试 mariadbd，然后尝试 mysqld
    let mysqld = join(binPath, 'bin', `mariadbd${ext}`)
    if (!existsSync(mysqld)) {
      mysqld = join(binPath, 'bin', `mysqld${ext}`)
    }

    if (!existsSync(mysqld)) {
      throw new Error(
        `MariaDB 服务器二进制文件未在 ${binPath}/bin/ 中找到。\n` +
          '请重新下载 MariaDB 二进制文件：spindb engines download mariadb',
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const { platform } = platformService.getPlatformInfo()

    onProgress?.({ stage: 'starting', message: '正在启动 MariaDB...' })

    // --no-defaults：关键 - 防止读取可能包含 MySQL 特定选项的系统 my.cnf 文件
    // 例如 MariaDB 不支持的 mysqlx-bind-address
    const args = [
      '--no-defaults',
      `--datadir=${dataDir}`,
      `--port=${port}`,
      `--pid-file=${pidFile}`,
      `--log-error=${logFile}`,
      `--bind-address=${container.bindAddress ?? '127.0.0.1'}`,
      `--max-connections=${engineDef.maxConnections}`,
      '--host-cache-size=0',
    ]

    if (platform !== Platform.Win32) {
      const socketFile = join(
        paths.getContainerPath(name, { engine: ENGINE }),
        'mysql.sock',
      )
      args.push(`--socket=${socketFile}`)
    }

    let proc: ReturnType<typeof spawn> | null = null

    const libraryEnv = getLibraryEnv(binPath)

    if (isWindows()) {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
        env: { ...process.env, ...libraryEnv },
      })

      proc.unref()
    } else {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        env: { ...process.env, ...libraryEnv },
      })
      proc.unref()
    }

    return new Promise((resolve, reject) => {
      // 跟踪 Promise 是否已解决，避免竞态条件
      let settled = false

      const errorHandler = (err: Error) => {
        if (settled) return
        settled = true
        if (proc) {
          proc.removeListener('error', errorHandler)
        }
        reject(err)
      }

      if (proc) {
        proc.on('error', errorHandler)
      }

      setTimeout(async () => {
        if (proc && proc.pid) {
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch (error) {
            logDebug(`无法写入 PID 文件：${error}`)
          }
        }

        // 等待 MariaDB 就绪
        let attempts = 0
        const maxAttempts = 60
        const checkInterval = 500

        const checkReady = async () => {
          if (settled) return
          attempts++
          try {
            const mysqladmin = await this.getMysqladminPath()
            const auth = await this.getLocalAdminAuth(container.name)
            await runMariaDbBinary(
              mysqladmin,
              ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, 'ping'],
              {
                password: auth.password,
              },
            )
            if (settled) return
            settled = true
            if (proc) {
              proc.removeListener('error', errorHandler)
            }
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } catch {
            if (settled) return
            if (attempts < maxAttempts) {
              setTimeout(checkReady, checkInterval)
            } else {
              if (settled) return
              settled = true
              if (proc) {
                proc.removeListener('error', errorHandler)
              }

              // 检查日志文件中的库错误
              let libError: string | null = null
              try {
                const logContent = await readFile(logFile, 'utf-8')
                libError = detectLibraryError(logContent, 'MariaDB')
              } catch {
                // 日志文件可能不存在
              }

              reject(
                new Error(libError || 'MariaDB 未能在超时时间内启动'),
              )
            }
          }
        }

        checkReady()
      }, 1000)
    })
  }

  /** 检查容器是否正在运行 */
  private async isRunning(containerName: string): Promise<boolean> {
    const pidFile = paths.getContainerPidPath(containerName, { engine: ENGINE })
    if (!existsSync(pidFile)) {
      return false
    }

    try {
      const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
      return platformService.isProcessRunning(pid)
    } catch {
      return false
    }
  }

  /** 停止 MariaDB 容器 */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const auth = await this.getLocalAdminAuth(name)

    logDebug(`正在停止端口 ${port} 上的 MariaDB 容器 "${name}"`)

    const pid = await this.getValidatedPid(pidFile)
    if (pid === null) {
      logDebug('没有有效的 PID，检查 MariaDB 是否在端口上响应')
      try {
        const mysqladmin = await this.getMysqladminPath()
        await runMariaDbBinary(
          mysqladmin,
          ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, 'ping'],
          {
            timeout: 2000,
            password: auth.password,
          },
        )
        logWarning(`MariaDB 在端口 ${port} 上响应但没有有效的 PID 文件`)
        await this.gracefulShutdown(port, auth)
      } catch {
        logDebug('MariaDB 未响应，无需停止')
      }
      return
    }

    const gracefulSuccess = await this.gracefulShutdown(port, auth, pid)
    if (gracefulSuccess) {
      await this.cleanupPidFile(pidFile)
      logDebug('MariaDB 已优雅停止')
      return
    }

    await this.forceKillWithEscalation(pid, pidFile)
  }

  /** 验证 PID 文件中的进程是否有效 */
  private async getValidatedPid(pidFile: string): Promise<number | null> {
    if (!existsSync(pidFile)) {
      logDebug('PID 文件不存在')
      return null
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      const pid = parseInt(content.trim(), 10)

      if (isNaN(pid) || pid <= 0) {
        logWarning(`PID 文件包含无效值："${content.trim()}"`)
        await this.cleanupPidFile(pidFile)
        return null
      }

      if (platformService.isProcessRunning(pid)) {
        logDebug(`已验证 PID ${pid}`)
        return pid
      } else {
        logWarning(`PID 文件引用的进程 ${pid} 不存在`)
        await this.cleanupPidFile(pidFile)
        return null
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logWarning(`读取 PID 文件失败：${e.message}`)
      }
      return null
    }
  }

  /** 尝试优雅关闭 MariaDB */
  private async gracefulShutdown(
    port: number,
    auth: LocalMariaDbAuth,
    pid?: number,
    timeoutMs = 10000,
  ): Promise<boolean> {
    try {
      const mysqladmin = await this.getMysqladminPath()
      logDebug('正在尝试 mysqladmin 关闭')
      await runMariaDbBinary(
        mysqladmin,
        ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, 'shutdown'],
        {
          timeout: 5000,
          password: auth.password,
        },
      )
    } catch (error) {
      const e = error as Error
      logDebug(`mysqladmin 关闭失败：${e.message}`)
      if (pid) {
        try {
          await platformService.terminateProcess(pid, false)
        } catch {
          return true
        }
      }
    }

    if (pid) {
      const startTime = Date.now()
      const checkIntervalMs = 200

      while (Date.now() - startTime < timeoutMs) {
        if (!platformService.isProcessRunning(pid)) {
          logDebug(`进程 ${pid} 在优雅关闭后已终止`)
          return true
        }
        await this.sleep(checkIntervalMs)
      }

      logDebug(`优雅关闭在 ${timeoutMs}ms 后超时`)
      return false
    }

    return true
  }

  /** 强制终止进程，逐步升级终止方式 */
  private async forceKillWithEscalation(
    pid: number,
    pidFile: string,
  ): Promise<void> {
    logWarning(`优雅关闭失败，正在强制终止进程 ${pid}`)

    try {
      await platformService.terminateProcess(pid, false)
      await this.sleep(2000)

      if (!platformService.isProcessRunning(pid)) {
        logDebug(`进程 ${pid} 在优雅信号后已终止`)
        await this.cleanupPidFile(pidFile)
        return
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`优雅终止失败：${e.message}`)
    }

    const { platform } = platformService.getPlatformInfo()
    const killCmd = platform === Platform.Win32 ? 'taskkill /F' : 'kill -9'
    logWarning(`正在升级为强制终止进程 ${pid}`)
    try {
      await platformService.terminateProcess(pid, true)
      await this.sleep(1000)

      if (platformService.isProcessRunning(pid)) {
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `即使使用强制终止也无法停止 MariaDB 进程 ${pid}`,
          'error',
          `请尝试手动终止进程：${killCmd} ${pid}`,
        )
      }
      logDebug(`进程 ${pid} 在强制终止后已终止`)
      await this.cleanupPidFile(pidFile)
    } catch (error) {
      if (error instanceof SpinDBError) throw error
      const e = error as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`强制终止失败：${e.message}`)
    }
  }

  /** 清理 PID 文件 */
  private async cleanupPidFile(pidFile: string): Promise<void> {
    try {
      await unlink(pidFile)
      logDebug('PID 文件已清理')
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logDebug(`清理 PID 文件失败：${e.message}`)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 获取容器运行状态 */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    if (!existsSync(pidFile)) {
      return { running: false, message: 'MariaDB 未运行' }
    }

    try {
      const mysqladmin = await this.getMysqladminPath()
      const auth = await this.getLocalAdminAuth(name)
      await runMariaDbBinary(
        mysqladmin,
        ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, 'ping'],
        {
          password: auth.password,
        },
      )
      return { running: true, message: 'MariaDB 正在运行' }
    } catch {
      return { running: false, message: 'MariaDB 未响应' }
    }
  }

  /** 检测备份文件格式 */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /** 从备份文件恢复数据库 */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { name, port, version } = container
    const database = (options.database as string) || container.database
    const binPath = this.getBinaryPath(version)
    const auth = await this.getLocalAdminAuth(name)

    if (options.createDatabase !== false) {
      await this.createDatabase(container, database)
    }

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database,
      user: auth.user,
      password: auth.password,
      createDatabase: false,
      validateVersion: options.validateVersion !== false,
      binPath,
    })
  }

  /** 获取数据库连接字符串 */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'mysql'
    return `mysql://${engineDef.superuser}@127.0.0.1:${port}/${db}`
  }

  /** 获取 mariadb 客户端路径 */
  override async getMariadbClientPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mariadb')
    if (configPath) return configPath

    throw new Error(
      '未找到 mariadb 客户端。请确保已下载 MariaDB 二进制文件：\n' +
        '  spindb engines download mariadb',
    )
  }

  /** 获取 mariadb-admin 路径 */
  override async getMysqladminPath(): Promise<string> {
    const cfg = await configManager.getBinaryPath('mariadb-admin')
    if (cfg) return cfg

    throw new Error(
      '未找到 mariadb-admin。请确保已下载 MariaDB 二进制文件：\n' +
        '  spindb engines download mariadb',
    )
  }

  /** 连接到 MariaDB 交互式客户端 */
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { name, port } = container
    const db = database || container.database || 'mysql'

    const mysql = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      env: buildMariaDbEnv(auth.password),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        mysql,
        ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /** 创建数据库 */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { name, port } = container

    const mysql = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    try {
      await runMariaDbBinary(
        mysql,
        [
          '-h',
          '127.0.0.1',
          '-P',
          String(port),
          '-u',
          auth.user,
          '-e',
          `CREATE DATABASE IF NOT EXISTS \`${database}\``,
        ],
        {
          password: auth.password,
        },
      )
    } catch (error) {
      const err = error as Error
      if (!err.message.includes('database exists')) {
        throw error
      }
    }
  }

  /** 删除数据库 */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { name, port } = container

    const mysql = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    try {
      await runMariaDbBinary(
        mysql,
        [
          '-h',
          '127.0.0.1',
          '-P',
          String(port),
          '-u',
          auth.user,
          '-e',
          `DROP DATABASE IF EXISTS \`${database}\``,
        ],
        {
          password: auth.password,
        },
      )
    } catch (error) {
      const err = error as Error
      if (!err.message.includes("database doesn't exist")) {
        throw error
      }
    }
  }

  /** 获取数据库大小（字节） */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { name, port, database } = container
    const db = database || 'mysql'

    assertValidDatabaseName(db)

    try {
      const mysql = await this.getMariadbClientPath()
      const auth = await this.getLocalAdminAuth(name)

      const { stdout } = await runMariaDbBinary(
        mysql,
        [
          '-h',
          '127.0.0.1',
          '-P',
          String(port),
          '-u',
          auth.user,
          '-N',
          '-e',
          `SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = '${db}'`,
        ],
        {
          password: auth.password,
        },
      )
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      return null
    }
  }

  /** 从连接字符串导出数据库 */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const dumpPath = await this.getDumpPath()

    const { host, port, user, password, database } =
      parseConnectionString(connectionString)

    const args = [
      '-h',
      host,
      '-P',
      port,
      '-u',
      user,
      '--result-file',
      outputPath,
      database,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildMariaDbEnv(password),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(dumpPath, args, spawnOptions)

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
          reject(new Error(stderr || `mariadb-dump 以退出码 ${code} 退出`))
        }
      })
    })
  }

  /** 获取 mariadb-dump 工具路径 */
  private async getDumpPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mariadb-dump')
    if (configPath) return configPath

    throw new Error(
      '未找到 mariadb-dump。请确保已下载 MariaDB 二进制文件：\n' +
        '  spindb engines download mariadb',
    )
  }

  /** 创建数据库备份 */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /** 终止指定数据库的所有连接 */
  async terminateConnections(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { name, port } = container
    const mysql = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    // 获取目标数据库的所有连接 ID 并终止它们
    // 需要分两步完成，因为 MariaDB 不支持在 KILL 语句中使用子查询
    const getIdsArgs = [
      mysql,
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
      '-N',
      '-B',
      '-e',
      `SELECT ID FROM information_schema.PROCESSLIST WHERE DB = '${database}' AND ID != CONNECTION_ID()`,
    ]

    try {
      const { stdout } = await runMariaDbBinary(getIdsArgs[0], getIdsArgs.slice(1), {
        password: auth.password,
      })
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim())
      const ids = lines
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))

      for (const id of ids) {
        const killArgs = [
          mysql,
          '-h',
          '127.0.0.1',
          '-P',
          String(port),
          '-u',
          auth.user,
          '-e',
          `KILL CONNECTION ${id}`,
        ]
        try {
          await runMariaDbBinary(killArgs[0], killArgs.slice(1), {
            password: auth.password,
          })
        } catch {
          // 连接可能已经断开
        }
      }
    } catch {
      // 忽略错误 - 连接可能已经断开
    }
  }

  /** 执行 SQL 脚本文件或 SQL 语句 */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { name, port } = container
    const db = options.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mysql = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
      db,
    ]

    if (options.sql) {
      args.push('-e', options.sql)

      const spawnOptions: SpawnOptions = {
        stdio: 'inherit',
        env: buildMariaDbEnv(auth.password),
      }

      return new Promise((resolve, reject) => {
        const proc = spawn(mysql, args, spawnOptions)

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mariadb 客户端以退出码 ${code} 退出`))
          }
        })
      })
    } else if (options.file) {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: buildMariaDbEnv(auth.password),
      }

      return new Promise((resolve, reject) => {
        const fileStream = createReadStream(options.file!)
        const proc = spawn(mysql, args, spawnOptions)

        fileStream.pipe(proc.stdin!)

        fileStream.on('error', (err) => {
          proc.kill()
          reject(err)
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mariadb 客户端以退出码 ${code} 退出`))
          }
        })
      })
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  /** 执行 SQL 查询并返回结构化结果 */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port } = container
    const db = options?.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mariadb = await this.getMariadbClientPath()
    const host = options?.host ?? '127.0.0.1'
    const localAuth =
      !options?.username &&
      !options?.password &&
      (host === '127.0.0.1' || host === 'localhost')
        ? await this.getLocalAdminAuth(name)
        : null
    const user = options?.username || localAuth?.user || engineDef.superuser

    // 使用 -B（批处理模式）获取制表符分隔的输出
    const args = [
      '-h',
      host,
      '-P',
      String(port),
      '-u',
      user,
      '-B',
      db,
      '-e',
      query,
    ]

    if (options?.ssl) {
      args.push('--ssl')
    }

    // 通过环境变量传递密码，避免在进程列表中暴露
    const env = buildMariaDbEnv(options?.password ?? localAuth?.password)

    return new Promise((resolve, reject) => {
      const proc = spawn(mariadb, args, {
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

      proc.on('error', reject)

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(parseTSVToQueryResult(stdout))
        } else {
          reject(new Error(stderr || `mariadb 以退出码 ${code} 退出`))
        }
      })
    })
  }

  /**
   * 列出所有用户数据库，排除系统数据库
   *（information_schema、mysql、performance_schema、sys）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { name, port } = container
    const mariadb = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    // 查询所有非系统数据库
    const sql = `SHOW DATABASES WHERE \`Database\` NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')`

    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
      '-N', // 跳过列名
      '-B', // 批处理模式（无格式化）
      '-e',
      sql,
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(mariadb, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildMariaDbEnv(auth.password),
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
          const databases = stdout
            .trim()
            .split('\n')
            .map((db) => db.trim())
            .filter((db) => db.length > 0)
          resolve(databases)
        } else {
          reject(new Error(stderr || `mariadb 以退出码 ${code} 退出`))
        }
      })
    })
  }

  /** 创建数据库用户并授予权限 */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { name, port } = container
    const db = database || container.database || 'mysql'
    assertValidDatabaseName(db)
    const mariadb = await this.getMariadbClientPath()
    const auth = await this.getLocalAdminAuth(name)

    // 检查是否启用了 NO_BACKSLASH_ESCAPES — 如果是，则只转义单引号
    let noBackslashEscapes = false
    try {
      const modeArgs = [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        auth.user,
        '-N',
        '-B',
        '-e',
        'SELECT @@sql_mode',
      ]
      const modeResult = await new Promise<string>((resolve, reject) => {
        const proc = spawn(mariadb, modeArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildMariaDbEnv(auth.password),
        })
        let stdout = ''
        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`查询 sql_mode 失败`))
        })
        proc.on('error', reject)
      })
      noBackslashEscapes = modeResult.includes('NO_BACKSLASH_ESCAPES')
    } catch {
      // 查询失败时默认使用反斜杠转义
    }

    const escapedPass = noBackslashEscapes
      ? password.replace(/'/g, "''")
      : password.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const sql = `CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${escapedPass}'; CREATE USER IF NOT EXISTS '${username}'@'localhost' IDENTIFIED BY '${escapedPass}'; ALTER USER '${username}'@'%' IDENTIFIED BY '${escapedPass}'; ALTER USER '${username}'@'localhost' IDENTIFIED BY '${escapedPass}'; GRANT ALL ON \`${db}\`.* TO '${username}'@'%'; GRANT ALL ON \`${db}\`.* TO '${username}'@'localhost'; FLUSH PRIVILEGES;`

    // 通过 stdin 发送 SQL，避免在进程 argv 中泄露密码
    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(mariadb, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildMariaDbEnv(auth.password),
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`创建用户失败：${stderr}`))
      })
      proc.on('error', reject)

      proc.stdin?.write(sql)
      proc.stdin?.end()
    })

    const connectionString = `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const mariadbEngine = new MariaDBEngine()
