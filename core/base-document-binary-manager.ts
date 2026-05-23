/**
 * 文档型数据库二进制文件管理器基类
 *
 * 为处理文档型数据库（MongoDB、FerretDB）的二进制文件管理器提供共享实现。
 * 这些引擎共享类似的下载、解压和验证逻辑，但在二进制文件名和版本解析方面有所不同。
 *
 * 此类处理的核心功能：
 * - 带超时的归档文件下载
 * - Unix（tar.gz）和 Windows（zip）解压
 * - 解压过程中 macOS 扩展属性文件的处理
 * - 归档文件中的嵌套目录处理
 * - 主版本号.次版本号匹配的版本验证
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
import { logDebug } from './error-handler'
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
 * 文档型二进制文件管理器实例的配置
 */
export type DocumentBinaryManagerConfig = {
  /** 引擎枚举值（例如 Engine.MongoDB） */
  engine: Engine
  /** 用于路径和 URL 的引擎名称字符串（例如 'mongodb'） */
  engineName: string
  /** 用于向用户显示的名称（例如 'MongoDB'） */
  displayName: string
  /** 服务器二进制文件名（不含扩展名）（例如 'mongod'） */
  serverBinary: string
}

export abstract class BaseDocumentBinaryManager {
  protected abstract readonly config: DocumentBinaryManagerConfig

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
   * 从服务器 --version 的输出中解析版本号。
   * 必须由子类实现，因为各引擎的输出格式不同。
   * 应返回版本字符串（例如 "7.0.28"），解析失败时返回 null。
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
   * 将版本转换为完整版本格式（例如 "7.0" -> "7.0.28"）
   */
  getFullVersion(version: string): string {
    return this.normalizeVersionFromModule(version)
  }

  /**
   * 检查特定版本的二进制文件是否已安装
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
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)
    return existsSync(serverPath)
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

      // 从后向前分割，以处理含短横线的版本号（例如 8.0.0-rc1）
      // 格式：{引擎}-{版本}-{平台}-{架构}
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
    // Windows 使用 .zip，Unix 使用 .tar.gz
    const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `${this.config.engineName}.${ext}`)

    // 确保目录存在
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
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

      const timeoutErrorMessage =
        `下载在 ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} 分钟后超时。` +
        `请检查网络连接后重试。`

      let response: Response
      let fileStream: ReturnType<typeof createWriteStream> | null = null
      try {
        response = await fetchWithRegistryFallback(url, {
          signal: controller.signal,
        })

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
            `下载失败：响应无 body（状态码 ${response.status}）`,
          )
        }

        fileStream = createWriteStream(archiveFile)
        // 将 WHATWG ReadableStream 转换为 Node.js Readable（需要 Node.js 18+）
        const nodeStream = Readable.fromWeb(response.body)
        await pipeline(nodeStream, fileStream)
      } catch (error) {
        const err = error as Error
        if (err.name === 'AbortError') {
          throw new Error(timeoutErrorMessage)
        }
        throw error
      } finally {
        clearTimeout(timeoutId)
        // 确保在出错时销毁文件流
        if (fileStream && !fileStream.writableEnded) {
          fileStream.destroy()
        }
      }

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
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * 从 tar.gz 文件中解压 Unix 二进制文件。
   * 包含对 macOS 扩展属性文件（._* 文件）的恢复处理，
   * 这些文件在某些归档中可能被截断。
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

    // 解压 tar.gz —— 某些归档可能因 macOS 扩展属性文件（._* 文件）
    // 导致 tar 以非零退出码退出，即使二进制文件已正确解压。
    // 通过检查文件是否实际解压来验证解压是否成功。
    try {
      await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])
    } catch (error) {
      const err = error as Error & { code?: string | number }

      // 检查尽管有错误，解压是否实际成功
      // （截断的 macOS 扩展属性文件的常见情况）
      const entries = await readdir(extractDir)
      if (entries.length === 0) {
        // 没有文件被解压 —— 这是真正的失败
        throw new Error(
          `解压失败：${err.message}${err.code ? `（退出码：${err.code}）` : ''}`,
        )
      }

      // 尽管有错误，文件已成功解压 —— 记录日志并继续
      // 此处理 tar 关于截断的 ._* 文件、元数据文件权限问题等的警告，
      // 这些不影响实际的二进制文件
      logDebug(
        `${this.config.displayName} 解压从 tar 错误中恢复`,
        {
          tarFile,
          entriesExtracted: entries.length,
          errorMessage: err.message,
          errorCode: err.code,
        },
      )
    }

    await this.moveExtractedEntries(extractDir, binPath)
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
   * 验证二进制文件是否能正常工作。
   * 对文档型数据库使用主版本号.次版本号匹配。
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
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `在 ${binPath}/bin/ 中未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    try {
      // 使用 spawnAsync 避免命令注入（serverPath 可能包含特殊字符）
      const { stdout } = await spawnAsync(serverPath, ['--version'])
      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`无法从输出中解析版本号：${stdout.trim()}`)
      }

      // 检查主版本号是否匹配（同时处理 "8" 和 "8.0" 输入）
      const expectedMajor = fullVersion.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (expectedMajor === reportedMajor) {
        return true
      }

      // 检查完整版本是否匹配
      if (reportedVersion === fullVersion) {
        return true
      }

      throw new Error(
        `版本不匹配：期望 ${version}，实际得到 ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error
      throw new Error(
        `验证 ${this.config.displayName} 二进制文件失败：${err.message}`,
      )
    }
  }

  /**
   * 获取特定二进制文件（如 mongod、mongosh）的路径
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
