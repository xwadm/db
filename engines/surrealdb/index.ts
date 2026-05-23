/**
 * SurrealDB 引擎实现
 *
 * SurrealDB 是一个多模型数据库，支持文档、图和关系数据模型，
 * 并提供强大的查询语言 (SurrealQL)。
 *
 * 主要特性：
 * - 默认 HTTP 端口：8000
 * - 单一二进制文件：`surreal`（处理服务器、SQL 客户端、导出、导入）
 * - 存储引擎：SurrealKV（基于文件）或 RocksDB
 * - 默认用户：`root`（密码在启动时设置）
 * - 层级结构：根级 > 命名空间 > 数据库
 * - 查询语言：SurrealQL（类 SQL，支持图遍历）
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { mkdir, writeFile, unlink, stat, readdir } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { surrealdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  SURREALDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  addSurrealAuthArgs,
  buildSurrealUserConnectionString,
  getBootstrapSurrealAuth,
  inferSurrealAuthLevel,
  parseSurrealConnectionString,
  type LocalSurrealAuth,
} from './auth'
import { validateSurrealIdentifier, escapeSurrealIdentifier } from './cli-utils'
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
import { parseSurrealDBResult } from '../../core/query-parser'

const ENGINE = 'surrealdb'
const engineDef = getEngineDefaults(ENGINE)

export class SurrealDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'SurrealDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取平台信息用于二进制文件操作
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // 从 hostdb 获取可用版本（动态获取或从缓存/回退获取）
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // 从 hostdb 获取二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // 将版本字符串解析为完整版本（例如 '2' -> '2.3.2'）
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return SURREALDB_VERSION_MAP[version] || version
  }

  // 获取指定版本二进制文件的安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'surrealdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // 验证 SurrealDB 二进制文件是否可用
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)
    return existsSync(surrealPath)
  }

  // 检查特定 SurrealDB 版本是否已安装（已下载）
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return surrealdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * 确保指定版本的 SurrealDB 二进制文件可用
   * 如果尚未安装则从 hostdb 下载
   * 返回 bin 目录的路径
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await surrealdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // 在配置中注册二进制文件
    const ext = platformService.getExecutableExtension()
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)
    if (existsSync(surrealPath)) {
      await configManager.setBinaryPath('surreal', surrealPath, 'bundled')
    }

    return binPath
  }

  /**
   * 初始化新的 SurrealDB 数据目录
   * 为 SurrealDB 的存储创建目录结构
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

    logDebug(`已创建 SurrealDB 数据目录：${dataDir}`)

    return dataDir
  }

  // 获取指定版本的 surreal 二进制文件路径
  async getSurrealPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'surrealdb',
      version: fullVersion,
      platform,
      arch,
    })
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)

    if (existsSync(surrealPath)) {
      return surrealPath
    }

    throw new Error(
      `SurrealDB ${version} 未安装。请运行：spindb engines download surrealdb ${version}`,
    )
  }

  private async getLocalAuth(
    containerName: string,
  ): Promise<LocalSurrealAuth> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.SurrealDB,
      getDefaultUsername(Engine.SurrealDB),
    )

    if (!savedCreds) {
      return getBootstrapSurrealAuth()
    }

    return {
      username: savedCreds.username,
      password: savedCreds.password,
      authLevel: inferSurrealAuthLevel({
        username: savedCreds.username,
        database: savedCreds.database,
        connectionString: savedCreds.connectionString,
      }),
    }
  }

  /**
   * 启动 SurrealDB 服务器
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container
    // 使用已保存的凭据（例如云设置会写入凭据），
    // 否则回退到硬编码的 root/root 用于本地开发。
    const defaultUser = getDefaultUsername(Engine.SurrealDB)
    logDebug(
      `正在加载 ${name} 的凭据，引擎=${Engine.SurrealDB}，用户名=${defaultUser}`,
    )
    const savedCreds = await loadCredentials(name, Engine.SurrealDB, defaultUser)
    logDebug(
      `loadCredentials 结果：${savedCreds ? `用户=${savedCreds.username}` : 'null（使用 root/root 回退）'}`,
    )
    const startupAuth = savedCreds
      ? {
          username: savedCreds.username,
          password: savedCreds.password,
          authLevel: 'root' as const,
        }
      : getBootstrapSurrealAuth()

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

    // 获取 SurrealDB 二进制文件路径
    let surrealBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `surreal${ext}`)
      if (existsSync(serverPath)) {
        surrealBinary = serverPath
        logDebug(`使用存储的二进制路径：${surrealBinary}`)
      }
    }

    if (!surrealBinary) {
      try {
        surrealBinary = await this.getSurrealPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `SurrealDB ${version} 未安装。请运行：spindb engines download surrealdb ${version}\n` +
            `  原始错误：${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'surrealdb.pid')

    onProgress?.({ stage: 'starting', message: '正在启动 SurrealDB...' })

    logDebug(`正在启动 SurrealDB，数据目录：${dataDir}`)

    // SurrealDB 启动命令 — 使用 SurrealKV 进行基于文件的存储
    // --user/--pass 仅在首次启动（空数据）时生效；重启时会被静默忽略。
    // 仅在数据目录为空时传递这些参数。
    const dataExists =
      existsSync(dataDir) &&
      readdirSync(dataDir).some((f) => !f.startsWith('.'))
    const args = [
      'start',
      `surrealkv://${dataDir}`,
      '--bind',
      `${container.bindAddress ?? '127.0.0.1'}:${port}`,
      '--log',
      'warn',
    ]
    if (!dataExists) {
      args.push('--user', startupAuth.username, '--pass', startupAuth.password)
    }

    // 启动服务器进程
    // SurrealDB 没有 --background 标志，因此我们手动分离它
    // 将 cwd 设置为容器目录，这样 history.txt 会写入该目录而非用户的当前目录
    // 对所有 stdio 使用 'ignore' 以防止管道保持事件循环活跃
    const proc = spawn(surrealBinary!, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      // 在 Windows 上隐藏控制台窗口以防止其阻塞
      windowsHide: true,
    })

    // 等待进程启动
    // 在 Windows 上，分离进程的 'spawn' 事件不可靠地触发，
    // 因此我们立即写入 PID 文件并使用固定延迟。
    // 在 Unix 上，我们等待 spawn 事件以获得更可靠的启动检测。
    const isWindows = process.platform === 'win32'
    if (isWindows) {
      // 在 Windows 上添加错误处理器并写入 PID 文件
      await new Promise<void>((resolve, reject) => {
        proc.on('error', (err) => {
          logDebug(`Windows 上 SurrealDB 启动错误：${err.message}`)
          reject(new Error(`无法启动 SurrealDB：${err.message}`))
        })

        // 在 Windows 上立即写入 PID 文件
        if (proc.pid) {
          writeFile(pidFile, proc.pid.toString(), 'utf-8')
            .then(() => {
              logDebug(`Windows：已写入 PID 文件 ${pidFile}（pid：${proc.pid}）`)
              proc.unref()
              logDebug(
                `Windows：等待固定延迟以启动 SurrealDB（pid：${proc.pid}）`,
              )
              setTimeout(resolve, 3000)
            })
            .catch((err) => {
              // PID 文件写入失败 - 清理并拒绝
              const errMsg = `无法写入 PID 文件：${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)
              // 终止已启动的进程，因为无法追踪它
              try {
                if (proc.pid) process.kill(proc.pid, 'SIGTERM')
              } catch {
                // 进程可能已退出
              }
              reject(new Error(errMsg))
            })
        } else {
          reject(new Error('无法启动 SurrealDB：没有可用的 PID'))
        }
      })
    } else {
      const spawnTimeout = 30000
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(
            new Error(
              `SurrealDB 进程在 ${spawnTimeout}ms 内未能启动`,
            ),
          )
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`SurrealDB 启动错误：${err.message}`)
          reject(new Error(`无法启动 SurrealDB：${err.message}`))
        })

        // 捕获早期退出（进程在 spawn 事件之前死亡）
        proc.on('close', (code, signal) => {
          clearTimeout(timeoutId)
          const errMsg = `SurrealDB 进程提前退出（代码：${code}，信号：${signal}）`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        proc.on('spawn', async () => {
          clearTimeout(timeoutId)
          logDebug(`SurrealDB 进程已启动（pid：${proc.pid}）`)

          // 移除早期退出处理器，因为我们已成功启动
          proc.removeAllListeners('close')

          // 成功启动后写入 PID 文件
          if (proc.pid) {
            try {
              await writeFile(pidFile, proc.pid.toString(), 'utf-8')
            } catch (err) {
              // PID 文件写入失败 - 清理并拒绝
              const errMsg = `无法写入 PID 文件：${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)

              // 终止已启动的进程，因为无法追踪它
              try {
                process.kill(proc.pid, 'SIGTERM')
              } catch {
                // 进程可能已退出，忽略
              }

              // 如果存在部分 PID 文件则删除
              try {
                await unlink(pidFile)
              } catch {
                // 忽略清理错误（文件可能不存在）
              }

              reject(new Error(errMsg))
              return
            }
          }

          // 取消引用进程，使其可以独立运行
          proc.unref()

          // 给服务器一点时间初始化
          setTimeout(resolve, 500)
        })
      })
    }

    // 等待服务器就绪
    logDebug(`正在等待 SurrealDB 服务器在端口 ${port} 上就绪...`)
    const ready = await this.waitForReady(container, version)
    logDebug(`waitForReady 返回：${ready}`)

    if (!ready) {
      throw new Error(
        `SurrealDB 在超时时间内未能启动。容器：${name}`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // 使用 surreal isready 等待 SurrealDB 就绪
  private async waitForReady(
    container: ContainerConfig,
    version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    const { port } = container
    logDebug(`waitForReady 被调用，端口 ${port}，版本 ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let surreal: string
    try {
      logDebug('正在获取 surreal 二进制路径...')
      surreal = await this.getSurrealPath(version)
      logDebug(`已获取 surreal 二进制路径：${surreal}`)
    } catch (err) {
      logDebug(`获取 surreal 二进制路径时出错：${err}`)
      logWarning('未找到 SurrealDB 二进制文件，无法验证服务器是否就绪。')
      return false
    }

    logDebug(`开始连接循环，超时：${timeoutMs}ms`)
    let attempt = 0
    const perAttemptTimeout = 5000 // 每次 isready 尝试 5 秒超时
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`连接尝试 ${attempt}...`)
      try {
        const args = ['isready', '--endpoint', `http://127.0.0.1:${port}`]
        await new Promise<void>((resolve, reject) => {
          let stderrOutput = ''
          const proc = spawn(surreal, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          })

          proc.stderr?.on('data', (data: Buffer) => {
            stderrOutput += data.toString()
          })

          // 此特定尝试的超时 - 如果进程挂起则终止
          const attemptTimer = setTimeout(() => {
            logDebug(
              `isready 尝试 ${attempt} 在 ${perAttemptTimeout}ms 后超时`,
            )
            proc.kill('SIGKILL')
            reject(new Error('isready 超时'))
          }, perAttemptTimeout)

          proc.on('close', (code) => {
            clearTimeout(attemptTimer)
            logDebug(`isready 进程已关闭，代码 ${code}`)
            if (code === 0) resolve()
            else {
              // 记录非零退出码用于调试
              if (attempt <= 3 || attempt % 10 === 0) {
                logDebug(
                  `isready 尝试 ${attempt} 失败（代码：${code}）${stderrOutput ? `：${stderrOutput.trim()}` : ''}`,
                )
              }
              reject(new Error(`退出码 ${code}`))
            }
          })
          proc.on('error', (err) => {
            clearTimeout(attemptTimer)
            logDebug(`isready 错误：${err}`)
            reject(err)
          })
        })
        logDebug(`SurrealDB 在端口 ${port} 上已就绪`)
        return true
      } catch (err) {
        logDebug(`尝试 ${attempt} 失败：${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`SurrealDB 在 ${timeoutMs}ms 内未能就绪`)
    return false
  }

  /**
   * 停止 SurrealDB 服务器
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'surrealdb.pid')

    logDebug(`正在停止端口 ${port} 上的 SurrealDB 容器 "${name}"`)

    // 通过跨平台辅助函数检查进程来查找 PID
    let pid: number | null = null

    // 尝试通过端口查找 SurrealDB 进程
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
      logDebug(`正在终止 SurrealDB 进程 ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        // 等待优雅终止
        // 在 Windows 上，SurrealDB 的 SurrealKV 使用内存映射文件，
        // 释放需要更长时间，因此我们等待更久以避免 EBUSY 错误
        const gracefulWait = process.platform === 'win32' ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`优雅终止失败，正在强制终止 ${pid}`)
          await platformService.terminateProcess(pid, true)
          // Windows 上强制终止后额外等待以释放文件句柄
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

    logDebug('SurrealDB 已停止')
  }

  // 获取 SurrealDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port, version } = container

    // 尝试使用 surreal isready 连接
    try {
      const surreal = await this.getSurrealPath(version)
      const args = ['isready', '--endpoint', `http://127.0.0.1:${port}`]
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`退出码 ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'SurrealDB 正在运行' }
    } catch {
      return { running: false, message: 'SurrealDB 未运行' }
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
      database: options.database || container.database || 'default',
      version,
    })
  }

  /**
   * 获取连接字符串
   * 格式：ws://127.0.0.1:PORT 或 http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    // SurrealDB WebSocket 连接 - 命名空间/数据库在查询中指定
    return `ws://127.0.0.1:${port}/rpc`
  }

  // 打开 surreal sql 交互式 shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version, name } = container
    const db = database || container.database || 'default'
    const namespace = name.replace(/-/g, '_')
    const localAuth = await this.getLocalAuth(name)

    const surreal = await this.getSurrealPath(version)

    // 使用容器目录作为 cwd，这样 history.txt 会写入该目录而非用户的当前目录
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      cwd: containerDir,
    }

    return new Promise((resolve, reject) => {
      const args = addSurrealAuthArgs(
        ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
        localAuth,
      )
      args.push('--ns', namespace, '--db', db, '--pretty')
      const proc = spawn(surreal, args, spawnOptions)

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * 创建新数据库
   * 在 SurrealDB 中，数据库在访问时隐式创建
   * 但我们可以通过定义来确保其存在
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version, name } = container
    const namespace = name.replace(/-/g, '_')
    const localAuth = getBootstrapSurrealAuth()

    // 验证数据库标识符以防止注入
    validateSurrealIdentifier(database, 'database')

    const surreal = await this.getSurrealPath(version)

    // 使用容器目录作为 cwd，这样 history.txt 会写入该目录而非用户的当前目录
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    // SurrealDB 隐式创建数据库，但我们使用 USE 来确保其存在
    const args = addSurrealAuthArgs(
      ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
      localAuth,
    )
    args.push('--ns', namespace, '--db', database, '--hide-welcome')

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // 发送简单查询以确保命名空间/数据库上下文已创建
      proc.stdin?.write('INFO FOR DB;\n')
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已创建 SurrealDB 数据库：${database}`)
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
    const { port, version, name } = container
    const namespace = name.replace(/-/g, '_')
    const localAuth = getBootstrapSurrealAuth()

    // 不允许删除默认数据库
    if (database === 'default') {
      throw new Error('无法删除默认数据库')
    }

    // 验证数据库标识符以防止注入
    validateSurrealIdentifier(database, 'database')
    const escapedDb = escapeSurrealIdentifier(database)

    const surreal = await this.getSurrealPath(version)

    // 使用容器目录作为 cwd，这样 history.txt 会写入该目录而非用户的当前目录
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    const args = addSurrealAuthArgs(
      ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
      localAuth,
    )
    args.push('--ns', namespace, '--hide-welcome')

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // 删除数据库
      proc.stdin?.write(`REMOVE DATABASE ${escapedDb};\n`)
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`已删除 SurrealDB 数据库：${database}`)
          resolve()
        } else {
          reject(new Error(`删除数据库失败：${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * 获取数据库大小（字节）
   * SurrealDB 没有直接的大小查询，因此我们从数据目录估算
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

      // 递归计算目录大小
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
   * 从远程 SurrealDB 连接导出
   * 使用 surreal export
   *
   * 连接字符串格式：surrealdb://[用户名:密码@]主机[:端口][/命名空间/数据库]
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    let parsed
    try {
      parsed = parseSurrealConnectionString(connectionString)
    } catch {
      // 清理连接字符串以避免在错误消息中泄露凭据
      const sanitized = connectionString.replace(
        /\/\/([^:]+):([^@]+)@/,
        '//***:***@',
      )
      throw new Error(
        `无效的连接字符串：${sanitized}\n` +
          '预期格式：surrealdb://[用户名:密码@]主机[:端口][/命名空间/数据库]',
      )
    }

    const { host, port, username, password, namespace, database, authLevel } =
      parsed

    logDebug(
      `正在连接到远程 SurrealDB ${host}:${port}（命名空间：${namespace}，数据库：${database}，认证级别：${authLevel}）`,
    )

    // 对于远程导出，我们需要本地 surreal 二进制文件
    let surreal: string | null = null
    const cached = await configManager.getBinaryPath('surreal')
    if (cached && existsSync(cached)) {
      surreal = cached
    }

    if (!surreal) {
      throw new Error(
        '未找到 SurrealDB 二进制文件。请运行：spindb engines download surrealdb 2\n' +
          '需要本地 SurrealDB 二进制文件来从远程连接导出。',
      )
    }

    return new Promise<DumpResult>((resolve, reject) => {
      const args = addSurrealAuthArgs(
        [
          'export',
          '--endpoint',
          `http://${host}:${port}`,
          '--ns',
          namespace,
          '--db',
          database,
          outputPath,
        ],
        {
          username,
          password,
          authLevel,
        },
      )

      const proc = spawn(surreal, args, {
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

  // 运行 SurrealQL 文件或内联语句
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version, name } = container
    const db = options.database || container.database || 'default'
    const namespace = name.replace(/-/g, '_')
    const localAuth = getBootstrapSurrealAuth()

    const surreal = await this.getSurrealPath(version)

    // 使用容器目录作为 cwd，这样 history.txt 会写入该目录而非用户的当前目录
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    if (options.file) {
      // 使用 import 运行 SurrealQL 文件
      const args = addSurrealAuthArgs(
        ['import', '--endpoint', `http://127.0.0.1:${port}`],
        localAuth,
      )
      args.push('--ns', namespace, '--db', db, options.file)

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: 'inherit',
          cwd: containerDir,
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null)
            reject(new Error(`surreal import 被信号 ${signal} 终止`))
          else reject(new Error(`surreal import 以代码 ${code} 退出`))
        })
      })
    } else if (options.sql) {
      // 通过 stdin 运行内联 SurrealQL
      const args = addSurrealAuthArgs(
        ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
        localAuth,
      )
      args.push('--ns', namespace, '--db', db, '--hide-welcome')

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
          cwd: containerDir,
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null)
            reject(new Error(`surreal sql 被信号 ${signal} 终止`))
          else reject(new Error(`surreal sql 以代码 ${code} 退出`))
        })

        proc.stdin?.write(options.sql)
        proc.stdin?.end()
      })
    } else {
      throw new Error('必须提供 file 或 sql 选项')
    }
  }

  /**
   * 执行 SurrealQL 查询并返回结构化结果
   *
   * 示例：
   *   SELECT * FROM users
   *   SELECT * FROM users WHERE active = true
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version, name } = container
    const db = options?.database || container.database || 'default'
    const namespace = options?.namespace || name.replace(/-/g, '_')
    const localAuth =
      options?.username && options?.password
        ? {
            username: options.username,
            password: options.password,
            authLevel: inferSurrealAuthLevel({
              username: options.username,
              database: db,
            }),
          }
        : await this.getLocalAuth(name)

    const surreal = await this.getSurrealPath(version)
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    return new Promise((resolve, reject) => {
      const args = addSurrealAuthArgs(
        ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
        localAuth,
      )
      args.push('--ns', namespace, '--db', db, '--hide-welcome', '--json')

      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // 发送查询并关闭 stdin
      proc.stdin?.write(query + '\n')
      proc.stdin?.end()

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
          reject(new Error(stderr || `surreal sql 以代码 ${code} 退出`))
          return
        }

        try {
          // SurrealDB 返回语句结果的 JSON 数组
          resolve(parseSurrealDBResult(stdout))
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
   * 列出容器命名空间中的所有数据库。
   * SurrealDB 具有命名空间 > 数据库的层级结构。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port, version, name } = container
    const surreal = await this.getSurrealPath(version)
    const namespace = name.replace(/-/g, '_')
    const localAuth = getBootstrapSurrealAuth()

    return new Promise((resolve, reject) => {
      const args = addSurrealAuthArgs(
        ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
        localAuth,
      )
      args.push(
        '--ns',
        namespace,
        '--db',
        container.database,
        '--hide-welcome',
        '--json',
      )

      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: paths.getContainerPath(name, { engine: ENGINE }),
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

      // 发送 INFO FOR NS 查询以列出数据库
      proc.stdin?.write('INFO FOR NS;\n')
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `surreal sql 以代码 ${code} 退出`))
          return
        }

        try {
          const result = parseSurrealDBResult(stdout)
          const firstRow = result.rows[0] as
            | { databases?: Record<string, unknown> }
            | undefined
          if (firstRow?.databases) {
            const databases = Object.keys(firstRow.databases)
            resolve(databases)
          } else {
            // 未找到数据库或格式不同
            resolve([container.database])
          }
        } catch (error) {
          reject(
            new Error(
              `解析 SurrealDB 数据库列表失败：${error instanceof Error ? error.message : error}`,
            ),
          )
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
    const { port, version, name } = container
    const namespace = name.replace(/-/g, '_')
    const db = database || container.database || 'default'
    const localAuth = await this.getLocalAuth(name)

    const surreal = await this.getSurrealPath(version)
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    // 使用 DEFINE USER OVERWRITE 设置 EDITOR 角色（幂等操作）
    // 当提供 options.database 时限定到数据库级别，否则为命名空间级别
    // 先转义反斜杠，再转义单引号，用于 SurrealQL 字符串字面量
    const escapedPass = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const scopeClause = database
      ? `ON DATABASE ${escapeSurrealIdentifier(database)}`
      : 'ON NAMESPACE'
    const sql = `DEFINE USER OVERWRITE ${escapeSurrealIdentifier(username)} ${scopeClause} PASSWORD '${escapedPass}' ROLES EDITOR;`

    const args = addSurrealAuthArgs(
      ['sql', '--endpoint', `ws://127.0.0.1:${port}`],
      localAuth,
    )
    args.push('--ns', namespace, '--db', db, '--hide-welcome')

    const timeoutMs = 15000
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stderr = ''
      let settled = false
      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        proc.kill()
        reject(
          new Error(
            `创建 SurrealDB 用户 "${username}" 在 ${timeoutMs}ms 后超时`,
          ),
        )
      }, timeoutMs)
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.stdin?.write(sql + '\n')
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        if (code === 0) {
          logDebug(`已创建 SurrealDB 用户：${username}`)
          resolve()
        } else {
          reject(new Error(`创建用户失败：${stderr}`))
        }
      })
      proc.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        reject(error)
      })
    })

    const authLevel = database ? 'database' : 'namespace'
    const connectionString = buildSurrealUserConnectionString({
      username,
      password,
      port,
      namespace,
      database: db,
      authLevel,
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

export const surrealdbEngine = new SurrealDBEngine()
