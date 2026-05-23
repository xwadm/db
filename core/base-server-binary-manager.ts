/**
 * 服务器型数据库二进制文件管理器基类
 *
 * 为处理基于服务器的 SQL 数据库（MySQL、MariaDB）的二进制文件管理器提供共享实现。
 * 这些引擎共享类似的下载、解压和验证逻辑，但在二进制文件名和版本解析方面有所不同。
 *
 * 此类处理的核心功能：
 * - 带超时的归档文件下载
 * - Unix（tar.gz）和 Windows（zip）解压
 * - 归档文件中的嵌套目录处理
 * - 带尾随零规范化的版本验证
 * - 二进制可执行文件路径解析
 *
 * 要扩展此类，请实现定义引擎特定行为的抽象方法。
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../config/paths'
import { spawnAsync, extractWindowsArchive } from './spawn-utils'
import { isRenameFallbackError } from './fs-error-utils'
import { fetchWithRegistryFallback } from './hostdb-client'
import {
  type Engine,
  Platform,
  type Arch,
  type ProgressCallback,
  type InstalledBinary,
  isValidPlatform,
  isValidArch,
} from '../types'

/**
 * 服务器型二进制文件管理器实例的配置
 */
export type ServerBinaryManagerConfig = {
  /** 引擎枚举值（例如 Engine.MySQL） */
  engine: Engine
  /** 用于路径和 URL 的引擎名称字符串（例如 'mysql'） */
  engineName: string
  /** 用于向用户显示的名称（例如 'MySQL'） */
  displayName: string
  /** 服务器二进制文件名列表，按优先级排序（例如 ['mysqld'] 或 ['mariadbd', 'mysqld']） */
  serverBinaryNames: string[]
}

export abstract class BaseServerBinaryManager {
  protected abstract readonly config: ServerBinaryManagerConfig

  /**
   * 获取特定版本的下载 URL。
   * 必须由子类实现，以使用引擎特定的 binary-urls 模块。
   */
  protected abstract getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string

  /**
   * 将版本字符串规范化为完整版本格式。
   * 必须由子类实现，以使用引擎特定的 version-maps 模块。
   */
  protected abstract normalizeVersionFromModule(version: string): string

  /**
   * 从 CLI --version 的输出中解析版本号。
   * 必须由子类实现，因为各引擎的输出格式不同。
   */
  protected abstract parseVersionFromOutput(stdout: string): string | null

  /**
   * 获取特定版本的下载 URL（公共 API）
   */
  getDownloadUrl(version: string, platform: Platform, arch: Arch): string {
    const fullVersion = this.getFullVersion(version)
    return this.getBinaryUrlFromModule(fullVersion, platform, arch)
  }

  /**
   * 将版本转换为完整版本格式
   */
  getFullVersion(version: string): string {
    return this.normalizeVersionFromModule(version)
  }

  /**
   * 检查特定版本的二进制文件是否已安装。
   * 按顺序检查所有服务器二进制文件名，直到找到第一个。
   */
  async isInstalled(
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

    // 检查每个可能的服务器二进制文件名
    for (const serverBinary of this.config.serverBinaryNames) {
      const serverPath = join(binPath, 'bin', `${serverBinary}${ext}`)
      if (existsSync(serverPath)) {
        return true
      }
    }
    return false
  }

