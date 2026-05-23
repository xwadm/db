/**
 * FerretDB 引擎实现
 *
 * FerretDB 是一个 MongoDB 兼容代理，将数据存储在 PostgreSQL 中。
 * 这是一个组合引擎，管理两个进程：
 * 1. PostgreSQL 后端（postgresql-documentdb）
 * 2. FerretDB 代理
 *
 * 生命周期为：
 * - 启动：启动 PostgreSQL → 等待就绪 → 启动 FerretDB
 * - 停止：停止 FerretDB → 停止 PostgreSQL
 */

import {
  spawn,
  exec,
  type ChildProcess,
  type SpawnOptions,
} from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import net from 'net'
import {
  mkdir,
  writeFile,
  readFile,
  symlink,
  unlink,
  readdir,
} from 'fs/promises'
import { join, basename, dirname } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import {
  logDebug,
  logWarning,
  assertValidDatabaseName,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { spawnAsync } from '../../core/spawn-utils'
import { ferretdbBinaryManager } from './binary-manager'
import {
  buildMongoUri,
  normalizeMongoHost,
  type MongoWireAuth,
} from '../mongo-uri'
import {
  SUPPORTED_MAJOR_VERSIONS,
  FALLBACK_VERSION_MAP,
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  normalizeVersion,
  normalizeDocumentDBVersion,
  isV1,
} from './version-maps'
import { getBinaryUrls, isPlatformSupported } from './binary-urls'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
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
import { parseMongoDBResult } from '../../core/query-parser'

const execAsync = promisify(exec)

const ENGINE = 'ferretdb'
const engineDef = getEngineDefaults(ENGINE)

type LocalFerretAuth = MongoWireAuth

// FerretDB 后端的默认内部 PostgreSQL 端口范围
const BACKEND_PORT_START = 54320
const BACKEND_PORT_END = 54400

/**
 * 为 PostgreSQL 后端分配一个端口
 *
 * 已知限制（TOCTOU）：在检查端口可用性和 PostgreSQL 实际绑定端口之间存在竞态条件。
 * 另一个进程可能会在此期间占用该端口。这对 SpinDB 的使用场景来说是可以接受的：
 *
 * 1. 后端端口范围（54320-54400）不太可能被其他应用使用
 * 2. SpinDB 是本地开发工具，不是生产服务器
 * 3. 如果发生冲突，PostgreSQL 启动时会失败并给出明确的错误
 * 4. CLI 层使用 startWithRetry() 可以用新端口重试
 *
 * 更健壮的方案会使用 SO_REUSEPORT 或持有 socket 直到 PostgreSQL 启动，
 * 但这会增加复杂性，而实际收益很小。
 */
async function allocateBackendPort(): Promise<number> {
  for (let port = BACKEND_PORT_START; port <= BACKEND_PORT_END; port++) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(
    `在 ${BACKEND_PORT_START}-${BACKEND_PORT_END} 范围内没有可用端口供 PostgreSQL 后端使用`,
  )
}

/**
 * 检查端口是否可用
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 等待 TCP 端口可以接受连接
 */
function waitForPort(port: number, timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500

  return new Promise((resolve) => {
    const check = () => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - startTime < timeoutMs) {
          setTimeout(check, checkInterval)
        } else {
          resolve(false)
        }
      })
      socket.once('timeout', () => {
        socket.destroy()
        if (Date.now() - startTime < timeoutMs) {
          setTimeout(check, checkInterval)
        } else {
          resolve(false)
        }
      })
      socket.connect(port, '127.0.0.1')
    }
    check()
  })
}

/**
 * 启动进程并将输入通过管道传送到 stdin。
 * 用于 `postgres --single`，它从 stdin 读取 SQL。
 */
function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options?: { env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options?.env ? { ...process.env, ...options.env } : undefined,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = options?.timeout
      ? setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
          reject(
            new Error(
              `命令 "${command}" 在 ${options.timeout}ms 后超时`,
            ),
          )
        }, options.timeout)
      : undefined

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (timedOut) return
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(
            `命令 "${command}" 以退出码 ${code} 失败: ${stderr || stdout}`,
          ),
        )
      }
    })

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (timedOut) return
      reject(err)
    })

    proc.stdin?.write(input)
    proc.stdin?.end()
  })
}

