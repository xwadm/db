/**
 * TypeDB 引擎实现
 *
 * TypeDB 是一个强类型数据库，用于知识表示和推理，
 * 拥有自己的查询语言 TypeQL。
 *
 * 主要特征：
 * - 默认主端口：1729（gRPC 协议）
 * - HTTP 端口：主端口 + 6271（默认 8000）
 * - Rust 原生二进制（无需 JRE）
 * - 独立控制台二进制文件（typedb_console_bin），用于交互式查询
 * - 默认凭据：admin/password
 * - 基于配置文件（每个容器一个 config.yml）
 * - 查询语言：TypeQL
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, unlink, stat, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
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
import { processManager } from '../../core/process-manager'
import { typedbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  TYPEDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateTypeDBIdentifier,
  requireTypeDBConsolePath,
  getConsoleBaseArgs,
  TYPEDB_DEFAULT_USERNAME,
  TYPEDB_DEFAULT_PASSWORD,
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

const ENGINE = 'typedb'
const engineDef = getEngineDefaults(ENGINE)

export class TypeDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'TypeDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息用于二进制操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（如 '3' -> '3.8.0'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return TYPEDB_VERSION_MAP[version] || version
  }

  // 获取某个版本的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 TypeDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)
    return existsSync(serverPath)
  }

  // 检查特定 TypeDB 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return typedbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保特定版本的 TypeDB 二进制文件可用
   * 如果尚未安装，从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await typedbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const batExt = process.platform === 'win32' ? '.bat' : ''

    const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
    if (existsSync(typedbPath)) {
      await configManager.setBinaryPath('typedb', typedbPath, 'bundled')
    }

    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )
    if (existsSync(consolePath)) {
      await configManager.setBinaryPath(
        'typedb_console_bin',
        consolePath,
        'bundled',
      )
    }

    return binPath
  }

  /**
   * 初始化新的 TypeDB 数据目录
   * 为 TypeDB 创建目录结构和 config.yml
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // 创建数据目录
    await mkdir(dataDir, { recursive: true })

    // 从选项中获取端口或使用默认值
    const port = (options.port as number) || engineDef.defaultPort
    const httpPort = port + 6271 // 默认：1729 + 6271 = 8000

    // 为此容器生成 config.yml
    // 必须包含所有必需的节：server（含 authentication、encryption）、storage、logging、diagnostics
    // YAML 路径中使用正斜杠 - 双引号 YAML 字符串中的反斜杠
    // 会被解释为转义序列（\t → tab、\n → newline 等），从而损坏 Windows 路径
    const yamlDataDir = dataDir.replace(/\\/g, '/')
    const yamlContainerDir = containerDir.replace(/\\/g, '/')
    const configContent = [
      'server:',
      `  address: ${(options.bindAddress as string) ?? '127.0.0.1'}:${port}`,
      '  http:',
      '    enabled: true',
      `    address: ${(options.bindAddress as string) ?? '127.0.0.1'}:${httpPort}`,
      '  authentication:',
      '    token-expiration-seconds: 5000',
      '  encryption:',
      '    enabled: false',
      '    certificate:',
      '    certificate-key:',
      '    ca-certificate:',
      'storage:',
      `  data-directory: "${yamlDataDir}"`,
      'logging:',
      `  directory: "${yamlContainerDir}"`,
      'diagnostics:',
      '  reporting:',
      '    metrics: false',
      '    errors: false',
      '  monitoring:',
      '    enabled: false',
      '    port: 4104',
    ].join('\n')

    await writeFile(join(containerDir, 'config.yml'), configContent, 'utf-8')

    logDebug(`已创建 TypeDB 数据目录: ${dataDir}`)

    return dataDir
  }

  // 获取某个版本的 typedb_server_bin 路径
  private async getServerBinPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)

    if (existsSync(serverPath)) {
      return serverPath
    }

    throw new Error(
      `TypeDB ${version} 未安装。请运行: spindb engines download typedb ${version}`,
    )
  }

  // 获取某个版本的 typedb_console_bin 路径
  private async getConsolePath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )

    if (existsSync(consolePath)) {
      return consolePath
    }

    throw new Error(
      `TypeDB 控制台 ${version} 未安装。请运行: spindb engines download typedb ${version}`,
    )
  }

  // 获取某个版本的 typedb 启动器路径
  private async getTypeDBLauncherPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const batExt = process.platform === 'win32' ? '.bat' : ''

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const launcherPath = join(binPath, 'bin', `typedb${batExt}`)

    if (existsSync(launcherPath)) {
      return launcherPath
    }

    // 回退到直接使用服务器二进制文件
    return this.getServerBinPath(version)
  }

  /**
   * 启动 TypeDB 服务器
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

    // 获取 TypeDB 二进制文件路径
    let serverBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(
        binaryPath,
        'bin',
        'server',
        `typedb_server_bin${ext}`,
      )
      if (existsSync(serverPath)) {
        serverBinary = serverPath
        logDebug(`使用存储的二进制路径: ${serverBinary}`)
      }
    }

    if (!serverBinary) {
      try {
        serverBinary = await this.getServerBinPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `TypeDB ${version} 未安装。请运行: spindb engines download typedb ${version}\n` +
            `  原始错误: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'typedb.pid')
    const configFile = join(containerDir, 'config.yml')

    // 始终重新生成 config.yml 以确保路径和端口正确
    // （重命名后路径会变化，端口重新分配后端口也会变化）
    await this.initDataDir(name, version, {
      port,
      bindAddress: container.bindAddress,
    })

    onProgress?.({ stage: 'starting', message: '正在启动 TypeDB...' })

    logDebug(`正在使用配置启动 TypeDB: ${configFile}`)

    // 使用服务器二进制文件直接启动 TypeDB 服务器，传入配置
    const args = ['server', '--config', configFile]

    // 在 Windows 上，直接使用服务器二进制文件以避免 .bat 启动器的 cmd.exe 包装，
    // 后者会产生僵尸进程，阻止测试/CLI 正常退出。
    // 在其他平台上，先尝试启动器，失败再回退到直接使用服务器二进制文件。
    const isWindows = process.platform === 'win32'
    let launcherPath: string
    if (isWindows && serverBinary) {
      launcherPath = serverBinary
      // 直接使用服务器二进制文件时，不传 'server' 子命令
      args.splice(0, 1)
    } else {
      try {
        launcherPath = await this.getTypeDBLauncherPath(version)
      } catch {
        launcherPath = serverBinary!
        // 直接使用服务器二进制文件时，不传 'server' 子命令
        args.splice(0, 1)
      }
    }

    // 启动服务器进程
    // 对所有 stdio 使用 'ignore'，防止管道保持事件循环活跃
    // 在 Windows 上，.bat/.cmd 文件需要 shell: true，但我们直接使用 .exe
    const needsShell =
      isWindows &&
      (launcherPath.endsWith('.bat') || launcherPath.endsWith('.cmd'))

    const proc = spawn(launcherPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      windowsHide: true,
      ...(needsShell ? { shell: true } : {}),
    })

    // 等待进程启动
    if (isWindows) {
      await new Promise<void>((resolve, reject) => {
        let settled = false

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          logDebug(`Windows 上 TypeDB 启动错误: ${err.message}`)
          reject(new Error(`启动 TypeDB 失败: ${err.message}`))
        })

        // 检测提前退出（如配置错误、缺少依赖等）
        proc.on('close', (code, signal) => {
          if (settled) return
          settled = true
          const errMsg = `TypeDB 进程在 Windows 上提前退出 (退出码: ${code}, 信号: ${signal})`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        if (proc.pid) {
          writeFile(pidFile, proc.pid.toString(), 'utf-8')
            .then(() => {
              logDebug(`Windows: 已写入 PID 文件 ${pidFile} (pid: ${proc.pid})`)
              proc.unref()
              setTimeout(() => {
                if (settled) return
                settled = true
                proc.removeAllListeners('close')
                resolve()
              }, 3000)
            })
            .catch((err) => {
              if (settled) return
              settled = true
              const errMsg = `写入 PID 文件失败: ${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)
              try {
                if (proc.pid) process.kill(proc.pid, 'SIGTERM')
              } catch {
                // 进程可能已经退出
              }
              reject(new Error(errMsg))
            })
        } else {
          settled = true
          reject(new Error('启动 TypeDB 失败: 无可用 PID'))
        }
      })
    } else {
      const spawnTimeout = 30000
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(
            new Error(
              `TypeDB 进程在 ${spawnTimeout}ms 内未能启动`,
            ),
          )
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`TypeDB 启动错误: ${err.message}`)
          reject(new Error(`启动 TypeDB 失败: ${err.message}`))
        })

        proc.on('close', (code, signal) => {
          clearTimeout(timeoutId)
          const errMsg = `TypeDB 进程提前退出 (退出码: ${code}, 信号: ${signal})`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        proc.on('spawn', async () => {
          clearTimeout(timeoutId)
          logDebug(`TypeDB 进程已启动 (pid: ${proc.pid})`)

          proc.removeAllListeners('close')

          if (proc.pid) {
            try {
              await writeFile(pidFile, proc.pid.toString(), 'utf-8')
            } catch (err) {
              const errMsg = `写入 PID 文件失败: ${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)

              try {
                process.kill(proc.pid, 'SIGTERM')
              } catch {
                // 进程可能已经退出
              }

              try {
                await unlink(pidFile)
              } catch {
                // 忽略
              }

              reject(new Error(errMsg))
              return
            }
          }

          proc.unref()
          setTimeout(resolve, 500)
        })
      })
    }

    // 等待服务器就绪
    const httpPort = port + 6271
    logDebug(
      `等待 TypeDB 服务器在端口 ${port} 上就绪 (HTTP: ${httpPort})...`,
    )
    const ready = await this.waitForReady(httpPort, port)
    logDebug(`waitForReady 返回: ${ready}`)

    if (!ready) {
      throw new Error(
        `TypeDB 在超时时间内未能启动。容器: ${name}`,
      )
    }

    // 在 Windows 上使用 .bat 启动器时，记录的 PID 是 cmd.exe（而非实际服务器）。
    // 通过端口查找真实的服务器 PID 并更新 PID 文件（与 QuestDB 相同的模式）。
    if (isWindows) {
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          await writeFile(pidFile, pids[0].toString(), 'utf-8')
          logDebug(
            `Windows: 已用实际服务器 PID 更新 PID 文件: ${pids[0]}`,
          )
        }
      } catch {
        // 非致命错误：stop() 也会通过端口查找
      }
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // 通过 HTTP 健康检查等待 TypeDB 就绪
  private async waitForReady(
    httpPort: number,
    _mainPort: number,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady 已调用，HTTP 端口 ${httpPort}`)
    const startTime = Date.now()
    const checkInterval = 500

    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (response.ok) {
          logDebug(`TypeDB 在 HTTP 端口 ${httpPort} 上已就绪`)
          return true
        }
      } catch {
        clearTimeout(timer)
        if (attempt <= 3 || attempt % 10 === 0) {
          logDebug(`健康检查第 ${attempt} 次失败`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logWarning(`TypeDB 在 ${timeoutMs}ms 内未能就绪`)
    return false
  }

  /**
   * 停止 TypeDB 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'typedb.pid')

    logDebug(`正在停止 TypeDB 容器 "${name}"，端口 ${port}`)

    // 通过端口查找 PID
    let pid: number | null = null

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
      logDebug(`正在终止 TypeDB 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        const gracefulWait = process.platform === 'win32' ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
          if (process.platform === 'win32') {
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
        }
      } catch (error) {
        logDebug(`进程终止错误: ${error}`)
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

    logDebug('TypeDB 已停止')
  }

  // 获取 TypeDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port } = container
    const httpPort = port + 6271

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.ok) {
        return { running: true, message: 'TypeDB 正在运行' }
      }
      return { running: false, message: 'TypeDB 未运行' }
    } catch {
      return { running: false, message: 'TypeDB 未运行' }
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
    options: { database?: string } = {},
  ): Promise<RestoreResult> {
    const { name, port, version } = container

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database: options.database || container.database,
      version,
    })
  }

  /**
   * 获取连接字符串
   * TypeDB 在主端口上使用自有协议
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `typedb://${TYPEDB_DEFAULT_USERNAME}:${TYPEDB_DEFAULT_PASSWORD}@127.0.0.1:${port}`
  }

  // 打开 TypeDB 控制台交互式 shell
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port, version } = container

    const consolePath = await this.getConsolePath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(consolePath, getConsoleBaseArgs(port), spawnOptions)

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * TypeDB 需要通过控制台显式创建数据库
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    validateTypeDBIdentifier(database)

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `database create ${database}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已创建 TypeDB 数据库: ${database}`)
          resolve()
        } else {
          reject(new Error(`创建数据库失败: ${stderr}`))
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
    const { port, version } = container

    validateTypeDBIdentifier(database)

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `database delete ${database}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已删除 TypeDB 数据库: ${database}`)
          resolve()
        } else {
          reject(new Error(`删除数据库失败: ${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 获取数据库大小（字节）
   * 从数据目录估算
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })

    try {
      const stats = await stat(dataDir)

      if (!stats.isDirectory()) {
        return null
      }

      let totalSize = 0
      const calculateSize = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            await calculateSize(fullPath)
          } else {
            const fileStat = await stat(fullPath)
            totalSize += fileStat.size
          }
        }
      }

      await calculateSize(dataDir)
      return totalSize
    } catch {
      return null
    }
  }

  /**
   * 从远程 TypeDB 连接导出数据
   * 使用 TypeDB 控制台导出功能
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
      const sanitized = connectionString.replace(
        /\/\/([^:]+):([^@]+)@/,
        '//***:***@',
      )
      throw new Error(
        `无效的连接字符串: ${sanitized}\n` +
          '期望格式: typedb://host[:port][/database]',
      )
    }

    const host = url.hostname || '127.0.0.1'
    const port = parseInt(url.port, 10) || 1729
    const database = url.pathname.replace(/^\//, '') || 'default'
    const username = url.username
      ? decodeURIComponent(url.username)
      : TYPEDB_DEFAULT_USERNAME
    const password = url.password
      ? decodeURIComponent(url.password)
      : TYPEDB_DEFAULT_PASSWORD

    logDebug(`正在连接远程 TypeDB，地址 ${host}:${port} (数据库: ${database})`)

    // 对于远程导出，需要本地 TypeDB 控制台二进制文件
    let consolePath: string | null = null
    const cached = await configManager.getBinaryPath('typedb_console_bin')
    if (cached && existsSync(cached)) {
      consolePath = cached
    }

    if (!consolePath) {
      throw new Error(
        'TypeDB 控制台二进制文件未找到。请运行: spindb engines download typedb 3\n' +
          '从远程连接导出需要本地 TypeDB 控制台二进制文件。',
      )
    }

    // TypeDB 将 schema 和数据作为单独文件导出
    let schemaPath: string
    let dataPath: string
    if (outputPath.endsWith('.typeql')) {
      const basePath = outputPath.slice(0, -'.typeql'.length)
      schemaPath = `${basePath}-schema.typeql`
      dataPath = `${basePath}-data.typeql`
    } else {
      schemaPath = outputPath + '-schema.typeql'
      dataPath = outputPath + '-data.typeql'
    }

    // 使用 URL 凭据构建控制台参数（可能与本地默认值不同）
    const tlsDisabled = url.protocol !== 'https:'
    return new Promise<DumpResult>((resolve, reject) => {
      const args = [
        '--address',
        `${host}:${port}`,
        ...(tlsDisabled ? ['--tls-disabled'] : []),
        '--username',
        username,
        '--password',
        password,
        '--command',
        `database export ${database} ${schemaPath} ${dataPath}`,
      ]

      const proc = spawn(consolePath!, args, {
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
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code: 0,
          })
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

  // 运行 TypeQL 文件或内联语句
  async runScript(
    container: ContainerConfig,
    options: {
      file?: string
      sql?: string
      database?: string
      transactionType?: 'read' | 'write' | 'schema'
    },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database

    if (!db) {
      throw new Error(
        '需要指定数据库名称。请使用 --database 或在容器上设置默认数据库。',
      )
    }

    const consolePath = await this.getConsolePath(version)

    if (options.file) {
      // 运行 TypeQL 脚本文件
      const args = [...getConsoleBaseArgs(port), '--script', options.file]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(consolePath, args, {
          stdio: 'inherit',
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null)
            reject(new Error(`typedb 控制台被信号 ${signal} 终止`))
          else reject(new Error(`typedb 控制台退出，返回码 ${code}`))
        })
      })
    } else if (options.sql) {
      // 通过临时脚本文件运行内联 TypeQL
      // TypeDB 控制台 --command 模式不支持多步骤事务流程；
      // 每个 --command 是独立的顶层命令。事务需要 --script。
      const upperSql = options.sql.trim().toUpperCase()
      let txType: 'read' | 'write' | 'schema'
      if (options.transactionType) {
        txType = options.transactionType
      } else if (
        upperSql.startsWith('DEFINE') ||
        upperSql.startsWith('UNDEFINE')
      ) {
        txType = 'schema'
      } else {
        txType = 'write'
      }
      const txEnd = txType === 'read' ? 'close' : 'commit'
      const scriptContent = `transaction ${txType} ${db}\n\n${options.sql}\n\n${txEnd}\n`
      const tempScript = join(
        tmpdir(),
        `spindb-typedb-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
      )

      try {
        await writeFile(tempScript, scriptContent, 'utf-8')

        const args = [...getConsoleBaseArgs(port), '--script', tempScript]

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(consolePath, args, {
            stdio: 'inherit',
          })

          proc.on('error', reject)
          proc.on('close', (code, signal) => {
            if (code === 0) resolve()
            else if (code === null)
              reject(new Error(`typedb 控制台被信号 ${signal} 终止`))
            else reject(new Error(`typedb 控制台退出，返回码 ${code}`))
          })
        })
      } finally {
        await unlink(tempScript).catch(() => {})
      }
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  /**
   * 执行 TypeQL 查询并返回结构化结果
   * TypeDB 不像 SQL 那样返回表格结果，但我们会对输出进行规范化
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version } = container
    const db = container.database

    if (!db) {
      throw new Error(
        '需要指定数据库名称。请使用 --database 或在容器上设置默认数据库。',
      )
    }

    const consolePath = await this.getConsolePath(version)

    // TypeDB 控制台 --command 模式不支持多步骤事务流程；
    // 每个 --command 是独立的顶层命令。查询使用临时脚本。
    const scriptContent = `transaction read ${db}\n\n${query}\n\nclose\n`
    const tempScript = join(
      tmpdir(),
      `spindb-typedb-query-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
    )

    try {
      await writeFile(tempScript, scriptContent, 'utf-8')

      return await new Promise((resolve, reject) => {
        const args = [
          ...getConsoleBaseArgs(port, '127.0.0.1', true, {
            username: options?.username,
            password: options?.password,
          }),
          '--script',
          tempScript,
        ]

        const proc = spawn(consolePath, args, {
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
              new Error(stderr || `typedb 控制台退出，返回码 ${code}`),
            )
            return
          }

          // TypeDB 控制台输出不是表格格式 - 将原始输出作为单个结果返回
          resolve({
            columns: ['result'],
            rows: [{ result: stdout.trim() }],
            rowCount: 1,
          })
        })
      })
    } finally {
      await unlink(tempScript).catch(() => {})
    }
  }

  /**
   * 列出所有数据库
   * 使用 TypeDB 控制台 'database list' 命令
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port, version } = container
    const consolePath = await this.getConsolePath(version)

    return new Promise((resolve, reject) => {
      const args = [...getConsoleBaseArgs(port), '--command', 'database list']

      const proc = spawn(consolePath, args, {
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
          reject(new Error(stderr || `typedb 控制台退出，返回码 ${code}`))
          return
        }

        try {
          // 解析数据库列表输出
          // 命令回显之后的每一行都是一个数据库名称
          const lines = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)

          // 过滤掉命令回显（+ 前缀）和提示符
          const databases = lines.filter(
            (line) =>
              !line.startsWith('+') &&
              !line.startsWith('>') &&
              !line.startsWith('database') &&
              !line.includes('connected') &&
              line.length > 0,
          )

          resolve(
            databases.length > 0
              ? databases
              : container.database
                ? [container.database]
                : [],
          )
        } catch {
          resolve(container.database ? [container.database] : [])
        }
      })
    })
  }

  /**
   * 通过控制台 `user create` 命令创建 TypeDB 用户。
   * TypeDB 3.x 内置用户管理，支持密码认证。
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, version } = container

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `user create ${username} ${password}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        if (code === 0) {
          logDebug(`已创建 TypeDB 用户: ${username}`)
          resolve()
        } else if (stderr.toLowerCase().includes('already exists')) {
          // 用户已存在 - 改为更新密码。
          //
          // TypeDB 3.x 控制台子命令为 `update-password`，而非
          // `password-update`。此前此处单词顺序颠倒，导致对已有用户
          // （包括内建 admin）的每次密码轮换都失败，报错
          // "Unrecognised 'user' subcommand: 'password-update <pw>'",
          // 被 close 处理器捕获并向上抛出"更新用户密码失败"——
          // 参见 typedb-console main.rs CommandLeaf 注册：规范名称
          // 为 "update-password"。已在 3.8.0..3.10.1 控制台版本中验证。
          logDebug(`用户 "${username}" 已存在，正在更新密码`)
          try {
            const updateArgs = [
              ...getConsoleBaseArgs(port),
              '--command',
              `user update-password ${username} ${password}`,
            ]
            await new Promise<void>((res, rej) => {
              const updateProc = spawn(consolePath, updateArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              let updateStderr = ''
              updateProc.stderr?.on('data', (data: Buffer) => {
                updateStderr += data.toString()
              })
              updateProc.on('close', (updateCode) => {
                if (updateCode === 0) {
                  logDebug(`已更新 TypeDB 用户 ${username} 的密码`)
                  res()
                } else {
                  rej(
                    new Error(
                      `更新用户密码失败: ${updateStderr}`,
                    ),
                  )
                }
              })
              updateProc.on('error', rej)
            })
            resolve()
          } catch (error) {
            reject(error)
          }
        } else {
          reject(new Error(`创建用户失败: ${stderr}`))
        }
      })
      proc.on('error', reject)
    })

    const connectionString = `typedb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}`

    return {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
    }
  }

  async getTypeDBConsolePath(version?: string): Promise<string> {
    return requireTypeDBConsolePath(version)
  }
}

export const typedbEngine = new TypeDBEngine()
