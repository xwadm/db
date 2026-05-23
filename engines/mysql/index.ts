/**
 * MySQL 引擎实现
 * 使用 hostdb 的预编译二进制文件管理 MySQL 数据库容器
 */

import { spawn, exec, execFile, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync, createReadStream } from 'fs'
import { mkdir, writeFile, readFile, unlink, rm } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
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
import { mysqlBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  fetchAvailableVersions,
  getLatestVersion,
  fetchDeprecatedVersions,
} from './hostdb-releases'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
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

const execFileAsync = promisify(execFile)

const ENGINE = 'mysql'
const engineDef = getEngineDefaults(ENGINE)

type LocalMySqlAuth = {
  user: string
  password?: string
}

function buildMysqlEnv(password?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (password !== undefined) {
    env.MYSQL_PWD = password
  } else {
    delete env.MYSQL_PWD
  }
  return env
}

/**
 * 为文件或内联 SQL 构建 Windows 安全的 mysql 命令字符串。
 * 此函数导出供单元测试使用。
 */
export function buildWindowsMysqlCommand(
  mysqlPath: string,
  port: number,
  user: string,
  db: string,
  options: { file?: string; sql?: string },
): string {
  if (!options.file && !options.sql) {
    throw new Error('必须提供 file 或 sql 选项')
  }

  let cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user} ${db}`

  if (options.file) {
    // 重定向需要 shell，因此使用 < 操作符
    cmd += ` < "${options.file}"`
  } else if (options.sql) {
    const escaped = options.sql.replace(/"/g, '\\"')
    cmd += ` -e "${escaped}"`
  }

  return cmd
}

/**
 * 构建带内联 SQL 的跨平台安全 mysql 命令字符串。
 * Unix 上使用单引号防止 shell 解释反引号。
 * Windows 上使用双引号（反引号在 cmd.exe 中是字面量）。
 * 此函数导出供单元测试使用。
 */
export function buildMysqlInlineCommand(
  mysqlPath: string,
  port: number,
  user: string,
  sql: string,
  options: { database?: string } = {},
): string {
  const dbArg = options.database ? ` ${options.database}` : ''

  if (isWindows()) {
    // Windows：使用双引号，转义内部双引号
    const escaped = sql.replace(/"/g, '\\"')
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e "${escaped}"`
  } else {
    // Unix：使用单引号防止反引号解释
    // 通过结束字符串、添加转义的引号、开始新字符串来转义 SQL 中的单引号
    const escaped = sql.replace(/'/g, "'\\''")
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e '${escaped}'`
  }
}

export class MySQLEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MySQL'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  private async getLocalAdminAuth(
    containerName: string,
  ): Promise<LocalMySqlAuth> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.MySQL,
      getDefaultUsername(Engine.MySQL),
    )

    return {
      user: savedCreds?.username || engineDef.superuser,
      password: savedCreds?.password,
    }
  }

  private async pingLocalAdmin(
    containerName: string,
    port: number,
  ): Promise<void> {
    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(containerName)

    await execFileAsync(
      mysql,
      ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, '-N', '-e', 'SELECT 1'],
      {
        env: buildMysqlEnv(auth.password),
      },
    )
  }

  private async shutdownLocalAdmin(
    containerName: string,
    port: number,
  ): Promise<void> {
    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(containerName)

    await execFileAsync(
      mysql,
      ['-h', '127.0.0.1', '-P', String(port), '-u', auth.user, '-N', '-e', 'SHUTDOWN'],
      {
        env: buildMysqlEnv(auth.password),
        timeout: 5000,
      },
    )
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  async fetchDeprecatedVersions(): Promise<Set<string>> {
    return fetchDeprecatedVersions()
  }

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    const info = platformService.getPlatformInfo()
    return {
      platform: info.platform,
      arch: info.arch,
    }
  }

  resolveFullVersion(version: string): string {
    // 检查是否已经是完整版本（至少包含两个点）
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    // 是主版本号，使用回退映射表解析
    const resolved = FALLBACK_VERSION_MAP[version]
    if (!resolved) {
      const availableVersions = Object.keys(FALLBACK_VERSION_MAP).join(', ')
      logWarning(
        `未知的 MySQL 主版本 "${version}"。可用版本：${availableVersions}。` +
          `回退到 ${version}.0.0，该版本可能不存在。`,
      )
      return `${version}.0.0`
    }
    return resolved
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
      engine: 'mysql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  getBinaryUrl(version: string, plat: Platform, arc: Arch): string {
    return getBinaryUrl(version, plat, arc)
  }

  /**
   * 验证 MySQL 二进制文件已安装且可正常工作。
   *
   * **推荐显式传入 `version`**——回退的路径提取方式不够健壮。
   *
   * 当提供 `version` 时，验证直接使用它。否则，方法会尝试从
   * `binPath` 的基名中提取 semver 风格的模式（`\d+\.\d+\.\d+`）
   * （例如 "mysql-8.0.40-darwin-arm64" → "8.0.40"）。如果路径不遵循
   * 预期的命名约定，此回退可能失败，导致假阴性结果。
   *
   * 平台和架构通过 `getPlatformInfo()` 内部获取。
   * 验证委托给 `mysqlBinaryManager.verify(version, platform, arch)`。
   *
   * @param binPath - 二进制目录的路径（用于回退版本提取）
   * @param version - 明确的版本字符串（例如 "8.0.40"、"9.5.0"）。
   *   尽可能传入此参数，以避免依赖基于路径的提取。
   * @returns 若二进制文件验证通过则返回 `true`，若验证失败或无法
   *   确定版本则返回 `false`
   *
   * @example
   * // 推荐：显式传入版本
   * await engine.verifyBinary('/path/to/mysql-8.0.40-darwin-arm64', '8.0.40')
   *
   * // 回退：从路径提取版本（可靠性较低）
   * await engine.verifyBinary('/path/to/mysql-8.0.40-darwin-arm64')
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    // 若提供了显式版本则使用
    if (version) {
      return mysqlBinaryManager.verify(version, p, a)
    }

    // 回退：从路径提取版本（可靠性较低）
    // 匹配 mysql-8.0.40-darwin-arm64 或 mysql-9.0.0-linux-x64 等模式
    const basename = binPath.split('/').pop() || binPath.split('\\').pop() || ''
    const versionMatch = basename.match(/\b(\d+\.\d+\.\d+)\b/)
    if (!versionMatch) {
      logDebug(`无法从二进制路径提取版本：${binPath}`)
      return false
    }
    logDebug(
      `从路径提取到版本 ${versionMatch[1]}（推荐使用显式版本）`,
    )
    return mysqlBinaryManager.verify(versionMatch[1], p, a)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await mysqlBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // 注册下载包中的所有 MySQL 二进制文件
    const ext = platformService.getExecutableExtension()
    const tools = ['mysqld', 'mysqladmin', 'mysql', 'mysqldump'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return mysqlBinaryManager.isInstalled(version, p, a)
  }

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

    const cleanupOnFailure = async () => {
      if (createdDataDir) {
        try {
          await rm(dataDir, { recursive: true, force: true })
          logDebug(`初始化失败后清理数据目录：${dataDir}`)
        } catch (cleanupErr) {
          logDebug(
            `清理数据目录失败：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          )
        }
      }
    }

    // MySQL 使用 mysqld --initialize-insecure
    const mysqld = join(binPath, 'bin', `mysqld${ext}`)

    if (!existsSync(mysqld)) {
      await cleanupOnFailure()
      throw new Error(
        `${binPath}/bin/ 中未找到 MySQL 服务器二进制文件。\n` +
          '请重新下载 MySQL 二进制文件：spindb engines download mysql',
      )
    }

    // MySQL 初始化
    // --initialize-insecure 创建无需密码的 root 用户（用于本地开发）
    const logFile = paths.getContainerLogPath(containerName, { engine: ENGINE })
    if (isWindows()) {
      // Windows 上使用 exec 并正确引用命令
      const cmd = `"${mysqld}" --initialize-insecure --datadir="${dataDir}" --log-error="${logFile}"`

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
          if (error) {
            await cleanupOnFailure()
            reject(
              new Error(
                `MySQL 初始化失败，返回码 ${error.code}：${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve(dataDir)
          }
        })
      })
    }

    // Unix 路径——使用不带 shell 的 spawn
    // --user：非 root 时必需，但以 root 身份运行时可以跳过，
    //          避免系统上需要存在专用的 'mysql' 用户
    const isRunningAsRoot = process.getuid?.() === 0
    const args = [
      '--initialize-insecure',
      `--datadir=${dataDir}`,
      `--basedir=${binPath}`,
      `--log-error=${logFile}`,
    ]

    // 仅在非 root 运行时添加 --user
    // 以 root 身份运行时，mysqld --initialize-insecure 无需指定用户即可正常工作
    if (!isRunningAsRoot && process.env.USER) {
      args.push(`--user=${process.env.USER}`)
    }

    // 初始化超时（与 Windows 路径相同）
    const INIT_TIMEOUT_MS = 120000

    return new Promise((resolve, reject) => {
      let settled = false
      let timeoutId: NodeJS.Timeout | null = null

      const proc = spawn(mysqld, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      // 设置超时
      timeoutId = setTimeout(async () => {
        if (settled) return
        settled = true

        // 终止进程
        try {
          proc.kill('SIGKILL')
        } catch {
          // 若进程已退出则忽略错误
        }

        await cleanupOnFailure()
        reject(
          new Error(
            `MySQL 初始化超时（${INIT_TIMEOUT_MS / 1000} 秒）。请查看日志：${logFile}`,
          ),
        )
      }, INIT_TIMEOUT_MS)

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        if (settled) return
        settled = true

        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        if (code === 0) {
          resolve(dataDir)
        } else {
          await cleanupOnFailure()
          reject(
            new Error(
              `MySQL 初始化失败，返回码 ${code}：${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', async (err) => {
        if (settled) return
        settled = true

        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        await cleanupOnFailure()
        reject(err)
      })
    })
  }

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
    const mysqld = join(binPath, 'bin', `mysqld${ext}`)

    if (!existsSync(mysqld)) {
      throw new Error(
        `${binPath}/bin/ 中未找到 MySQL 服务器二进制文件。\n` +
          '请重新下载 MySQL 二进制文件：spindb engines download mysql',
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const { platform } = platformService.getPlatformInfo()

    onProgress?.({ stage: 'starting', message: '正在启动 MySQL...' })

    const args = [
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

    if (isWindows()) {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })

      proc.unref()
    } else {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      })
      proc.unref()
    }

    return new Promise((resolve, reject) => {
      // 跟踪 promise 是否已确定，避免竞态条件
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

        // 等待 MySQL 就绪
        let attempts = 0
        const maxAttempts = 60
        const checkInterval = 500

        const checkReady = async () => {
          if (settled) return
          attempts++
          try {
            await this.pingLocalAdmin(container.name, port)
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
              reject(new Error('MySQL 启动超时'))
            }
          }
        }

        checkReady()
      }, 1000)
    })
  }

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

  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    logDebug(`正在停止 MySQL 容器 "${name}"，端口 ${port}`)

    const pid = await this.getValidatedPid(pidFile)
    if (pid === null) {
      logDebug('无有效 PID，正在检查 MySQL 是否在端口上响应')
      try {
        await this.pingLocalAdmin(name, port)
      } catch {
        logDebug('MySQL 无响应，无需停止')
        return
      }

      logWarning(`MySQL 在端口 ${port} 上响应，但无有效 PID 文件`)
      const gracefulSuccess = await this.gracefulShutdown(name, port)
      if (!gracefulSuccess) {
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `端口 ${port} 上的 MySQL 响应了 ping 但未能正常关闭`,
          'error',
          '请检查凭据，若进程仍在运行则手动停止。',
        )
      }
      return
    }

    const gracefulSuccess = await this.gracefulShutdown(name, port, pid)
    if (gracefulSuccess) {
      await this.cleanupPidFile(pidFile)
      logDebug('MySQL 已优雅停止')
      return
    }

    await this.forceKillWithEscalation(pid, pidFile)
  }

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
        logWarning(`PID 文件引用了不存在的进程 ${pid}`)
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

  private async gracefulShutdown(
    containerName: string,
    port: number,
    pid?: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    try {
      logDebug('尝试认证式 MySQL 关闭')
      await this.shutdownLocalAdmin(containerName, port)
    } catch (error) {
      const e = error as Error
      logDebug(`认证式关闭失败：${e.message}`)
      if (pid) {
        try {
          await platformService.terminateProcess(pid, false)
        } catch (terminateError) {
          const termErr = terminateError as NodeJS.ErrnoException
          // ESRCH 表示进程不存在——已经消失了
          if (termErr.code === 'ESRCH') {
            logDebug(`进程 ${pid} 已终止（ESRCH）`)
            return true
          }
          logDebug(`terminateProcess 对 PID ${pid} 失败：${termErr.message}`)
          return false
        }
      }
      return false
    }

    if (pid) {
      const startTime = Date.now()
      const checkIntervalMs = 200

      while (Date.now() - startTime < timeoutMs) {
        if (!platformService.isProcessRunning(pid)) {
          logDebug(`进程 ${pid} 在优雅关闭后终止`)
          return true
        }
        await this.sleep(checkIntervalMs)
      }

      logDebug(`优雅关闭在 ${timeoutMs}ms 后超时`)
      return false
    }

    return true
  }

  private async forceKillWithEscalation(
    pid: number,
    pidFile: string,
  ): Promise<void> {
    logWarning(`优雅关闭失败，正在强制终止进程 ${pid}`)

    try {
      await platformService.terminateProcess(pid, false)
      await this.sleep(2000)

      if (!platformService.isProcessRunning(pid)) {
        logDebug(`进程 ${pid} 在优雅信号后终止`)
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
    logWarning(`升级为强制终止进程 ${pid}`)
    try {
      await platformService.terminateProcess(pid, true)
      await this.sleep(1000)

      if (platformService.isProcessRunning(pid)) {
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `即使强制终止也无法停止 MySQL 进程 ${pid}`,
          'error',
          `请尝试手动终止进程：${killCmd} ${pid}`,
        )
      }
      logDebug(`进程 ${pid} 在强制终止后已停止`)
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

  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    if (!existsSync(pidFile)) {
      return { running: false, message: 'MySQL 未运行' }
    }

    try {
      await this.pingLocalAdmin(name, port)
      return { running: true, message: 'MySQL 正在运行' }
    } catch {
      return { running: false, message: 'MySQL 无响应' }
    }
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

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
      containerVersion: version,
    })
  }

  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'mysql'
    return `mysql://${engineDef.superuser}@127.0.0.1:${port}/${db}`
  }

  override async getMysqlClientPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mysql')
    if (configPath) return configPath

    throw new Error(
      '未找到 mysql 客户端。请确保已下载 MySQL 二进制文件：\n' +
        '  spindb engines download mysql',
    )
  }

  override async getMysqladminPath(): Promise<string> {
    const cfg = await configManager.getBinaryPath('mysqladmin')
    if (cfg) return cfg

    throw new Error(
      '未找到 mysqladmin。请确保已下载 MySQL 二进制文件：\n' +
        '  spindb engines download mysql',
    )
  }

  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { name, port } = container
    const db = database || container.database || 'mysql'

    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(name)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      env: buildMysqlEnv(auth.password),
      ...getWindowsSpawnOptions(),
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

  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { name, port } = container

    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(name)

    try {
      await execFileAsync(mysql, [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        auth.user,
        '-e',
        `CREATE DATABASE IF NOT EXISTS \`${database}\``,
      ], {
        env: buildMysqlEnv(auth.password),
      })
    } catch (error) {
      const err = error as Error
      if (!err.message.includes('database exists')) {
        throw error
      }
    }
  }

  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { name, port } = container

    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(name)

    try {
      await execFileAsync(mysql, [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        auth.user,
        '-e',
        `DROP DATABASE IF EXISTS \`${database}\``,
      ], {
        env: buildMysqlEnv(auth.password),
      })
    } catch (error) {
      const err = error as Error
      if (!err.message.includes("database doesn't exist")) {
        throw error
      }
    }
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { name, port, database } = container
    const db = database || 'mysql'

    assertValidDatabaseName(db)

    try {
      const mysql = await this.getMysqlClientPath()
      const auth = await this.getLocalAdminAuth(name)

      const { stdout } = await execFileAsync(mysql, [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        auth.user,
        '-N',
        '-e',
        `SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = '${db}'`,
      ], {
        env: buildMysqlEnv(auth.password),
      })
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      return null
    }
  }

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
      env: password ? { ...process.env, MYSQL_PWD: password } : process.env,
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
          reject(new Error(stderr || `mysqldump 退出，返回码 ${code}`))
        }
      })
    })
  }

  private async getDumpPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mysqldump')
    if (configPath) return configPath

    throw new Error(
      '未找到 mysqldump。请确保已下载 MySQL 二进制文件：\n' +
        '  spindb engines download mysql',
    )
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
    const { name, port } = container
    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(name)

    // 获取目标数据库的所有连接 ID 并终止它们
    // 需要分两步进行，因为 MySQL 不支持在 KILL 中使用子查询
    try {
      const { stdout } = await execFileAsync(mysql, [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        auth.user,
        '-N',
        '-e',
        `SELECT ID FROM information_schema.PROCESSLIST WHERE DB = '${database}' AND ID != CONNECTION_ID()`,
      ], {
        env: buildMysqlEnv(auth.password),
      })
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim())
      // 若存在表头行则跳过
      const ids = lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))

      for (const id of ids) {
        try {
          await execFileAsync(mysql, [
            '-h',
            '127.0.0.1',
            '-P',
            String(port),
            '-u',
            auth.user,
            '-e',
            `KILL CONNECTION ${id}`,
          ], {
            env: buildMysqlEnv(auth.password),
          })
        } catch {
          // 连接可能已消失
        }
      }
    } catch {
      // 忽略错误——连接可能已消失
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { name, port } = container
    const db = options.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mysql = await this.getMysqlClientPath()
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
        env: buildMysqlEnv(auth.password),
      }

      return new Promise((resolve, reject) => {
        const proc = spawn(mysql, args, spawnOptions)

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mysql 客户端退出，返回码 ${code}`))
          }
        })
      })
    } else if (options.file) {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: buildMysqlEnv(auth.password),
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
            reject(new Error(`mysql 客户端退出，返回码 ${code}`))
          }
        })
      })
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { name, port } = container
    const db = options?.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mysql = await this.getMysqlClientPath()
    const host = options?.host ?? '127.0.0.1'
    const localAuth =
      !options?.username &&
      !options?.password &&
      (host === '127.0.0.1' || host === 'localhost')
        ? await this.getLocalAdminAuth(name)
        : null
    const user = options?.username || localAuth?.user || engineDef.superuser

    // 使用 -B（批处理模式）输出制表符分隔的结果
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
      args.push('--ssl-mode=REQUIRED')
    }

    // 通过环境变量传递密码，避免在进程列表中暴露
    const env = buildMysqlEnv(options?.password ?? localAuth?.password)

    return new Promise((resolve, reject) => {
      const proc = spawn(mysql, args, {
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
          reject(new Error(stderr || `mysql 退出，返回码 ${code}`))
        }
      })
    })
  }

  /**
   * 列出所有用户数据库，排除系统数据库
   * （information_schema、mysql、performance_schema、sys）。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { name, port } = container
    const mysql = await this.getMysqlClientPath()
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
      const proc = spawn(mysql, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildMysqlEnv(auth.password),
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
          reject(new Error(stderr || `mysql 退出，返回码 ${code}`))
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
    const { name, port } = container
    const db = database || container.database
    if (!db) {
      throw new Error(
        '未指定目标数据库。请使用 --database 提供数据库名称，或确保容器有默认数据库。',
      )
    }
    assertValidDatabaseName(db)
    const mysql = await this.getMysqlClientPath()
    const auth = await this.getLocalAdminAuth(name)

    // 检查是否启用了 NO_BACKSLASH_ESCAPES——若启用则仅转义单引号
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
        const proc = spawn(mysql, modeArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildMysqlEnv(auth.password),
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
    const escapedDb = db.replace(/`/g, '``')
    const escapedUser = noBackslashEscapes
      ? username.replace(/'/g, "''")
      : username.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const sql = `CREATE USER IF NOT EXISTS '${escapedUser}'@'%' IDENTIFIED BY '${escapedPass}'; CREATE USER IF NOT EXISTS '${escapedUser}'@'localhost' IDENTIFIED BY '${escapedPass}'; ALTER USER '${escapedUser}'@'%' IDENTIFIED BY '${escapedPass}'; ALTER USER '${escapedUser}'@'localhost' IDENTIFIED BY '${escapedPass}'; GRANT ALL ON \`${escapedDb}\`.* TO '${escapedUser}'@'%'; GRANT ALL ON \`${escapedDb}\`.* TO '${escapedUser}'@'localhost'; FLUSH PRIVILEGES;`

    // 通过 stdin 发送 SQL，避免在进程参数中泄露密码
    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(mysql, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildMysqlEnv(auth.password),
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

export const mysqlEngine = new MySQLEngine()