  /**
   * 列出此引擎所有已安装的版本
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []
    const prefix = `${this.config.engineName}-`

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue

      // 从后向前解析，以处理含短横线的版本号（例如 mysql-8.0.40-rc1-darwin-arm64）
      const rest = entry.name.slice(prefix.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && isValidPlatform(platform) && isValidArch(arch)) {
        installed.push({
          engine: this.config.engine,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  /**
   * 下载并解压二进制文件
   */
  async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-${this.config.engineName}-${fullVersion}-${platform}-${arch}`,
    )
    const archiveFile = join(
      tempDir,
      platform === Platform.Win32
        ? `${this.config.engineName}.zip`
        : `${this.config.engineName}.tar.gz`,
    )

    // 确保临时目录存在（binPath 在下载成功后创建）
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })

    let success = false
    let binPathCreated = false
    const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

    try {
      // 下载归档文件
      onProgress?.({
        stage: 'downloading',
        message: `正在下载 ${this.config.displayName} 二进制文件...`,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        DOWNLOAD_TIMEOUT_MS,
      )

      let response: Response
      try {
        response = await fetchWithRegistryFallback(url, {
          signal: controller.signal,
        })
      } catch (error) {
        const err = error as Error
        if (err.name === 'AbortError') {
          throw new Error(
            `下载在 ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} 分钟后超时。` +
              `请检查网络连接后重试。`,
          )
        }
        throw error
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `未找到 ${this.config.displayName} ${fullVersion} 的二进制文件（404）。` +
              `此版本可能已从 hostdb 中移除。` +
              `请尝试其他版本或查看 https://registry.layerbase.host`,
          )
        }
        throw new Error(
          `下载 ${this.config.displayName} 二进制文件失败：${response.status} ${response.statusText}`,
        )
      }

      if (!response.body) {
        throw new Error(
          `下载 ${this.config.displayName} 二进制文件失败：响应体为空`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      const nodeStream = Readable.fromWeb(response.body)
      await pipeline(nodeStream, fileStream)

      // 下载成功后才创建 binPath（避免在早期失败时留下空目录）
      await mkdir(binPath, { recursive: true })
      binPathCreated = true

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

      // 使二进制文件可执行（仅限 Unix）
      if (platform !== Platform.Win32) {
        const binDir = join(binPath, 'bin')
        if (existsSync(binDir)) {
          const binaries = await readdir(binDir)
          for (const binary of binaries) {
            await chmod(join(binDir, binary), 0o755)
          }
        }
      }

      // 验证安装
      onProgress?.({ stage: 'verifying', message: '正在验证安装...' })
      await this.verify(version, platform, arch)

      success = true
      return binPath
    } finally {
      // 清理临时目录
      await rm(tempDir, { recursive: true, force: true })
      // 若失败则清理 binPath，避免留下不完整的安装
      if (!success && binPathCreated) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * 从 zip 文件中解压 Windows 二进制文件
   */
  protected async extractWindowsBinaries(
    zipFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: '正在解压二进制文件...',
    })

    // 使用 PowerShell Expand-Archive 解压 ZIP
    await extractWindowsArchive(zipFile, tempDir)

    await this.moveExtractedEntries(tempDir, binPath)
  }

  /**
   * 从 tar.gz 文件中解压 Unix 二进制文件
   */
  protected async extractUnixBinaries(
    tarFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: '正在解压二进制文件...',
    })

    // 首先将 tar.gz 解压到临时目录
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })
    await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])

    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * 将解压后的条目从 extractDir 移动到 binPath，处理嵌套的引擎目录。
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === this.config.engineName ||
          e.name.startsWith(`${this.config.engineName}-`)),
    )

    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const entriesToMove = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    for (const entry of entriesToMove) {
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
   * 查找服务器二进制文件路径，按顺序检查每个可能的名称
   */
  protected findServerBinaryPath(binPath: string, ext: string): string | null {
    for (const serverBinary of this.config.serverBinaryNames) {
      const serverPath = join(binPath, 'bin', `${serverBinary}${ext}`)
      if (existsSync(serverPath)) {
        return serverPath
      }
    }
    return null
  }

  /**
   * 仅在第 4 段为 0 时去除尾随的 .0。
   * 这避免错误地修改 "8.0" 或 "10.0.0" 等版本号。
   * 例如："8.0.40.0" -> "8.0.40"，但 "8.0" 保持不变。
   */
  protected stripTrailingZero(version: string): string {
    const parts = version.split('.')
    if (parts.length === 4 && parts[3] === '0') {
      return parts.slice(0, 3).join('.')
    }
    return version
  }

  /**
   * 验证二进制文件是否能正常工作
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

    const serverPath = this.findServerBinaryPath(binPath, ext)

    if (!serverPath) {
      throw new Error(
        `在 ${binPath}/bin/ 中未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    try {
      const { stdout } = await spawnAsync(serverPath, ['--version'])
      const reportedVersion = this.parseVersionFromOutput(stdout)
      if (!reportedVersion) {
        throw new Error(`无法从输出中解析版本号：${stdout.trim()}`)
      }
      const expectedNormalized = this.stripTrailingZero(fullVersion)
      const reportedNormalized = this.stripTrailingZero(reportedVersion)

      // 检查版本是否匹配
      if (reportedNormalized === expectedNormalized) {
        return true
      }

      // 同时接受主版本号匹配的情况（例如期望 "8.0"，实际得到 "8.0.40"）
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
      if (expectedMajor === reportedMajor) {
        return true
      }

      throw new Error(
        `版本不匹配：期望 ${version}，实际得到 ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: number }
      // 在错误消息中包含 stderr 和退出码，以便于调试
      const details = [err.message]
      if (err.stderr) details.push(`stderr: ${err.stderr.trim()}`)
      if (err.code !== undefined) details.push(`退出码: ${err.code}`)
      throw new Error(
        `验证 ${this.config.displayName} 二进制文件失败：${details.join(', ')}`,
      )
    }
  }

  /**
   * 获取特定二进制文件的路径
   */
  getBinaryExecutable(
    version: string,
    platform: Platform,
    arch: Arch,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''
    return join(binPath, 'bin', `${binary}${ext}`)
  }

  /**
   * 确保二进制文件可用，必要时进行下载
   */
  async ensureInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)

    if (await this.isInstalled(version, platform, arch)) {
      onProgress?.({
        stage: 'cached',
        message: `正在使用缓存的 ${this.config.displayName} 二进制文件`,
      })
      return paths.getBinaryPath({
        engine: this.config.engineName,
        version: fullVersion,
        platform,
        arch,
      })
    }

    return await this.download(version, platform, arch, onProgress)
  }

  /**
   * 删除特定版本的已安装二进制文件
   */
  async delete(version: string, platform: Platform, arch: Arch): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}