export class FerretDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'FerretDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // 获取当前平台和架构
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  /**
   * 检查当前平台是否支持 FerretDB
   * @param version - 可选版本（v1 支持 Windows，v2 不支持）
   */
  isPlatformSupported(version?: string): boolean {
    const { platform, arch } = this.getPlatformInfo()
    return isPlatformSupported(platform, arch, version)
  }

  /**
   * 从回退版本映射中返回可用的 FerretDB 版本。
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}

    for (const [major, full] of Object.entries(FALLBACK_VERSION_MAP)) {
      if (/^\d+$/.test(major)) {
        versions[major] = [full]
      }
    }

    return versions
  }

  // 从 hostdb 获取二进制文件下载 URL
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    const backendVersion = isV1(version)
      ? DEFAULT_V1_POSTGRESQL_VERSION
      : DEFAULT_DOCUMENTDB_VERSION
    const urls = getBinaryUrls(version, backendVersion, platform, arch)
    return urls.ferretdb
  }

  // 将版本字符串解析为完整版本
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  // 获取版本对应的二进制文件安装路径
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return ferretdbBinaryManager.getFerretDBBinaryPath(fullVersion, p, a)
  }

  /**
   * 验证 FerretDB 二进制文件是否可用且功能正常
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    if (version) {
      const backendVersion = isV1(version)
        ? DEFAULT_V1_POSTGRESQL_VERSION
        : DEFAULT_DOCUMENTDB_VERSION
      return ferretdbBinaryManager.isInstalled(version, p, a, backendVersion)
    }

    // 回退：从目录名提取版本
    const dirName = basename(binPath)
    const match = dirName.match(/^ferretdb-([\d.]+)-/)
    if (match) {
      const extractedVersion = match[1]
      const backendVersion = isV1(extractedVersion)
        ? DEFAULT_V1_POSTGRESQL_VERSION
        : DEFAULT_DOCUMENTDB_VERSION
      return ferretdbBinaryManager.isInstalled(
        extractedVersion,
        p,
        a,
        backendVersion,
      )
    }

    // 最后手段：检查文件是否存在
    const ext = platformService.getExecutableExtension()
    const ferretdbPath = join(binPath, 'bin', `ferretdb${ext}`)
    return existsSync(ferretdbPath)
  }

  // 检查指定 FerretDB 版本是否已安装
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    const backendVersion = isV1(version)
      ? DEFAULT_V1_POSTGRESQL_VERSION
      : DEFAULT_DOCUMENTDB_VERSION
    return ferretdbBinaryManager.isInstalled(
      version,
      platform,
      arch,
      backendVersion,
    )
  }

  /**
   * 确保指定版本的 FerretDB 二进制文件可用
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const backendVersion = isV1(version)
      ? DEFAULT_V1_POSTGRESQL_VERSION
      : DEFAULT_DOCUMENTDB_VERSION

    // 下载二进制文件（代理 + 后端）
    const { ferretdbPath } = await ferretdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
      backendVersion,
    )

    // 在配置中注册 ferretdb 二进制文件
    const ext = platformService.getExecutableExtension()
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    if (existsSync(ferretdbBinary)) {
      await configManager.setBinaryPath('ferretdb', ferretdbBinary, 'bundled')
    }

    return ferretdbPath
  }

  /**
   * 获取容器的后端二进制文件路径和 spawn 环境变量。
   * 集中管理 v1/v2 的分支逻辑。
   */
  private getBackendPaths(
    version: string,
    backendVersion: string,
    platform: Platform,
    arch: Arch,
  ): { backendPath: string; pgSpawnEnv: Record<string, string> | undefined } {
    const fullVersion = normalizeVersion(version)
    const backendPath = ferretdbBinaryManager.getBackendBinaryPath(
      fullVersion,
      backendVersion,
      platform,
      arch,
    )

    const baseSpawnEnv = ferretdbBinaryManager.getBackendSpawnEnv(
      fullVersion,
      backendVersion,
      platform,
      arch,
    )
    const pgSpawnEnv =
      platform === 'darwin'
        ? {
            ...baseSpawnEnv,
            DYLD_FALLBACK_LIBRARY_PATH: join(backendPath, 'lib'),
          }
        : baseSpawnEnv

    return { backendPath, pgSpawnEnv }
  }

  /**
   * 初始化新的 FerretDB 容器目录
   * 同时创建 PostgreSQL 数据目录和 FerretDB 配置
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const version = normalizeVersion(_version)
    const v1 = isV1(version)

    // 获取二进制文件路径 —— 根据 v1/v2 解析后端
    const backendVersion = v1
      ? (options.backendVersion as string) || DEFAULT_V1_POSTGRESQL_VERSION
      : (options.backendVersion as string) || DEFAULT_DOCUMENTDB_VERSION

    const { backendPath: documentdbPath, pgSpawnEnv: initSpawnEnv } =
      this.getBackendPaths(version, backendVersion, platform, arch)

    // 容器目录结构
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const pgDataDir = join(containerDir, 'pg_data')
    const logsDir = join(containerDir, 'logs')

    // 创建目录
    await mkdir(containerDir, { recursive: true })
    await mkdir(logsDir, { recursive: true })

    // 初始化 PostgreSQL 数据目录
    // 检查 PG_VERSION 文件以确定是否已初始化
    // （目录可能已存在但为空，由 containerManager.create 创建）
    const pgVersionFile = join(pgDataDir, 'PG_VERSION')
    if (!existsSync(pgVersionFile)) {
      const ext = platformService.getExecutableExtension()
      const initdb = join(documentdbPath, 'bin', `initdb${ext}`)

      if (!existsSync(initdb)) {
        throw new Error(`initdb 未找到于 ${initdb}`)
      }

      // Homebrew 派生的 x64 二进制文件中编译了 sharedir、pkglibdir ($libdir) 和
      // libdir 的绝对路径，这些路径在从 ~/.spindb/bin/ 运行时不存在。我们通过以下方式修复：
      // 1. 使用 initdb 的 -L 标志显式设置 share 目录
      // 2. 在编译路径处创建符号链接（这些是 bootstrap postgres 子进程在 initdb 期间需要的）
      const shareDirBase = join(documentdbPath, 'share')
      const actualShareDir = existsSync(join(shareDirBase, 'postgres.bki'))
        ? shareDirBase
        : existsSync(join(shareDirBase, 'postgresql', 'postgres.bki'))
          ? join(shareDirBase, 'postgresql')
          : shareDirBase

      // 仅 v2：Homebrew 派生的 DocumentDB 二进制文件需要编译路径修复
      // v1 使用普通 PostgreSQL，具有正确的相对路径
      if (!v1 && platform === 'darwin') {
        const pgConfigBin = join(documentdbPath, 'bin', `pg_config${ext}`)
        if (existsSync(pgConfigBin)) {
          // 查询所有相关的编译路径并在需要时创建符号链接
          const pathFixups: Array<{
            flag: string
            actualDir: string
            label: string
          }> = [
            { flag: '--sharedir', actualDir: actualShareDir, label: 'share' },
            {
              flag: '--pkglibdir',
              actualDir: existsSync(join(documentdbPath, 'lib', 'postgresql'))
                ? join(documentdbPath, 'lib', 'postgresql')
                : join(documentdbPath, 'lib'),
              label: 'pkglib',
            },
            {
              flag: '--libdir',
              actualDir: join(documentdbPath, 'lib'),
              label: 'lib',
            },
          ]

          // 在编译路径处创建符号链接，以便 PostgreSQL 能找到其库。
          // 这些路径可能在系统目录中（例如 /usr/local/），需要提升权限才能写入。
          for (const { flag, actualDir, label } of pathFixups) {
            try {
              const { stdout: out } = await execAsync(
                `"${pgConfigBin}" ${flag}`,
                { timeout: 5000 },
              )
              const compiledDir = out.trim()
              logDebug(`pg_config ${flag}: ${compiledDir}`)
              if (compiledDir && !existsSync(compiledDir)) {
                await mkdir(dirname(compiledDir), { recursive: true })
                await symlink(actualDir, compiledDir)
                logDebug(
                  `已创建 ${label} 符号链接: ${compiledDir} -> ${actualDir}`,
                )
              }
            } catch (error) {
              const e = error as NodeJS.ErrnoException
              const isPermission =
                e.code === 'EACCES' ||
                e.code === 'EPERM' ||
                (e.message && /permission denied/i.test(e.message))
              if (isPermission) {
                logWarning(
                  `无法创建 ${label} 符号链接（权限被拒绝）。` +
                    `这可能是由于 macOS SIP 或容器/sudo 限制，当编译路径指向系统目录时会发生。` +
                    `解决方案：使用非系统安装路径，或在可用时以提升的权限运行（例如 sudo spindb engines download ferretdb <version>）。` +
                    `参见 https://github.com/robertjbass/spindb#ferretdb 了解详情。` +
                    `目标: ${flag} -> ${actualDir}`,
                )
              } else {
                logDebug(`无法修复编译的 ${label} 路径: ${e.message}`)
              }
            }
          }
        }
      } else if (!v1) {
        logDebug(
          '跳过 pg_config 符号链接修复（此平台不需要）',
        )
      }

      // 仅 v2：修复 DocumentDB 扩展库中硬编码的 Homebrew dylib 路径
      // v1 使用普通 PostgreSQL，没有 DocumentDB 扩展
      if (!v1 && platform === 'darwin') {
        const dylibMarker = join(documentdbPath, '.dylib_fix_done')
        if (!existsSync(dylibMarker)) {
          await this.fixDylibDependencies(documentdbPath)
          try {
            await writeFile(dylibMarker, '', { flag: 'wx' })
          } catch {
            // 标记文件可能已从并行初始化中存在 —— 安全忽略
          }
        }
      }

      try {
        await spawnAsync(
          initdb,
          [
            '-D',
            pgDataDir,
            '-U',
            'postgres',
            '--encoding=UTF8',
            '--locale=C',
            '-L',
            actualShareDir,
          ],
          { env: initSpawnEnv, timeout: 60000 },
        )
        logDebug(`已初始化 PostgreSQL 数据目录: ${pgDataDir}`)
      } catch (error) {
        const err = error as Error
        throw new Error(`初始化 PostgreSQL 失败: ${err.message}`)
      }

      // 仅 v2：复制打包的 postgresql.conf.sample 以确保 shared_preload_libraries 已设置
      // 这对 DocumentDB 扩展正确加载至关重要
      // v1 使用 initdb 默认值（无需预加载 DocumentDB 扩展）
      if (!v1) {
        const bundledConf = existsSync(
          join(shareDirBase, 'postgresql.conf.sample'),
        )
          ? join(shareDirBase, 'postgresql.conf.sample')
          : join(shareDirBase, 'postgresql', 'postgresql.conf.sample')
        const pgConf = join(pgDataDir, 'postgresql.conf')

        if (existsSync(bundledConf)) {
          try {
            // 读取打包的配置
            let confContent = await readFile(bundledConf, 'utf8')

            // 将 cron.database_name 更新为 'ferretdb'（pg_cron 与 DocumentDB 配合使用所需）
            confContent = confContent.replace(
              /cron\.database_name\s*=\s*'[^']*'/,
              "cron.database_name = 'ferretdb'",
            )

            // 写入修改后的配置
            await writeFile(pgConf, confContent)
            logDebug(`已复制并配置 postgresql.conf 到 ${pgConf}`)
          } catch (copyError) {
            logDebug(
              `警告：无法复制 postgresql.conf.sample: ${copyError}`,
            )
            // 继续执行 —— initdb 会创建默认配置
          }
        } else {
          logDebug(`打包的 postgresql.conf.sample 未找到于 ${bundledConf}`)
        }
      }
    }

    return pgDataDir
  }

  /**
   * 启动 FerretDB（双进程生命周期）
   *
   * 1. 分配/验证后端端口
   * 2. 启动 PostgreSQL
   * 3. 等待 PostgreSQL 就绪
   * 4. 创建 ferretdb 数据库 + 扩展（首次启动）
   * 5. 启动 FerretDB 代理
   * 6. 验证 FerretDB 连接
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const {
      name,
      port,
      version,
      backendVersion,
      backendPort: existingBackendPort,
    } = container

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

    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const v1 = isV1(version)
    const effectiveBackendVersion = v1
      ? backendVersion || DEFAULT_V1_POSTGRESQL_VERSION
      : normalizeDocumentDBVersion(backendVersion || DEFAULT_DOCUMENTDB_VERSION)

    // 使用版本感知的辅助函数获取二进制文件路径
    const ferretdbPath = ferretdbBinaryManager.getFerretDBBinaryPath(
      fullVersion,
      platform,
      arch,
    )
    const { backendPath: documentdbPath, pgSpawnEnv } = this.getBackendPaths(
      version,
      effectiveBackendVersion,
      platform,
      arch,
    )

    const ext = platformService.getExecutableExtension()
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${ext}`)
    // v1 后端可能是最小化的 PostgreSQL 安装（与 DocumentDB 共享），
    // 缺少客户端工具。使用 postgres --single 作为数据库创建的回退方案。
    const psqlCandidate = join(documentdbPath, 'bin', `psql${ext}`)
    const psql = existsSync(psqlCandidate) ? psqlCandidate : null
    const postgresBinary = join(documentdbPath, 'bin', `postgres${ext}`)

    // 验证二进制文件存在
    if (!existsSync(ferretdbBinary)) {
      throw new Error(
        `FerretDB 二进制文件未找到。请运行: spindb engines download ferretdb ${version}`,
      )
    }
    if (!existsSync(pgCtl)) {
      throw new Error(
        `postgresql-documentdb 未找到。请运行: spindb engines download ferretdb ${version}`,
      )
    }

    // 容器路径
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pgDataDir = join(containerDir, 'pg_data')
    const logsDir = join(containerDir, 'logs')
    const pgLogFile = join(logsDir, 'postgres.log')
    const ferretPidFile = join(containerDir, 'ferretdb.pid')

    // 分配后端端口
    const backendPort = existingBackendPort || (await allocateBackendPort())

    // 仅 v2：修复硬编码的 Homebrew dylib 路径（darwin-x64 二进制文件）
    // 如果已完成则跳过（标记由 initDataDir 或之前的启动写入）
    // v1 使用普通 PostgreSQL，没有 DocumentDB 扩展
    if (!v1 && platform === 'darwin') {
      const dylibMarker = join(documentdbPath, '.dylib_fix_done')
      if (!existsSync(dylibMarker)) {
        await this.fixDylibDependencies(documentdbPath)
        try {
          await writeFile(dylibMarker, '', { flag: 'wx' })
        } catch {
          // 标记文件可能已存在 —— 安全忽略
        }
      }
    }

    let pgStarted = false
    let ferretStarted = false

    try {
      // 1. 启动 PostgreSQL（如果已在运行则跳过）
      onProgress?.({
        stage: 'starting',
        message: '正在启动 PostgreSQL 后端...',
      })

      // 检查 PostgreSQL 后端是否已在此数据目录中运行
      let pgAlreadyRunning = false
      try {
        await spawnAsync(pgCtl, ['status', '-D', pgDataDir], {
          env: pgSpawnEnv,
          timeout: 5000,
        })
        // pg_ctl status 在服务器运行时退出码为 0
        pgAlreadyRunning = true
        logDebug('PostgreSQL 后端已在运行，跳过启动')
      } catch {
        // 退出码 != 0 表示未运行 —— 继续启动
      }

      // v1 预启动：当 psql 不可用时（最小化 PG 安装可能缺少客户端工具），
      // 使用 postgres --single 模式创建 ferretdb 数据库。
      // postgres --single 需要独占数据目录访问，因此必须在 pg_ctl start 之前执行。
      if (v1 && !psql && !pgAlreadyRunning) {
        logDebug(
          '后端中未找到 psql，使用 postgres --single 预创建数据库',
        )
        try {
          await spawnWithInput(
            postgresBinary,
            ['--single', '-D', pgDataDir, 'postgres'],
            "CREATE DATABASE ferretdb ENCODING 'UTF8';\n",
            { env: pgSpawnEnv, timeout: 30000 },
          )
          logDebug('已通过 postgres --single 预创建 ferretdb 数据库')
        } catch {
          // 数据库可能已从之前的启动中存在 —— 安全忽略
          logDebug(
            'postgres --single CREATE DATABASE 失败（可能已存在）',
          )
        }
      }

      if (!pgAlreadyRunning) {
        // 使用 pg_ctl 启动 PostgreSQL
        // 在 Windows 上，spawnAsync 管道传输 stdout/stderr 会被 PostgreSQL 后台进程继承，
        // 阻止 'close' 事件触发直到 PG 自身退出（即使 PG 已就绪也会导致 30 秒超时）。
        // 在 Windows 上使用 exec()（与 process-manager.ts 方法一致），通过 shell 运行，
        // 不会保持管道打开。在 Unix 上，使用 -w（等待模式）。
        try {
          if (isWindows()) {
            const cmd = `"${pgCtl}" start -D "${pgDataDir}" -l "${pgLogFile}" -o "-p ${backendPort} -h 127.0.0.1"`
            await execAsync(cmd, {
              env: { ...process.env, ...pgSpawnEnv },
              timeout: 30000,
            })
          } else {
            const pgCtlArgs = [
              'start',
              '-D',
              pgDataDir,
              '-l',
              pgLogFile,
              '-o',
              `-p ${backendPort} -h 127.0.0.1`,
              '-w',
            ]
            await spawnAsync(pgCtl, pgCtlArgs, {
              env: pgSpawnEnv,
              timeout: 60000,
            })
          }
        } catch (pgError) {
          // 读取 PostgreSQL 日志用于调试
          let pgLog = ''
          try {
            pgLog = await readFile(pgLogFile, 'utf8')
          } catch {
            pgLog = '（无日志可用）'
          }
          throw new Error(
            `PostgreSQL 后端启动失败: ${pgError instanceof Error ? pgError.message : pgError}\n` +
              `PostgreSQL 日志:\n${pgLog.slice(-2000)}`, // 最后 2KB 日志
          )
        }
      }

      pgStarted = true
      logDebug(`PostgreSQL 已在端口 ${backendPort} 上启动`)

      // 2. 等待 PostgreSQL 就绪
      onProgress?.({ stage: 'starting', message: '正在等待 PostgreSQL...' })
      const pgReady = await waitForPort(backendPort, 30000)
      if (!pgReady) {
        throw new Error('PostgreSQL 在超时时间内未能启动')
      }

      // 3. 创建 ferretdb 数据库和扩展（首次启动）
      // 对于没有 psql 的 v1，数据库已通过 postgres --single 在启动前创建
      if (psql) {
        onProgress?.({
          stage: 'starting',
          message: '正在初始化 FerretDB 数据库...',
        })
        try {
          // 如果 ferretdb 数据库不存在则创建
          await spawnAsync(
            psql,
            [
              '-h',
              '127.0.0.1',
              '-p',
              String(backendPort),
              '-U',
              'postgres',
              '-c',
              "CREATE DATABASE ferretdb WITH ENCODING 'UTF8';",
            ],
            { env: pgSpawnEnv, timeout: 30000 },
          ).catch(() => {
            // 如果数据库已存在则忽略错误（错误码 42P04）
          })

          // 仅 v2：创建 DocumentDB 扩展
          // v1 使用普通 PostgreSQL，没有 DocumentDB
          if (!v1) {
            await spawnAsync(
              psql,
              [
                '-h',
                '127.0.0.1',
                '-p',
                String(backendPort),
                '-U',
                'postgres',
                '-d',
                'ferretdb',
                '-c',
                'CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;',
              ],
              { env: pgSpawnEnv, timeout: 30000 },
            ).catch((error) => {
              logWarning(`创建 documentdb 扩展失败: ${error}`)
              // 继续执行 —— 扩展可能已存在
            })
          }

          logDebug('FerretDB 数据库已初始化')
        } catch (error) {
          logDebug(`数据库初始化警告: ${error}`)
          // 继续 —— 可能已初始化
        }
      }

      // 4. 启动 FerretDB 代理
      onProgress?.({ stage: 'starting', message: '正在启动 FerretDB 代理...' })

      // 禁用本地开发的身份验证（类似于 PostgreSQL 的 trust 认证）
      // FerretDB 2.x 默认启用认证，但对于本地开发我们禁用它
      // 使用唯一的调试端口以避免运行多个 FerretDB 容器时的冲突
      const FERRETDB_DEBUG_PORT_OFFSET = 10000
      const FERRETDB_DEBUG_PORT_MAX_ATTEMPTS = 10
      let debugPort = port + FERRETDB_DEBUG_PORT_OFFSET

      // 探测可用调试端口，如果计算出的端口被占用则递增
      let debugPortFound = false
      for (
        let attempt = 0;
        attempt < FERRETDB_DEBUG_PORT_MAX_ATTEMPTS;
        attempt++
      ) {
        const candidatePort = debugPort + attempt
        if (await isPortAvailable(candidatePort)) {
          debugPort = candidatePort
          debugPortFound = true
          break
        }
        logDebug(`调试端口 ${candidatePort} 已被占用，尝试下一个...`)
      }

      if (!debugPortFound) {
        logWarning(
          `在 ${debugPort}-${debugPort + FERRETDB_DEBUG_PORT_MAX_ATTEMPTS - 1} 范围内未找到可用调试端口，仍使用计算出的端口 ${port + FERRETDB_DEBUG_PORT_OFFSET}`,
        )
        debugPort = port + FERRETDB_DEBUG_PORT_OFFSET
      }

      logDebug(`FerretDB HTTP 调试处理器使用调试端口 ${debugPort}`)

      // v1 使用普通 PostgreSQL，未配置 TLS，因此需要 sslmode=disable
      // v2 使用 postgresql-documentdb，内部处理 SSL 协商
      const pgUrl = isV1(version)
        ? `postgres://postgres@127.0.0.1:${backendPort}/ferretdb?sslmode=disable`
        : `postgres://postgres@127.0.0.1:${backendPort}/ferretdb`

      const bindAddress = container.bindAddress ?? '127.0.0.1'
      const ferretArgs = [
        '--listen-addr',
        `${bindAddress}:${port}`,
        '--postgresql-url',
        pgUrl,
        '--state-dir',
        containerDir,
        // v2 默认启用 SCRAM 认证。传递 --no-auth 以禁用它。
        // v1 默认禁用认证（标志不存在）。
        // authEnabled=true 表示 SCRAM 开启（省略 --no-auth）；默认为认证禁用。
        ...(isV1(version) || container.authEnabled === true
          ? []
          : ['--no-auth']),
        '--debug-addr',
        `127.0.0.1:${debugPort}`,
      ]

      logDebug(`正在启动 FerretDB，参数: ${ferretArgs.join(' ')}`)

      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        // 在容器目录中运行 FerretDB，以便 telemetry.json/state.json
        // 写入该目录，而不是污染用户的当前工作目录
        cwd: containerDir,
      }

      const proc = spawn(ferretdbBinary, ferretArgs, spawnOpts)
      proc.unref()

      // 写入 PID 文件
      if (proc.pid) {
        await writeFile(ferretPidFile, String(proc.pid))
        ferretStarted = true
      }

      // 5. 等待 FerretDB 就绪
      const ferretReady = await waitForPort(port, 30000)
      if (!ferretReady) {
        throw new Error(
          `FerretDB 在超时时间内未能启动。请检查日志: ${containerDir}`,
        )
      }

      logDebug(`FerretDB 已在端口 ${port} 上启动`)

      // 如果是新分配的后端端口，则持久化保存
      if (!existingBackendPort && backendPort) {
        await containerManager.updateConfig(name, { backendPort })
        logDebug(`已将后端端口 ${backendPort} 持久化到容器配置`)
      }

      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    } catch (error) {
      // 回滚：停止任何已启动的进程
      if (ferretStarted) {
        await this.stopFerretDBProcess(containerDir).catch(() => {})
      }
      if (pgStarted) {
        await this.stopPostgreSQLProcess(pgCtl, pgDataDir, pgSpawnEnv).catch(
          () => {},
        )
      }
      throw error
    }
  }

  /**
   * 停止 FerretDB（逆序：先 FerretDB，后 PostgreSQL）
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, version, backendVersion } = container
    const { platform, arch } = this.getPlatformInfo()
    const v1 = isV1(version)

    const effectiveBackendVersion = v1
      ? backendVersion || DEFAULT_V1_POSTGRESQL_VERSION
      : backendVersion || DEFAULT_DOCUMENTDB_VERSION

    const { backendPath: documentdbPath, pgSpawnEnv } = this.getBackendPaths(
      version,
      effectiveBackendVersion,
      platform,
      arch,
    )

    const ext = platformService.getExecutableExtension()
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${ext}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pgDataDir = join(containerDir, 'pg_data')

    logDebug(`正在停止 FerretDB 容器 "${name}"`)

    // 1. 停止 FerretDB 代理
    await this.stopFerretDBProcess(containerDir)

    // 2. 停止 PostgreSQL
    if (existsSync(pgCtl)) {
      await this.stopPostgreSQLProcess(pgCtl, pgDataDir, pgSpawnEnv)
    }

    // 如果 pgweb 正在运行则停止
    await this.stopPgweb(name)

    logDebug('FerretDB 已停止')
  }

  /**
   * 修复扩展库中硬编码的 Homebrew dylib 路径。
   *
   * postgresql-documentdb 的 x64 darwin 构建中，扩展的 dylib
   * 加载命令引用了绝对 Homebrew 路径（例如
   * /usr/local/opt/mongo-c-driver/lib/libbson2.2.dylib）。当这些路径
   * 在目标机器上不存在时，扩展加载失败。
   *
   * 此方法使用 `otool -L` 扫描扩展 dylib，查找缺失的
   * 依赖项，在我们的打包中搜索匹配的库，并在预期的
   * Homebrew 路径处创建符号链接。
   */
  private async fixDylibDependencies(documentdbPath: string): Promise<void> {
    const libDir = join(documentdbPath, 'lib')
    const pkgLibDir = join(libDir, 'postgresql')

    if (!existsSync(pkgLibDir)) return

    // 收集打包中 lib/ 目录下的所有 .dylib 文件
    const bundledLibNames = new Set<string>()
    const bundledLibPaths = new Map<string, string>()
    try {
      const libFiles = await readdir(libDir)
      for (const f of libFiles) {
        if (f.endsWith('.dylib')) {
          bundledLibNames.add(f)
          bundledLibPaths.set(f, join(libDir, f))
        }
      }
    } catch {
      return
    }

    // 扫描扩展 dylib 查找缺失的依赖项
    let extFiles: string[]
    try {
      extFiles = (await readdir(pkgLibDir)).filter((f) => f.endsWith('.dylib'))
    } catch {
      return
    }

    for (const extFile of extFiles) {
      const extPath = join(pkgLibDir, extFile)
      try {
        const { stdout } = await execAsync(`otool -L "${extPath}"`, {
          timeout: 5000,
        })

        for (const line of stdout.split('\n')) {
          const match = line.trim().match(/^(\/[^\s]+\.dylib)\s/)
          if (!match) continue
          const depPath = match[1]

          // 跳过系统库、@-前缀路径和打包中的路径
          if (depPath.startsWith('/usr/lib/')) continue
          if (depPath.startsWith('/System/')) continue
          if (depPath.startsWith('@')) continue
          if (depPath.includes(documentdbPath)) continue

          if (!existsSync(depPath)) {
            const depName = basename(depPath)

            // 检查我们的打包中是否有这个精确的库
            if (bundledLibPaths.has(depName)) {
              try {
                await mkdir(dirname(depPath), { recursive: true })
              } catch {
                logDebug(
                  `无法为 dylib 依赖创建目录: ${dirname(depPath)}（跳过）`,
                )
                continue
              }
              try {
                await symlink(bundledLibPaths.get(depName)!, depPath)
                logDebug(
                  `已修复 dylib 依赖: ${depPath} -> ${bundledLibPaths.get(depName)}`,
                )
              } catch {
                // 符号链接可能已从并行修复中存在
              }
            } else {
              logDebug(
                `缺失 dylib 依赖: ${depPath}（在打包中未找到）`,
              )
            }
          }
        }
      } catch {
        logDebug(`无法扫描 ${extFile} 的 dylib 依赖`)
      }
    }
  }

  /**
   * 停止 FerretDB 代理进程
   */
  private async stopFerretDBProcess(containerDir: string): Promise<void> {
    const pidFile = join(containerDir, 'ferretdb.pid')

    if (existsSync(pidFile)) {
      let pid = NaN
      try {
        const pidContent = await readFile(pidFile, 'utf8')
        pid = parseInt(pidContent.trim(), 10)
      } catch {
        // PID 文件不可读 —— 在下面清理
      }

      if (!isNaN(pid) && platformService.isProcessRunning(pid)) {
        logDebug(`正在终止 FerretDB 进程 ${pid}`)

        // 在 Windows 上，不带 /F 的 taskkill 发送 WM_CLOSE，控制台/服务器
        // 进程会忽略它，导致错误。直接使用强制终止。
        if (isWindows()) {
          try {
            await platformService.terminateProcess(pid, true)
          } catch {
            logDebug(`强制终止 FerretDB 进程 ${pid} 失败`)
          }
        } else {
          // Unix：先尝试优雅的 SIGTERM，然后 SIGKILL
          try {
            await platformService.terminateProcess(pid, false)
          } catch {
            // 优雅终止失败 —— 在下面强制终止
          }

          // 轮询直到进程退出或超时（10 秒）
          const maxWaitMs = 10000
          const pollIntervalMs = 200
          const startTime = Date.now()

          while (Date.now() - startTime < maxWaitMs) {
            if (!platformService.isProcessRunning(pid)) {
              logDebug(`FerretDB 进程 ${pid} 已优雅终止`)
              break
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
          }

          // 超时后如果仍在运行则强制终止
          if (platformService.isProcessRunning(pid)) {
            logWarning(`优雅终止超时，强制终止 ${pid}`)
            try {
              await platformService.terminateProcess(pid, true)
            } catch {
              logDebug(`强制终止 FerretDB 进程 ${pid} 失败`)
            }
          }
        }

        // 强制终止后短暂等待进程完全退出
        const exitWaitMs = isWindows() ? 3000 : 1000
        const pollMs = 100
        const exitStart = Date.now()
        while (Date.now() - exitStart < exitWaitMs) {
          if (!platformService.isProcessRunning(pid)) break
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
      }

      // 始终清理 PID 文件
      await unlink(pidFile).catch(() => {})
    }
  }

  /**
   * 停止 PostgreSQL 进程
   */
  private async stopPostgreSQLProcess(
    pgCtl: string,
    pgDataDir: string,
    spawnEnv?: Record<string, string>,
  ): Promise<void> {
    if (isWindows()) {
      // 在 Windows 上，使用 exec() 而非 spawnAsync() 以避免管道相关的
      // 挂起（与 pg_ctl start -w 相同的问题）。pg_ctl stop -w 在
      // stdout/stderr 管道阻止子进程干净退出时可能会阻塞。
      try {
        await execAsync(`"${pgCtl}" stop -D "${pgDataDir}" -m fast -w`, {
          timeout: 30000,
          env: spawnEnv ? { ...process.env, ...spawnEnv } : undefined,
        })
        logDebug('PostgreSQL 已停止')
      } catch (error) {
        logDebug(`pg_ctl stop 错误: ${error}`)
        try {
          await execAsync(`"${pgCtl}" stop -D "${pgDataDir}" -m immediate -w`, {
            timeout: 15000,
            env: spawnEnv ? { ...process.env, ...spawnEnv } : undefined,
          })
        } catch {
          logWarning('无法优雅地停止 PostgreSQL')
        }
      }
    } else {
      try {
        await spawnAsync(pgCtl, ['stop', '-D', pgDataDir, '-m', 'fast', '-w'], {
          env: spawnEnv,
          timeout: 30000,
        })
        logDebug('PostgreSQL 已停止')
      } catch (error) {
        logDebug(`pg_ctl stop 错误: ${error}`)
        try {
          await spawnAsync(
            pgCtl,
            ['stop', '-D', pgDataDir, '-m', 'immediate', '-w'],
            { env: spawnEnv, timeout: 15000 },
          )
        } catch {
          logWarning('无法优雅地停止 PostgreSQL')
        }
      }
    }
  }

  private async getLocalAuth(
    containerName: string,
  ): Promise<LocalFerretAuth | null> {
    const savedCreds = await loadCredentials(
      containerName,
      Engine.FerretDB,
      getDefaultUsername(Engine.FerretDB),
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
    const connectHost = normalizeMongoHost(container.bindAddress)
    const args = savedCreds
      ? [
          buildMongoUri(
            container.port,
            database,
            savedCreds,
            connectHost,
          ),
        ]
      : ['--host', connectHost, '--port', String(container.port), database]

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

  // 获取 FerretDB 服务器状态
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'ferretdb.pid')

    // 检查 FerretDB 是否响应
    const isOpen = await new Promise<boolean>((resolve) => {
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

    if (isOpen) {
      return { running: true, message: 'FerretDB 正在运行' }
    }

    // 检查 PID 文件
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `FerretDB 正在运行（PID: ${pid}）`,
          }
        }
      } catch {
        // 忽略
      }
    }

    return { running: false, message: 'FerretDB 未运行' }
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
    const database = (options.database as string) || container.database || 'test'

    // 恢复前验证数据库名称（纵深防御）
    assertValidDatabaseName(database)

    return restoreBackup(container, backupPath, {
      containerName: container.name,
      port: container.port,
      database,
      drop: options.drop !== false,
      sourceDatabase: options.sourceDatabase as string | undefined,
      containerVersion: container.version,
    })
  }

  // 获取连接字符串（MongoDB 兼容）
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'test'
    return `mongodb://127.0.0.1:${port}/${db}`
  }

  // 获取 PostgreSQL 后端连接字符串（用于调试）
  getBackendConnectionString(container: ContainerConfig): string {
    const { backendPort } = container
    if (!backendPort) {
      throw new Error(
        '后端端口不可用 —— 请先启动容器以分配端口',
      )
    }
    return `postgresql://postgres@127.0.0.1:${backendPort}/ferretdb`
  }

  /**
   * 获取 mongosh 的路径（使用 MongoDB 的 mongosh）
   * FerretDB 兼容 MongoDB，因此使用相同的 shell
   */
  override async getMongoshPath(): Promise<string> {
    const cached = await configManager.getBinaryPath('mongosh')
    if (cached && existsSync(cached)) return cached

    // 尝试在 PATH 中查找作为回退
    const detected = await platformService.findToolPath('mongosh')
    if (detected) {
      await configManager.setBinaryPath('mongosh', detected, 'system')
      return detected
    }

    throw new Error(
      '未找到 mongosh。要连接 FerretDB，请安装 mongosh:\n' +
        '  下载地址: https://www.mongodb.com/try/download/shell\n' +
        '  或下载 MongoDB 二进制文件: spindb engines download mongodb <version>',
    )
  }

  // 打开 mongosh 交互式 shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const db = database || container.database || 'test'

    const mongosh = await this.getMongoshPath()
    const args = await this.buildLocalMongoshArgs(container, db)

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
   * FerretDB/MongoDB 在首次写入数据时隐式创建数据库。
   * 为强制立即创建，我们创建一个临时集合并删除它。
   * 这样数据库在工具中可见，且不留任何标记集合。
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)

    try {
      // 创建临时集合并立即删除以强制创建数据库，
      // 不留下任何可见的标记集合。
      // 预先删除以防之前的运行被中断并留下了陈旧的集合。
      // 注意：使用 db.getCollection() 而非 db._spindb_init 简写，
      // 因为 mongosh 不支持下划线开头的集合名称的简写表示法。
      await this.runLocalMongosh(container, database, {
        eval: 'try { db.getCollection("_spindb_init").drop(); } catch(e) {} db.createCollection("_spindb_init"); db.getCollection("_spindb_init").drop();',
        timeoutMs: 10000,
      })
      logDebug(`数据库 "${database}" 已通过临时集合创建`)
    } catch (error) {
      // 忽略错误 —— 数据库可能已存在或集合清理已成功
      logDebug(`createDatabase 结果: ${error}`)
    }
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
      logDebug(`dropDatabase 结果: ${error}`)
    }
  }

  // 获取数据库大小（字节）
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { database } = container
    const db = database || 'test'
    assertValidDatabaseName(db)

    try {
      const { stdout } = await this.runLocalMongosh(container, db, {
        eval: 'JSON.stringify(db.stats())',
        quiet: true,
        timeoutMs: 10000,
      })

      // 从输出中提取 JSON
      const firstBrace = stdout.indexOf('{')
      const lastBrace = stdout.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const stats = JSON.parse(stdout.substring(firstBrace, lastBrace + 1))
        const dataSize = Number(stats?.dataSize)
        return Number.isFinite(dataSize) && dataSize > 0 ? dataSize : null
      }
      return null
    } catch {
      return null
    }
  }

  // 从远程数据库创建转储
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // 如果可用则使用 mongodump
    const mongodump = await configManager.getBinaryPath('mongodump')
    if (!mongodump) {
      throw new Error(
        '未找到 mongodump。请下载 MongoDB 二进制文件:\n' +
          '  运行: spindb engines download mongodb <version>',
      )
    }

    const args = [
      '--uri',
      connectionString,
      '--archive=' + outputPath,
      '--gzip',
    ]

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

  // 对数据库运行 JavaScript 文件或内联脚本
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

  /**
   * 执行查询并返回结构化结果
   * FerretDB 使用 MongoDB JavaScript 语法
   *
   * 示例：
   *   db.users.find({active: true})
   *   db.orders.countDocuments()
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'test'

    const mongosh = await this.getMongoshPath()

    // 规范化查询 —— 仅对集合操作添加 "db." 前缀
    // 集合操作匹配模式：identifier.method(...) 例如 "users.find({})"
    // 非集合查询（show dbs、任意 JS）会被拒绝并给出明确的错误
    let normalizedQuery = query.trim()
    if (!normalizedQuery.startsWith('db.')) {
      // 检查是否看起来像集合操作：identifier.method(
      const collectionOpPattern =
        /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\s*\(/
      if (collectionOpPattern.test(normalizedQuery)) {
        normalizedQuery = `db.${normalizedQuery}`
      } else {
        throw new Error(
          '无效的查询格式。期望集合操作如 "users.find({})" 或 "db.users.find({})"\n' +
            'executeQuery 不支持 "show dbs" 和 "use dbname" 等 shell 命令。',
        )
      }
    }

    const script = `(async () => { const res = ${normalizedQuery}; return JSON.stringify(res.toArray ? await res.toArray() : await Promise.resolve(res)); })()`
    let args: string[]
    if (options?.host) {
      const user = options.username ? encodeURIComponent(options.username) : ''
      const pass = options.password ? encodeURIComponent(options.password) : ''
      const auth = user ? `${user}:${pass}@` : ''
      const host = options.host
      const isSrv = options.scheme === 'mongodb+srv'
      const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
      const portSuffix = isSrv ? '' : `:${port}`
      const sslParam = options.ssl && !isSrv ? 'tls=true' : ''
      const uri = `${scheme}://${auth}${host}${portSuffix}/${db}${sslParam ? `?${sslParam}` : ''}`
      args = [uri, '--quiet', '--eval', script]
    } else {
      const savedCreds = await this.getLocalAuth(container.name)
      const connectHost = normalizeMongoHost(container.bindAddress)
      args = savedCreds
        ? [
            buildMongoUri(
              port,
              db,
              savedCreds,
              connectHost,
            ),
            '--quiet',
            '--eval',
            script,
          ]
        : [
            '--host',
            connectHost,
            '--port',
            String(port),
            db,
            '--quiet',
            '--eval',
            script,
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
              `${stderrBuf || `mongosh 以退出码 ${code} 退出`}${stdoutBuf ? `\n输出: ${stdoutBuf}` : ''}`,
            ),
          )
          return
        }
        resolve({ stdout: stdoutBuf, stderr: stderrBuf })
      })
    })

    if (stderr && !stdout.trim()) {
      throw new Error(`${stderr}${stdout ? `\n输出: ${stdout}` : ''}`)
    }

    const jsonMatch = stdout.match(/\[[\s\S]*\]|\{[\s\S]*\}/)
    if (!jsonMatch) {
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
   * FerretDB 使用 MongoDB 协议，因此与 MongoDB 方法相同。
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const mongosh = await this.getMongoshPath()

    return new Promise((resolve, reject) => {
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
            reject(new Error(`解析数据库列表失败: ${error}`))
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
    const db = database ?? container.database ?? 'admin'
    assertValidDatabaseName(db)
    const mongosh = await this.getMongoshPath()

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
        // 用户已存在 —— 更新密码
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

export const ferretdbEngine = new FerretDBEngine()
