import os
import re

SOURCE_DIR = r"E:\Npm_file\spindb\engines\typedb"
TARGET_DIR = os.path.join(os.path.dirname(__file__), "hanhua")
os.makedirs(TARGET_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# 文件1: backup.ts
# ---------------------------------------------------------------------------
backup_ts = r'''/**
 * TypeDB 备份模块
 *
 * TypeDB 将数据库导出为两个文件：schema（.typeql）和数据（.typeql）。
 * 我们使用控制台的 `database export` 命令来创建这两个文件。
 */

import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { stat } from 'fs/promises'
import { dirname } from 'path'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { requireTypeDBConsolePath, getConsoleBaseArgs } from './cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

/**
 * 使用 typedb 控制台导出功能创建 TypeQL 备份
 *
 * TypeDB 导出会根据 outputPath 创建两个文件：
 * - {base}-schema.typeql（schema 定义）
 * - {base}-data.typeql（数据插入语句）
 *
 * 返回的 BackupResult.path 是原始 outputPath（基础路径），
 * 而非单个备份文件。调用方（如 restore）必须使用相同的
 * `-schema.typeql` / `-data.typeql` 命名约定来推导实际文件路径。
 * 另请参阅：restore.ts 中的 restoreTypeQLBackup()，其推导逻辑与此对称。
 */
async function createTypeQLBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const consolePath = await requireTypeDBConsolePath(container.version)
  const { port } = container

  // 确保输出目录存在
  await mkdir(dirname(outputPath), { recursive: true })

  // 从输出路径推导 schema 和 data 文件路径
  const schemaPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-schema.typeql')
    : outputPath + '-schema.typeql'
  const dataPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-data.typeql')
    : outputPath + '-data.typeql'
  const savedCreds = await loadCredentials(
    container.name,
    Engine.TypeDB,
    getDefaultUsername(Engine.TypeDB),
  )

  const args = [
    ...getConsoleBaseArgs(
      port,
      '127.0.0.1',
      true,
      savedCreds
        ? {
            username: savedCreds.username,
            password: savedCreds.password,
          }
        : undefined,
    ),
    '--command',
    `database export ${database} ${schemaPath} ${dataPath}`,
  ]

  const sanitizedArgs = args.map((a, i) =>
    args[i - 1] === '--password' ? '***' : a,
  )
  logDebug(`Running: typedb_console_bin ${sanitizedArgs.join(' ')}`)

  return new Promise<BackupResult>((resolve, reject) => {
    const proc = spawn(consolePath, args, {
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

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          // 计算两个文件（schema + data）的总大小
          let schemaSize: number | null = null
          let dataSize: number | null = null
          const errors: string[] = []
          try {
            const schemaStats = await stat(schemaPath)
            schemaSize = schemaStats.size
          } catch (err) {
            errors.push(`schema(${schemaPath}): ${err}`)
          }
          try {
            const dataStats = await stat(dataPath)
            dataSize = dataStats.size
          } catch (err) {
            errors.push(`data(${dataPath}): ${err}`)
          }

          if (
            errors.length > 0 ||
            schemaSize === null ||
            dataSize === null ||
            schemaSize === 0 ||
            dataSize === 0
          ) {
            reject(
              new Error(
                `备份产生空文件或缺失文件: schema=${schemaPath}, data=${dataPath}` +
                  (errors.length > 0
                    ? `。stat 错误: ${errors.join('; ')}`
                    : ''),
              ),
            )
            return
          }

          // path 为基础 outputPath；实际文件为 schemaPath 和 dataPath
          resolve({
            path: outputPath,
            format: 'typeql',
            size: schemaSize + dataSize,
          })
        } catch (error) {
          reject(new Error(`备份文件未创建: ${error}`))
        }
      } else if (code === null) {
        const detail = stderr || stdout
        reject(
          new Error(
            `typedb 控制台导出被信号终止${detail ? `: ${detail}` : ''}`,
          ),
        )
      } else {
        const detail = stderr || stdout
        reject(
          new Error(
            `typedb 控制台导出退出，返回码 ${code}${detail ? `: ${detail}` : ''}`,
          ),
        )
      }
    })
  })
}

/**
 * 创建备份
 *
 * @param container - 容器配置
 * @param outputPath - 备份文件写入路径
 * @param options - 备份选项
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database

  return createTypeQLBackup(container, outputPath, database)
}

/**
 * 为克隆目的创建备份
 * 使用 TypeQL 格式以确保可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createTypeQLBackup(container, outputPath, container.database)
}
'''

# ---------------------------------------------------------------------------
# 文件2: binary-manager.ts
# ---------------------------------------------------------------------------
binary_manager_ts = r'''/**
 * TypeDB 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 TypeDB 二进制文件。
 * 继承自 BaseBinaryManager，复用共享的下载/解压逻辑。
 *
 * TypeDB 归档文件解压后产生一个 `typedb/` 目录，嵌套结构如下：
 *   typedb/
 *   ├── typedb                  （启动脚本）
 *   ├── server/
 *   │   ├── typedb_server_bin   （服务器二进制文件）
 *   │   └── config.yml          （默认配置）
 *   ├── console/
 *   │   └── typedb_console_bin  （控制台二进制文件）
 *   └── LICENSE
 *
 * 我们重新组织目录结构，保留启动脚本所期望的相对路径：
 *   bin/
 *   ├── typedb                  （启动器）
 *   ├── server/
 *   │   └── typedb_server_bin   （服务器二进制文件）
 *   ├── console/
 *   │   └── typedb_console_bin  （控制台二进制文件）
 *   └── config.yml              （移出供参考）
 *   server/
 *   └── config.yml              （默认配置供参考）
 */

import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { moveEntry } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'

class TypeDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.TypeDB,
    engineName: 'typedb',
    displayName: 'TypeDB',
    serverBinary: 'typedb',
  }

  protected getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }

  protected normalizeVersionFromModule(version: string): string {
    return normalizeVersion(version)
  }

  protected parseVersionFromOutput(stdout: string): string | null {
    // 尝试三段式语义化版本号（如 "3.8.0"）
    const threePartMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    if (threePartMatch) {
      return threePartMatch[1]
    }

    // 回退：两段式版本号（如 "3.8"）
    const twoPartMatch = stdout.match(/(\d+\.\d+)/)
    if (twoPartMatch) {
      logDebug(
        `TypeDB 版本解析为两段式: ${twoPartMatch[1]} (来源: ${stdout.trim().slice(0, 100)})`,
      )
      return twoPartMatch[1]
    }

    logDebug(
      `无法从输出中解析 TypeDB 版本: ${stdout.trim().slice(0, 100)}`,
    )
    return null
  }

  /**
   * 重写 moveExtractedEntries 以处理 TypeDB 的嵌套目录结构。
   *
   * TypeDB 归档解压为：typedb/server/typedb_server_bin、typedb/console/typedb_console_bin
   * 重新组织为：bin/typedb、bin/server/typedb_server_bin、bin/console/typedb_console_bin
   * 并保留 server/config.yml 供参考。
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const ext = process.platform === 'win32' ? '.exe' : ''
    const batExt = process.platform === 'win32' ? '.bat' : ''

    // 找到 typedb 目录（如 "typedb" 或 "typedb-3.8.0"）
    const typedbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'typedb' || e.name.startsWith('typedb-')),
    )

    const sourceDir = typedbDir ? join(extractDir, typedbDir.name) : extractDir

    // 创建 bin/ 目录
    const destBinDir = join(binPath, 'bin')
    await mkdir(destBinDir, { recursive: true })

    // 将启动脚本移动到 bin/
    const launcherName = `typedb${batExt}`
    const launcherPath = join(sourceDir, launcherName)
    if (existsSync(launcherPath)) {
      await moveEntry(launcherPath, join(destBinDir, launcherName))
    }

    // 将 server/ 目录移入 bin/（保留启动器所需的 bin/server/typedb_server_bin 路径）
    const destServerDir = join(destBinDir, 'server')
    await mkdir(destServerDir, { recursive: true })
    const serverBinName = `typedb_server_bin${ext}`
    const serverBinPath = join(sourceDir, 'server', serverBinName)
    if (existsSync(serverBinPath)) {
      await moveEntry(serverBinPath, join(destServerDir, serverBinName))
    }

    // 将 console/ 目录移入 bin/（保留启动器所需的 bin/console/typedb_console_bin 路径）
    const destConsoleDir = join(destBinDir, 'console')
    await mkdir(destConsoleDir, { recursive: true })
    const consoleBinName = `typedb_console_bin${ext}`
    const consoleBinPath = join(sourceDir, 'console', consoleBinName)
    if (existsSync(consoleBinPath)) {
      await moveEntry(consoleBinPath, join(destConsoleDir, consoleBinName))
    }

    // 保留 server/config.yml 作为参考配置
    const configPath = join(sourceDir, 'server', 'config.yml')
    if (existsSync(configPath)) {
      const destRefServerDir = join(binPath, 'server')
      await mkdir(destRefServerDir, { recursive: true })
      await moveEntry(configPath, join(destRefServerDir, 'config.yml'))
    }

    // 如果存在 LICENSE 则移动
    const licensePath = join(sourceDir, 'LICENSE')
    if (existsSync(licensePath)) {
      await moveEntry(licensePath, join(binPath, 'LICENSE'))
    }

    logDebug('TypeDB 二进制文件已重新组织为标准 bin/ 布局')
  }

  /**
   * 重写 verify 方法以处理 TypeDB 的启动脚本。
   * TypeDB 的主二进制文件是一个启动脚本，而非可直接执行的文件。
   * 我们改为验证实际的服务器二进制文件存在，而不是运行 --version。
   */
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === Platform.Win32 ? '.exe' : ''
    const batExt = platform === Platform.Win32 ? '.bat' : ''
    const launcherPath = join(binPath, 'bin', `typedb${batExt}`)
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)
    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )

    if (!existsSync(launcherPath)) {
      throw new Error(`TypeDB 启动器未找到: ${launcherPath}`)
    }

    if (!existsSync(serverPath)) {
      throw new Error(`TypeDB 服务器二进制文件未找到: ${serverPath}`)
    }

    if (!existsSync(consolePath)) {
      throw new Error(`TypeDB 控制台二进制文件未找到: ${consolePath}`)
    }

    return true
  }
}

export const typedbBinaryManager = new TypeDBBinaryManager()
'''

# ---------------------------------------------------------------------------
# 文件3: binary-urls.ts
# ---------------------------------------------------------------------------
binary_urls_ts = r'''/**
 * TypeDB 二进制文件 URL 生成
 *
 * 从 layerbase 注册表生成 TypeDB 二进制文件的下载 URL。
 */

import { type Platform, type Arch, Engine } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * 获取指定版本和平台的二进制文件下载 URL
 *
 * URL 格式：https://registry.layerbase.host/typedb-{version}/typedb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - TypeDB 版本（如 '3.8.0' 或 '3'）
 * @param platform - 目标平台（darwin、linux、win32）
 * @param arch - 目标架构（x64、arm64）
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = getArchiveExtension(platform)

  return buildHostdbUrl(Engine.TypeDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * 获取平台的归档文件扩展名
 */
export function getArchiveExtension(platform: Platform): 'tar.gz' | 'zip' {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
'''

# ---------------------------------------------------------------------------
# 文件4: cli-utils.ts
# ---------------------------------------------------------------------------
cli_utils_ts = r'''/**
 * TypeDB CLI 工具集
 *
 * 用于操作 TypeDB 命令行工具的辅助函数。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const TYPEDB_NOT_FOUND_ERROR =
  'TypeDB 二进制文件未找到。请运行: spindb engines download typedb <version>'

/** TypeDB 默认凭据（TypeDB 3.x 需要身份验证） */
export const TYPEDB_DEFAULT_USERNAME = 'admin'
export const TYPEDB_DEFAULT_PASSWORD = 'password'

/**
 * 获取标准的 TypeDB 控制台连接参数，包括身份验证。
 * TypeDB 3.x 要求所有控制台操作都提供 --username 和 --password。
 *
 * @param tlsDisabled - 为 true 时（本地开发默认值），追加 --tls-disabled。
 *   连接启用 TLS 的 TypeDB 服务器时传 false。
 */
export function getConsoleBaseArgs(
  port: number,
  host = '127.0.0.1',
  tlsDisabled = true,
  auth?: { username?: string; password?: string },
): string[] {
  const args = [
    '--address',
    `${host}:${port}`,
    ...(tlsDisabled ? ['--tls-disabled'] : []),
    '--username',
    auth?.username || TYPEDB_DEFAULT_USERNAME,
    '--password',
    auth?.password || TYPEDB_DEFAULT_PASSWORD,
  ]
  return args
}

/**
 * 获取 typedb 启动器二进制文件的路径
 *
 * 首先检查配置缓存，然后扫描已下载的二进制文件目录。
 * 未找到则返回 null。
 */
export async function getTypeDBPath(): Promise<string | null> {
  // 先检查配置缓存
  const cached = await configManager.getBinaryPath('typedb')
  if (cached && existsSync(cached)) {
    return cached
  }

  // 回退到文件系统扫描，使用与 getTypeDBPathForVersion 相同的逻辑
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const version of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBPathForVersion(version)
    if (found) {
      await configManager.setBinaryPath('typedb', found, 'bundled')
      return found
    }
  }

  return null
}

/**
 * 获取指定版本的 typedb 二进制文件路径
 */
export async function getTypeDBPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  // TypeDB 启动器在 Windows 上是 .bat 脚本，其他平台无扩展名
  const batExt = platform === 'win32' ? '.bat' : ''

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
  if (existsSync(typedbPath)) {
    return typedbPath
  }

  return null
}

/**
 * 获取指定版本的 typedb_console_bin 路径
 */
export async function getTypeDBConsolePath(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
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

  return null
}

/**
 * 获取必需的 typedb 二进制文件路径，未找到则抛出异常
 */
export async function requireTypeDBPath(version?: string): Promise<string> {
  // 如果提供了版本号，查找该特定版本
  if (version) {
    const path = await getTypeDBPathForVersion(version)
    if (path) {
      return path
    }
  }

  // 尝试配置缓存
  const cached = await getTypeDBPath()
  if (cached) {
    return cached
  }

  throw new Error(TYPEDB_NOT_FOUND_ERROR)
}

/**
 * 获取必需的 typedb_console_bin 路径，未找到则抛出异常
 */
export async function requireTypeDBConsolePath(
  version?: string,
): Promise<string> {
  if (version) {
    const path = await getTypeDBConsolePath(version)
    if (path) {
      return path
    }
  }

  // 尝试配置缓存
  const cached = await configManager.getBinaryPath('typedb_console_bin')
  if (cached && existsSync(cached)) {
    return cached
  }

  // 回退扫描所有已安装的版本（与 requireTypeDBPath 相同的模式）
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const ver of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBConsolePath(ver)
    if (found) {
      return found
    }
  }

  throw new Error(
    'TypeDB 控制台二进制文件未找到。请运行: spindb engines download typedb <version>',
  )
}

/**
 * 验证 TypeDB 标识符（数据库名称）
 * TypeDB 标识符遵循以下规则：
 * - 以字母或下划线开头
 * - 包含字母、数字、下划线、短横线
 * - 最多 63 个字符
 *
 * @throws 如果标识符无效则抛出 Error
 */
export function validateTypeDBIdentifier(
  identifier: string,
  type: 'database' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} 名称不能为空`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} 名称不能超过 63 个字符`)
  }

  // TypeDB 允许字母数字、下划线和短横线
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `无效的 ${type} 名称 "${identifier}"。` +
        `必须以字母或下划线开头，且仅包含字母、数字、下划线和短横线。`,
    )
  }
}
'''

# ---------------------------------------------------------------------------
# 文件5: hostdb-releases.ts
# ---------------------------------------------------------------------------
hostdb_releases_ts = r'''/**
 * TypeDB 的 hostdb 发布版本模块
 *
 * 从 hostdb 仓库获取 TypeDB 二进制文件信息，
 * 仓库地址：https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { TYPEDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { typedbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.TypeDB,
  displayName: 'TypeDB',
  versionMap: TYPEDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => typedbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
'''

# ---------------------------------------------------------------------------
# 文件6: index.ts (核心引擎实现，1296行 - 这是最大的文件)
# ---------------------------------------------------------------------------
index_ts = r'''/**
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
'''

# ---------------------------------------------------------------------------
# 文件7: restore.ts
# ---------------------------------------------------------------------------
restore_ts = r'''/**
 * TypeDB 恢复模块
 * 支持使用 typedb 控制台导入方式进行基于 TypeQL 的恢复
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import {
  requireTypeDBConsolePath,
  getConsoleBaseArgs,
  validateTypeDBIdentifier,
} from './cli-utils'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

/**
 * 指示 TypeDB 备份的 TypeQL 关键字
 */
const TYPEQL_KEYWORDS = [
  'DEFINE',
  'MATCH',
  'INSERT',
  'DELETE',
  'PUT',
  'UNDEFINE',
  'RULE',
  'TYPE',
  'ENTITY',
  'RELATION',
  'ATTRIBUTE',
  'OWNS',
  'PLAYS',
  'RELATES',
  'SUB',
  'ISA',
  'HAS',
]

/**
 * 检查文件内容是否类似 TypeQL
 * 仅读取前 8KB 以避免将大文件加载到内存中
 */
async function looksLikeTypeQL(filePath: string): Promise<boolean> {
  try {
    const HEADER_SIZE = 8192
    const buffer = Buffer.alloc(HEADER_SIZE)

    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close()
    }

    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split(/\r?\n/)

    let typeqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))
        continue

      checkedLines++

      // 检查 TypeQL 关键字
      for (const keyword of TYPEQL_KEYWORDS) {
        if (trimmed.startsWith(keyword) || trimmed.includes(` ${keyword} `)) {
          typeqlStatementsFound++
          break
        }
      }

      if (typeqlStatementsFound >= 2) {
        return true
      }
    }

    return typeqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * 检查 .typeql 备份路径是否有配套的 schema/data 配对文件
 */
function hasSchemaDataPair(filePath: string): boolean {
  return (
    filePath.endsWith('.typeql') &&
    (existsSync(filePath.replace(/\.typeql$/, '-schema.typeql')) ||
      existsSync(filePath.replace(/\.typeql$/, '-data.typeql')))
  )
}

/**
 * 从文件中检测备份格式
 * 支持：
 * - TypeQL：Schema + 数据语句
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // TypeDB 备份创建 schema/data 配对文件（-schema.typeql、-data.typeql）
  // 而非单个文件，因此也要检查这些变体
  const hasPair = hasSchemaDataPair(filePath)

  if (!existsSync(filePath) && !hasPair) {
    throw new Error(`备份文件未找到: ${filePath}`)
  }

  // 如果 schema/data 配对文件存在，则为 TypeQL 备份
  if (hasPair) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份（schema + data 配对文件）',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '发现目录 - TypeDB 恢复需要 TypeQL 文件',
      restoreCommand: 'TypeDB 恢复需要 .typeql 文件',
    }
  }

  // 先按文件扩展名检查 .typeql 文件
  if (filePath.endsWith('.typeql') || filePath.endsWith('.tql')) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  // 基于内容的检测
  if (await looksLikeTypeQL(filePath)) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份（通过内容检测）',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用包含 TypeQL 语句的 .typeql 文件',
  }
}

// TypeDB 的恢复选项
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
}

/**
 * 使用 typedb 控制台导入功能从 TypeQL 备份恢复
 *
 * TypeDB 导入需要 schema 和数据文件。
 * 我们同时检查 `-schema.typeql` 和 `-data.typeql` 变体。
 */
async function restoreTypeQLBackup(
  backupPath: string,
  containerName: string,
  port: number,
  database: string,
  version?: string,
): Promise<RestoreResult> {
  validateTypeDBIdentifier(database)
  const consolePath = await requireTypeDBConsolePath(version)

  // 通过去除可选的 -schema/-data 后缀和扩展名来推导基础名称
  const baseName = backupPath
    .replace(/\.(typeql|tql)$/, '')
    .replace(/-(schema|data)$/, '')
  const schemaPath = `${baseName}-schema.typeql`
  const dataPath = `${baseName}-data.typeql`

  const hasSchema = existsSync(schemaPath)
  const hasData = existsSync(dataPath)

  if (hasSchema || hasData) {
    // 分别导入 schema 和数据
    // 注意：不要在此处给路径加引号。TypeDB 控制台的 --command 解析器将
    // 双引号视为字面字符而非分隔符。加引号会导致所有导入失败。
    const paths = [
      ...(hasSchema ? [schemaPath] : []),
      ...(hasData ? [dataPath] : []),
    ]
    const command = `database import ${database} ${paths.join(' ')}`

    return runConsoleCommand(consolePath, containerName, port, command)
  }

  // 单文件导入 - 视为 schema
  const command = `database import ${database} ${backupPath}`
  return runConsoleCommand(consolePath, containerName, port, command)
}

/**
 * 运行 TypeDB 控制台命令并返回结果
 */
async function runConsoleCommand(
  consolePath: string,
  containerName: string,
  port: number,
  command: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<RestoreResult> {
  const savedCreds = await loadCredentials(
    containerName,
    Engine.TypeDB,
    getDefaultUsername(Engine.TypeDB),
  )

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      ...getConsoleBaseArgs(
        port,
        '127.0.0.1',
        true,
        savedCreds
          ? {
              username: savedCreds.username,
              password: savedCreds.password,
            }
          : undefined,
      ),
      '--command',
      command,
    ]

    const sanitizedArgs = args.map((a, i) =>
      args[i - 1] === '--password' ? '***' : a,
    )
    logDebug(`正在运行: typedb_console_bin ${sanitizedArgs.join(' ')}`)

    const proc = spawn(consolePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(
        new Error(
          `typedb 控制台在运行 ${Math.round(timeoutMs / 1000)}s 后超时，命令: ${command}`,
        ),
      )
    }, timeoutMs)

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({
          format: 'typeql',
          stdout: stdout || 'TypeQL 语句导入成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `typedb 控制台退出，返回码 ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`启动 typedb 控制台失败: ${error.message}`))
    })
  })
}

/**
 * 从备份恢复
 * 支持：
 * - TypeQL：通过 typedb 控制台导入
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database = 'default', version } = options

  // TypeDB 备份创建 schema/data 配对文件（-schema.typeql、-data.typeql）
  // 而非 backupPath 处的单个文件，因此也要检查这些文件
  if (!existsSync(backupPath) && !hasSchemaDataPair(backupPath)) {
    throw new Error(`备份文件未找到: ${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式: ${format.format}`)

  if (format.format === 'typeql') {
    return restoreTypeQLBackup(
      backupPath,
      containerName,
      port,
      database,
      version,
    )
  }

  throw new Error(
    `无效的备份格式: ${format.format}。请使用包含 TypeQL 语句的 .typeql 文件。`,
  )
}

/**
 * 解析 TypeDB 连接字符串
 * 格式：typedb://host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 TypeDB 连接字符串: 需要非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 TypeDB 连接字符串: "${connectionString}"。` +
        `期望格式: typedb://host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议
  if (url.protocol !== 'typedb:') {
    throw new Error(
      `无效的 TypeDB 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "typedb://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'

  let port = 1729
  if (url.port) {
    const parsed = Number(url.port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `无效的 TypeDB 连接字符串: 无效端口 '${url.port}'`,
      )
    }
    port = parsed
  }

  const database = url.pathname.replace(/^\//, '') || 'default'

  return {
    host,
    port,
    database,
  }
}
'''

# ---------------------------------------------------------------------------
# 文件8: version-maps.ts
# ---------------------------------------------------------------------------
version_maps_ts = r'''/**
 * TypeDB 版本映射
 *
 * 对 `hostdb` npm 包的轻量封装。参见 engines/sqlite/version-maps.ts
 * 了解架构原理——hostdb 是唯一的数据源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'typedb'

function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const TYPEDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '3'

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `TypeDB 版本 "${version}" 不在 hostdb 中 (可用主版本: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}), 按原样使用`,
  )
  return version
}

export function isVersionSupported(version: string): boolean {
  return Object.hasOwn(TYPEDB_VERSION_MAP, version)
}

export function getLatestPatch(majorVersion: string): string | undefined {
  return TYPEDB_VERSION_MAP[majorVersion]
}
'''

# ---------------------------------------------------------------------------
# 文件9: version-validator.ts
# ---------------------------------------------------------------------------
version_validator_ts = r'''/**
 * TypeDB 版本校验工具
 * 处理版本解析、比较和兼容性检查
 */

import { SUPPORTED_MAJOR_VERSIONS } from './version-maps'

/**
 * 将 TypeDB 版本字符串解析为各组成部分
 * 支持格式如 "3.8.0"、"3.8"、"v3.8.0"
 * 拒绝预发布后缀（如 "3.8.0-beta"）和多余分段（如 "3.8.0.1"）
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()

  // 拒绝带有预发布后缀或元数据的版本
  if (/[-+]/.test(cleaned)) return null

  const parts = cleaned.split('.')

  // 仅允许 1-3 个分段（主版本、主.次、主.次.补丁）
  if (parts.length > 3) return null

  // 拒绝非纯数字的分段（如 "3b"、"8rc1"）
  if (parts.some((p) => !/^\d+$/.test(p))) return null

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  return { major, minor, patch, raw: cleaned }
}

/**
 * 检查 TypeDB 版本是否受 SpinDB 支持
 * 最低支持版本：3.0.0（v3 是 Rust 重写版）
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return SUPPORTED_MAJOR_VERSIONS.includes(String(parsed.major))
}

/**
 * 从完整版本字符串中获取主版本号
 * 例如 "3.8.0" -> "3"
 * 如果版本字符串无法解析则返回 null。
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : null
}

/**
 * 比较两个 TypeDB 版本
 * 返回：若 a < b 则 -1，若 a == b 则 0，若 a > b 则 1，若任一版本无法解析则 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return null
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1
  }
  return 0
}

/**
 * 检查备份版本与恢复版本是否兼容
 * TypeDB 备份通常在主版本内兼容
 */
export function isVersionCompatible(
  backupVersion: string,
  restoreVersion: string,
): { compatible: boolean; warning?: string } {
  const backup = parseVersion(backupVersion)
  const restore = parseVersion(restoreVersion)

  if (!backup || !restore) {
    return {
      compatible: false,
      warning:
        '无法解析版本号，没有有效版本信息时拒绝继续操作',
    }
  }

  // 不能将较新备份恢复到较旧服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 TypeDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。备份来自更新的主版本。`,
    }
  }

  // 允许相同主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // TypeDB 禁止跨主版本恢复（主版本之间格式不兼容）
  return {
    compatible: false,
    warning: `无法将 TypeDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。不支持跨主版本恢复。请使用 TypeDB 导出/导入进行版本迁移。`,
  }
}

// 验证版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
'''

# ===========================================================================
# 写入汉化后的文件
# ===========================================================================
files = {
    "backup.ts": backup_ts,
    "binary-manager.ts": binary_manager_ts,
    "binary-urls.ts": binary_urls_ts,
    "cli-utils.ts": cli_utils_ts,
    "hostdb-releases.ts": hostdb_releases_ts,
    "index.ts": index_ts,
    "restore.ts": restore_ts,
    "version-maps.ts": version_maps_ts,
    "version-validator.ts": version_validator_ts,
}

for filename, content in files.items():
    filepath = os.path.join(TARGET_DIR, filename)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"已写入: {filepath}")

print(f"\n所有 {len(files)} 个文件汉化完成，保存在: {TARGET_DIR}")