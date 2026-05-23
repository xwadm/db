/**
 * FerretDB 组合二进制文件管理器
 *
 * 负责下载和管理 FerretDB 二进制文件：
 *
 * v2（默认）：需要两个二进制文件：
 *   1. ferretdb - MongoDB 兼容的 Go 代理
 *   2. postgresql-documentdb - 带有 DocumentDB 扩展的 PostgreSQL 17
 *
 * v1：两个二进制文件，但后端是共享的：
 *   1. ferretdb - MongoDB 兼容的 Go 代理
 *   2. 普通 PostgreSQL - 由 postgresqlBinaryManager 管理（与独立 PG 容器共享）
 *
 * 这是一个组合管理器，协调安装两个二进制文件，
 * 这两个文件都是 FerretDB 正常运行所必需的。
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../../config/paths'
import { spawnAsync, extractWindowsArchive } from '../../core/spawn-utils'
import { isRenameFallbackError } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { fetchWithRegistryFallback } from '../../core/hostdb-client'
import {
  Engine,
  Platform,
  type Arch,
  type ProgressCallback,
  type InstalledBinary,
  isValidPlatform,
  isValidArch,
} from '../../types'
import {
  normalizeVersion,
  normalizeDocumentDBVersion,
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  isV1,
} from './version-maps'
import {
  isPlatformSupported,
  getFerretDBBinaryUrl,
  getDocumentDBBinaryUrl,
} from './binary-urls'
import { postgresqlBinaryManager } from '../postgresql/binary-manager'

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

/**
 * 确保 FerretDB 两个二进制文件都已安装的结果
 */
export type FerretDBBinaryPaths = {
  ferretdbPath: string // ferretdb 二进制文件目录路径
  backendPath: string // 后端二进制文件目录路径（v2 为 postgresql-documentdb，v1 为 postgresql）
}

/**
 * FerretDB 组合二进制文件管理器
 *
 * 管理 FerretDB 所需的两个二进制文件的安装。
 */
class FerretDBCompositeBinaryManager {
  /**
   * 检查当前平台是否支持 FerretDB
   * @param version - 可选版本，用于检查平台支持（v1 支持 Windows，v2 不支持）
   */
  isPlatformSupported(
    platform: Platform,
    arch: Arch,
    version?: string,
  ): boolean {
    return isPlatformSupported(platform, arch, version)
  }

  /**
   * 获取 FerretDB 版本的完整版本字符串
   */
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  /**
   * 获取 postgresql-documentdb 版本的完整版本字符串
   */
  getFullDocumentDBVersion(version: string): string {
    return normalizeDocumentDBVersion(version)
  }

  /**
   * 检查指定版本的 FerretDB 二进制文件是否已安装
   */
  async isInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)

    // 检查 FerretDB 代理
    const ferretdbPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    if (!existsSync(ferretdbBinary)) {
      return false
    }

    // 检查后端
    if (isV1(version)) {
      // v1：通过 postgresqlBinaryManager 检查普通 PostgreSQL
      return postgresqlBinaryManager.isInstalled(
        DEFAULT_V1_POSTGRESQL_VERSION,
        platform,
        arch,
      )
    }

    // v2：检查 postgresql-documentdb
    const fullBackendVersion = this.getFullDocumentDBVersion(backendVersion)
    const documentdbPath = this.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )
    const pgCtlExt = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${pgCtlExt}`)
    if (!existsSync(pgCtl)) {
      return false
    }

    return true
  }

  /**
   * 获取 FerretDB 二进制文件的安装路径
   * @param version - 完整的规范化版本（例如 "2.7.0"，而非 "2" 或 "2.7"）
   * @param platform - 操作系统
   * @param arch - 架构
   */
  getFerretDBBinaryPath(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return join(paths.bin, `ferretdb-${version}-${platform}-${arch}`)
  }

  /**
   * 获取 postgresql-documentdb 二进制文件的安装路径
   * @param version - 完整的规范化版本（例如 "17-0.107.0"，而非 "17"）
   * @param platform - 操作系统
   * @param arch - 架构
   */
  getDocumentDBBinaryPath(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return join(
      paths.bin,
      `postgresql-documentdb-${version}-${platform}-${arch}`,
    )
  }

  /**
   * 获取运行 postgresql-documentdb 二进制文件所需的环境变量
   *
   * 在 Linux 上，打包的二进制文件需要设置 LD_LIBRARY_PATH 来查找 libpq.so
   * 和 lib/ 目录中的其他共享库。
   *
   * 在 macOS 上，二进制文件使用 @loader_path，不需要环境变量。
   * 在 Windows 上，DLL 通过 PATH 或相同目录查找。
   *
   * @param version - 完整的规范化版本（例如 "17-0.107.0"，而非 "17"）
   * @param platform - 操作系统
   * @param arch - 架构
   */
  getDocumentDBSpawnEnv(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Record<string, string> | undefined {
    // 仅 Linux 需要 LD_LIBRARY_PATH
    if (platform !== Platform.Linux) {
      return undefined
    }

    const documentdbPath = this.getDocumentDBBinaryPath(version, platform, arch)
    const libPath = join(documentdbPath, 'lib')

    // 将我们的 lib 路径添加到已有的 LD_LIBRARY_PATH 前面
    const existingLdPath = process.env['LD_LIBRARY_PATH'] || ''
    const newLdPath = existingLdPath ? `${libPath}:${existingLdPath}` : libPath

    return {
      LD_LIBRARY_PATH: newLdPath,
    }
  }

  /**
   * 获取 FerretDB 版本的后端二进制文件目录路径。
   * v1：返回普通 PostgreSQL 二进制文件路径
   * v2：返回 postgresql-documentdb 二进制文件路径
   *
   * @param ferretdbVersion - FerretDB 版本（例如 "1.24.2" 或 "2.7.0"）
   * @param backendVersion - 后端版本（v1 为 PostgreSQL 版本，v2 为 DocumentDB 版本）
   * @param platform - 操作系统
   * @param arch - 架构
   */
  getBackendBinaryPath(
    ferretdbVersion: string,
    backendVersion: string,
    platform: Platform,
    arch: Arch,
  ): string {
    if (isV1(ferretdbVersion)) {
      const pgFullVersion = postgresqlBinaryManager.getFullVersion(
        backendVersion || DEFAULT_V1_POSTGRESQL_VERSION,
      )
      return paths.getBinaryPath({
        engine: 'postgresql',
        version: pgFullVersion,
        platform,
        arch,
      })
    }

    const fullBackendVersion = this.getFullDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )
    return this.getDocumentDBBinaryPath(fullBackendVersion, platform, arch)
  }

  /**
   * 获取运行后端二进制文件所需的环境变量。
   * v1：委托给 PostgreSQL 的标准环境变量（通常不需要）
   * v2：委托给 getDocumentDBSpawnEnv
   *
   * @param ferretdbVersion - FerretDB 版本
   * @param backendVersion - 后端版本
   * @param platform - 操作系统
   * @param arch - 架构
   */
  getBackendSpawnEnv(
    ferretdbVersion: string,
    backendVersion: string,
    platform: Platform,
    arch: Arch,
  ): Record<string, string> | undefined {
    if (isV1(ferretdbVersion)) {
      // 普通 PostgreSQL 在大多数平台上不需要特殊环境变量
      // Linux 可能需要 LD_LIBRARY_PATH
      if (platform !== Platform.Linux) {
        return undefined
      }
      const pgPath = this.getBackendBinaryPath(
        ferretdbVersion,
        backendVersion,
        platform,
        arch,
      )
      const libPath = join(pgPath, 'lib')
      const existingLdPath = process.env['LD_LIBRARY_PATH'] || ''
      const newLdPath = existingLdPath
        ? `${libPath}:${existingLdPath}`
        : libPath
      return { LD_LIBRARY_PATH: newLdPath }
    }

    const fullBackendVersion = this.getFullDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )
    return this.getDocumentDBSpawnEnv(fullBackendVersion, platform, arch)
  }

  /**
   * 列出所有已安装的 FerretDB 版本
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []
    const prefix = 'ferretdb-'

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue

      // 从末尾分割以处理包含连字符的版本号
      // 格式：ferretdb-{版本}-{平台}-{架构}
      const rest = entry.name.slice(prefix.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && isValidPlatform(platform) && isValidArch(arch)) {
        installed.push({
          engine: Engine.FerretDB,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  /**
   * 确保 FerretDB 两个二进制文件都已安装
   *
   * @param version - FerretDB 版本
   * @param platform - 操作系统
   * @param arch - 架构
   * @param onProgress - 进度回调
   * @param backendVersion - 后端版本（v2 为 postgresql-documentdb，v1 为 PostgreSQL 主版本号）
   * @returns 两个二进制文件目录的路径
   */
  async ensureInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion?: string,
  ): Promise<FerretDBBinaryPaths> {
    const fullVersion = this.getFullVersion(version)
    const v1 = isV1(version)
    const effectiveBackendVersion =
      backendVersion ||
      (v1 ? DEFAULT_V1_POSTGRESQL_VERSION : DEFAULT_DOCUMENTDB_VERSION)

    // 检查是否已安装
    if (
      await this.isInstalled(version, platform, arch, effectiveBackendVersion)
    ) {
      onProgress?.({
        stage: 'cached',
        message: '使用已缓存的 FerretDB 二进制文件',
      })
      return {
        ferretdbPath: this.getFerretDBBinaryPath(fullVersion, platform, arch),
        backendPath: this.getBackendBinaryPath(
          fullVersion,
          effectiveBackendVersion,
          platform,
          arch,
        ),
      }
    }

    if (v1) {
      return this.ensureInstalledV1(
        version,
        platform,
        arch,
        onProgress,
        effectiveBackendVersion,
      )
    }

    return this.ensureInstalledV2(
      version,
      platform,
      arch,
      onProgress,
      effectiveBackendVersion,
    )
  }

  /**
   * 确保 v1 FerretDB 二进制文件已安装（代理 + 普通 PostgreSQL）
   */
  private async ensureInstalledV1(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion: string = DEFAULT_V1_POSTGRESQL_VERSION,
  ): Promise<FerretDBBinaryPaths> {
    // 下载 FerretDB v1 代理
    const ferretdbPath = await this.downloadFerretDB(
      version,
      platform,
      arch,
      onProgress,
    )

    // 通过 postgresqlBinaryManager 确保普通 PostgreSQL 已安装
    onProgress?.({
      stage: 'downloading',
      message: '正在确保 PostgreSQL 后端可用...',
    })
    const backendPath = await postgresqlBinaryManager.ensureInstalled(
      backendVersion,
      platform,
      arch,
      onProgress,
    )

    return { ferretdbPath, backendPath }
  }

  /**
   * 确保 v2 FerretDB 二进制文件已安装（代理 + postgresql-documentdb）
   */
  private async ensureInstalledV2(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<FerretDBBinaryPaths> {
    const fullVersion = this.getFullVersion(version)

    // 检查 FerretDB 是否已安装（DocumentDB 可能缺失）
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinaryPath = this.getFerretDBBinaryPath(
      fullVersion,
      platform,
      arch,
    )
    const ferretdbBinary = join(ferretdbBinaryPath, 'bin', `ferretdb${ext}`)
    const ferretdbAlreadyInstalled = existsSync(ferretdbBinary)

    // 下载两个二进制文件 —— 通过在 DocumentDB 失败时清理 FerretDB 来确保原子性
    // （仅在 FerretDB 是本次调用中新下载的情况下）
    const ferretdbPath = await this.downloadFerretDB(
      version,
      platform,
      arch,
      onProgress,
    )

    let backendPath: string
    try {
      backendPath = await this.downloadDocumentDB(
        backendVersion,
        platform,
        arch,
        onProgress,
      )
    } catch (error) {
      // 仅在 FerretDB 是新下载的（非预安装）时才清理
      if (!ferretdbAlreadyInstalled) {
        onProgress?.({
          stage: 'error',
          message:
            'postgresql-documentdb 下载失败，正在清理 FerretDB...',
        })
        await rm(ferretdbPath, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }

    return { ferretdbPath, backendPath }
  }

  /**
   * 下载 FerretDB 代理二进制文件
   */
  private async downloadFerretDB(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const binPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)

    // 检查 FerretDB 是否已安装
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(binPath, 'bin', `ferretdb${ext}`)
    if (existsSync(ferretdbBinary)) {
      onProgress?.({
        stage: 'cached',
        message: 'FerretDB 代理已安装',
      })
      return binPath
    }

    const url = getFerretDBBinaryUrl(version, platform, arch)
    const tempDir = join(
      paths.bin,
      `temp-ferretdb-${fullVersion}-${platform}-${arch}`,
    )
    const archiveExt = platform === Platform.Win32 ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `ferretdb.${archiveExt}`)

    // 清理任何不完整的安装
    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }

    // 确保目录存在
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      onProgress?.({
        stage: 'downloading',
        message: '正在下载 FerretDB 代理...',
      })

      await this.downloadArchive(url, archiveFile, 'FerretDB')

      if (platform === Platform.Win32) {
        await this.extractWindowsBinaries(
          archiveFile,
          binPath,
          tempDir,
          onProgress,
        )
      } else {
        await this.extractUnixBinaries(
          archiveFile,
          binPath,
          tempDir,
          onProgress,
        )
      }

      // 设置二进制文件为可执行（仅 Unix）
      if (platform !== Platform.Win32) {
        const binDir = join(binPath, 'bin')
        if (existsSync(binDir)) {
          const binaries = await readdir(binDir)
          for (const binary of binaries) {
            await chmod(join(binDir, binary), 0o755)
          }
        }
      }

      // 在 macOS 上，重新签名二进制文件以修复代码签名问题
      if (platform === Platform.Darwin) {
        onProgress?.({
          stage: 'signing',
          message: '正在为 macOS 重新签名 FerretDB 二进制文件...',
        })
        await this.resignMacOSBinaries(binPath)
      }

      // 验证安装
      onProgress?.({ stage: 'verifying', message: '正在验证 FerretDB...' })
      await this.verifyFerretDB(fullVersion, platform, arch)

      success = true
      return binPath
    } finally {
      // 清理临时目录
      await rm(tempDir, { recursive: true, force: true })
      // 失败时清理 binPath
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * 下载 postgresql-documentdb 后端二进制文件
   */
  private async downloadDocumentDB(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullDocumentDBVersion(version)
    const binPath = this.getDocumentDBBinaryPath(fullVersion, platform, arch)

    // 检查 postgresql-documentdb 是否已安装
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(binPath, 'bin', `pg_ctl${ext}`)
    if (existsSync(pgCtl)) {
      onProgress?.({
        stage: 'cached',
        message: 'postgresql-documentdb 已安装',
      })
      return binPath
    }

    const url = getDocumentDBBinaryUrl(version, platform, arch)
    const tempDir = join(
      paths.bin,
      `temp-postgresql-documentdb-${fullVersion}-${platform}-${arch}`,
    )
    const archiveFile = join(tempDir, 'postgresql-documentdb.tar.gz')

    // 清理任何不完整的安装
    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }

    // 确保目录存在
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      onProgress?.({
        stage: 'downloading',
        message: '正在下载 postgresql-documentdb 后端...',
      })

      await this.downloadArchive(url, archiveFile, 'postgresql-documentdb')

      await this.extractUnixBinaries(archiveFile, binPath, tempDir, onProgress)

      // 设置二进制文件为可执行
      const binaryDir = join(binPath, 'bin')
      if (existsSync(binaryDir)) {
        const binaries = await readdir(binaryDir)
        for (const binary of binaries) {
          await chmod(join(binaryDir, binary), 0o755)
        }
      }

      // 在 macOS 上，重新签名二进制文件和库以修复代码签名问题
      // （由于隔离/Gatekeeper，下载后签名会失效）
      if (platform === Platform.Darwin) {
        onProgress?.({
          stage: 'signing',
          message: '正在为 macOS 重新签名二进制文件...',
        })
        await this.resignMacOSBinaries(binPath)
      }

      // 验证安装
      onProgress?.({
        stage: 'verifying',
        message: '正在验证 postgresql-documentdb...',
      })
      await this.verifyDocumentDB(fullVersion, platform, arch)

      success = true
      return binPath
    } finally {
      // 清理临时目录
      await rm(tempDir, { recursive: true, force: true })
      // 失败时清理 binPath
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * 下载压缩包文件
   */
  private async downloadArchive(
    url: string,
    archiveFile: string,
    displayName: string,
  ): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    try {
      const response = await fetchWithRegistryFallback(url, {
        signal: controller.signal,
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `${displayName} 二进制文件未找到 (404)。` +
              '此版本可能已从 hostdb 中移除。' +
              '请尝试其他版本或查看 https://registry.layerbase.host',
          )
        }
        throw new Error(
          `下载 ${displayName} 二进制文件失败: ${response.status} ${response.statusText}`,
        )
      }

      if (!response.body) {
        throw new Error(
          `下载失败：响应没有 body（状态码 ${response.status}）`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      try {
        const nodeStream = Readable.fromWeb(response.body)
        await pipeline(nodeStream, fileStream)
      } catch (pipelineError) {
        fileStream.destroy()
        throw pipelineError
      }
    } catch (error) {
      const err = error as Error
      if (err.name === 'AbortError') {
        throw new Error(
          `下载超时，已等待 ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} 分钟。` +
            '请检查网络连接后重试。',
        )
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 从 tar.gz 文件中提取 Unix 二进制文件
   */
  private async extractUnixBinaries(
    tarFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: '正在提取二进制文件...',
    })

    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    try {
      await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])
    } catch (error) {
      const err = error as Error & { code?: string | number }

      // 检查提取是否实际上已成功（尽管有错误）
      const entries = await readdir(extractDir)
      if (entries.length === 0) {
        throw new Error(
          `提取失败: ${err.message}${err.code ? ` (错误码: ${err.code})` : ''}`,
        )
      }

      logDebug('FerretDB 提取从 tar 错误中恢复', {
        tarFile,
        entriesExtracted: entries.length,
        errorMessage: err.message,
        errorCode: err.code,
      })
    }

    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * 从 ZIP 文件中提取 Windows 二进制文件
   *
   * FerretDB v1 支持 Windows。v2 不支持（postgresql-documentdb 启动问题）。
   */
  private async extractWindowsBinaries(
    zipFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: '正在提取二进制文件...',
    })

    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    await extractWindowsArchive(zipFile, extractDir)
    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * 将提取的文件从 extractDir 移动到 binPath
   */
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // 查找引擎目录（ferretdb-* 或 postgresql-documentdb-*）
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'ferretdb' ||
          e.name.startsWith('ferretdb-') ||
          e.name === 'postgresql-documentdb' ||
          e.name.startsWith('postgresql-documentdb-')),
    )

    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    for (const entry of sourceEntries) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(binPath, entry.name)
      try {
        await rename(sourcePath, destPath)
      } catch (error) {
        if (isRenameFallbackError(error)) {
          await cp(sourcePath, destPath, { recursive: true })
          await rm(sourcePath, { recursive: true, force: true })
        } else {
          throw error
        }
      }
    }
  }

  /**
   * 验证 FerretDB 二进制文件安装
   */
  private async verifyFerretDB(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<void> {
    const binPath = this.getFerretDBBinaryPath(version, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(binPath, 'bin', `ferretdb${ext}`)

    if (!existsSync(ferretdbBinary)) {
      throw new Error(`FerretDB 二进制文件未找到于 ${binPath}/bin/`)
    }

    // FerretDB v1 hostdb 构建在运行 --version 时会 panic，
    // 因为构建时缺少 version.txt。对于 v1，只需验证二进制文件存在（已在上面检查）。
    if (isV1(version)) {
      return
    }

    try {
      const { stdout } = await spawnAsync(ferretdbBinary, ['--version'])
      const match = stdout.match(
        /(?:ferretdb\s+)?(?:version\s+)?v?(\d+\.\d+\.\d+)/,
      )
      if (!match) {
        throw new Error(
          `无法从以下输出解析 FerretDB 版本: ${stdout.trim()}`,
        )
      }

      const reportedVersion = match[1]
      const expectedMajor = version.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]

      if (expectedMajor !== reportedMajor) {
        throw new Error(
          `版本不匹配: 期望 ${version}，实际 ${reportedVersion}`,
        )
      }
    } catch (error) {
      const err = error as Error
      throw new Error(`验证 FerretDB 二进制文件失败: ${err.message}`)
    }
  }

  /**
   * 验证 postgresql-documentdb 二进制文件安装
   * 同时测试 pg_ctl 和 initdb，因为 initdb 在容器创建期间使用
   */
  private async verifyDocumentDB(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<void> {
    const binPath = this.getDocumentDBBinaryPath(version, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(binPath, 'bin', `pg_ctl${ext}`)
    const initdb = join(binPath, 'bin', `initdb${ext}`)

    if (!existsSync(pgCtl)) {
      throw new Error(
        `postgresql-documentdb 二进制文件未找到于 ${binPath}/bin/`,
      )
    }

    if (!existsSync(initdb)) {
      throw new Error(
        `initdb 未找到于 ${binPath}/bin/ —— 容器初始化所必需`,
      )
    }

    // 获取 Linux 的 spawn 环境变量（LD_LIBRARY_PATH）
    const spawnEnv = this.getDocumentDBSpawnEnv(version, platform, arch)

    // 验证 pg_ctl 可用
    try {
      const { stdout } = await spawnAsync(pgCtl, ['--version'], {
        env: spawnEnv,
      })
      // 预期输出："pg_ctl (PostgreSQL) 17.x.x"
      const match = stdout.match(/PostgreSQL[)\s]+(\d+)/)
      if (!match) {
        throw new Error(
          `无法从以下输出解析 PostgreSQL 版本: ${stdout.trim()}`,
        )
      }

      // version 格式如 "17-0.107.0"，提取 PostgreSQL 主版本号
      const expectedPgMajor = version.split('-')[0]
      const reportedPgMajor = match[1]

      if (expectedPgMajor !== reportedPgMajor) {
        throw new Error(
          `PostgreSQL 版本不匹配: 期望 ${expectedPgMajor}，实际 ${reportedPgMajor}`,
        )
      }
    } catch (error) {
      const err = error as Error & { code?: string | number | null }

      // 检查库加载问题（在 macOS/Linux 上使用 hostdb 二进制文件时常见）
      if (
        !err.code ||
        err.code === 'ENOENT' ||
        err.message.includes('dyld') ||
        err.message.includes('GLIBC')
      ) {
        throw new Error(
          `postgresql-documentdb pg_ctl 执行失败。这可能是由于缺少或不兼容的库导致的。\n` +
            `hostdb 二进制文件可能需要使用正确的 rpath 设置重新构建。\n` +
            `参见: https://github.com/robertjbass/hostdb/issues\n` +
            `原始错误: ${err.message || '进程被终止（库加载失败）'}`,
        )
      }

      throw new Error(
        `验证 postgresql-documentdb pg_ctl 失败: ${err.message}`,
      )
    }

    // 验证 initdb 可用（容器创建的关键步骤）
    try {
      const { stdout } = await spawnAsync(initdb, ['--version'], {
        env: spawnEnv,
      })
      // 预期输出："initdb (PostgreSQL) 17.x.x"
      const match = stdout.match(/PostgreSQL[)\s]+(\d+)/)
      if (!match) {
        throw new Error(`无法从以下输出解析 initdb 版本: ${stdout.trim()}`)
      }
      logDebug(`initdb 已验证: ${stdout.trim()}`)
    } catch (error) {
      const err = error as Error & { code?: string | number | null }

      // 检查库加载问题
      if (
        !err.code ||
        err.code === 'ENOENT' ||
        err.message.includes('dyld') ||
        err.message.includes('GLIBC')
      ) {
        throw new Error(
          `postgresql-documentdb initdb 执行失败。这可能是由于缺少或不兼容的库导致的。\n` +
            `initdb 是 FerretDB 容器初始化所必需的。\n` +
            `hostdb 二进制文件可能需要使用正确的 rpath 设置重新构建。\n` +
            `参见: https://github.com/robertjbass/hostdb/issues\n` +
            `原始错误: ${err.message || '进程被终止（库加载失败）'}`,
        )
      }

      throw new Error(
        `验证 postgresql-documentdb initdb 失败: ${err.message}`,
      )
    }
  }

  /**
   * 删除指定版本的已安装二进制文件
   *
   * v1：仅删除 FerretDB 代理。普通 PostgreSQL 二进制文件与独立 PostgreSQL 容器共享，
   * 不应被删除。
   *
   * v2：同时删除 FerretDB 代理和 postgresql-documentdb 后端。
   */
  async delete(
    version: string,
    platform: Platform,
    arch: Arch,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<void> {
    const fullVersion = this.getFullVersion(version)

    const ferretdbPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)
    if (existsSync(ferretdbPath)) {
      await rm(ferretdbPath, { recursive: true, force: true })
    }

    // v1：不删除共享的 PostgreSQL 二进制文件（cascadeDelete: false）
    if (isV1(version)) {
      logDebug(
        '跳过 FerretDB v1 的 PostgreSQL 后端删除（与独立 PG 容器共享）',
      )
      return
    }

    // v2：删除 postgresql-documentdb 后端
    const fullBackendVersion = this.getFullDocumentDBVersion(backendVersion)
    const documentdbPath = this.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )
    if (existsSync(documentdbPath)) {
      await rm(documentdbPath, { recursive: true, force: true })
    }
  }

  /**
   * 使用临时签名重新签名 macOS 二进制文件
   *
   * 下载的二进制文件可能因 Gatekeeper 隔离而具有无效签名。
   * 使用临时签名 (-s -) 重新签名可以让它们正常运行。
   */
  private async resignMacOSBinaries(binPath: string): Promise<void> {
    // 先签名所有 dylib（二进制文件依赖它们）
    const libDir = join(binPath, 'lib')
    if (existsSync(libDir)) {
      const libs = await readdir(libDir)
      for (const lib of libs) {
        if (lib.endsWith('.dylib')) {
          const libPath = join(libDir, lib)
          try {
            await spawnAsync('codesign', [
              '--force',
              '--deep',
              '-s',
              '-',
              libPath,
            ])
          } catch {
            // 忽略单个库的签名错误
            logDebug(`${lib} 签名失败，继续...`)
          }
        }
      }

      // 如果存在 postgresql/ 子目录，也签名其中的库
      const pgLibDir = join(libDir, 'postgresql')
      if (existsSync(pgLibDir)) {
        const pgLibs = await readdir(pgLibDir)
        for (const lib of pgLibs) {
          if (lib.endsWith('.dylib')) {
            const libPath = join(pgLibDir, lib)
            try {
              await spawnAsync('codesign', [
                '--force',
                '--deep',
                '-s',
                '-',
                libPath,
              ])
            } catch {
              logDebug(`${lib} 签名失败，继续...`)
            }
          }
        }
      }
    }

    // 签名所有二进制文件
    const binDir = join(binPath, 'bin')
    if (existsSync(binDir)) {
      const binaries = await readdir(binDir)
      for (const binary of binaries) {
        const binaryPath = join(binDir, binary)
        try {
          await spawnAsync('codesign', [
            '--force',
            '--deep',
            '-s',
            '-',
            binaryPath,
          ])
        } catch {
          // 忽略单个二进制文件的签名错误
          logDebug(`${binary} 签名失败，继续...`)
        }
      }
    }
  }
}

export const ferretdbBinaryManager = new FerretDBCompositeBinaryManager()
