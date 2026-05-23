/**
 * 嵌入式数据库二进制文件管理器基类
 *
 * 为处理嵌入式数据库（SQLite、DuckDB）的二进制文件管理器提供共享实现，
 * 这些引擎从 hostdb 下载 CLI 工具。与基于服务器的数据库不同，
 * 它们没有服务器二进制文件 —— 只有 CLI 工具。
 *
 * 与 BaseBinaryManager 的主要区别：
 * - 处理扁平归档文件（可执行文件在根目录，不在 bin/ 中）
 * - 通过显式名称列表识别可执行文件
 * - 没有服务器二进制文件的概念（仅 CLI 工具）
 *
 * 要扩展此类，请实现定义引擎特定行为的抽象方法和属性
 * （引擎名称、二进制文件名、版本解析等）。
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../config/paths'
import { spawnAsync } from './spawn-utils'
import { moveEntry } from './fs-error-utils'
import { compareVersions } from './version-utils'
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
 * 嵌入式二进制文件管理器实例的配置
 */
export type EmbeddedBinaryManagerConfig = {
  /** 引擎枚举值（例如 Engine.SQLite） */
  engine: Engine
  /** 用于路径和 URL 的引擎名称字符串（例如 'sqlite'） */
  engineName: string
  /** 用于向用户显示的名称（例如 'SQLite'） */
  displayName: string
  /** 主二进制文件名（不含扩展名）（例如 'sqlite3'） */
  primaryBinary: string
  /** 所有可执行文件名（不含扩展名）（例如 ['sqlite3', 'sqldiff']） */
  executableNames: string[]
}

export abstract class BaseEmbeddedBinaryManager {
  protected abstract readonly config: EmbeddedBinaryManagerConfig

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
   * 将版本转换为完整版本格式（例如 "3" -> "3.51.2"）
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
    const primaryPath = join(
      binPath,
      'bin',
      `${this.config.primaryBinary}${ext}`,
    )
    return existsSync(primaryPath)
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

      // 从后向前分割，以处理含非数字后缀的版本号
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
      // 带超时下载归档文件
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

      const fileStream = createWriteStream(archiveFile)

      if (!response.body) {
        fileStream.destroy()
        throw new Error(
          `下载失败：响应无 body（状态码 ${response.status}）`,
        )
      }

      // 将 WHATWG ReadableStream 转换为 Node.js Readable（需要 Node.js 18+）
      const nodeStream = Readable.fromWeb(response.body)
      await pipeline(nodeStream, fileStream)

      if (platform === Platform.Win32) {
        await this.extractWindowsBinaries(
          archiveFile,
          binPath,
          tempDir,
          platform,
          onProgress,
        )
      } else {
        await this.extractUnixBinaries(
          archiveFile,
          binPath,
          tempDir,
          platform,
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


  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
    platform: Platform,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // 检查是否存在嵌套的引擎目录
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === this.config.engineName ||
          e.name.startsWith(`${this.config.engineName}-`)),
    )

    // 确定源目录和要移动的条目
    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // 检查源目录是否已有 bin/ 目录
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    // 如果没有 bin/ 目录，创建一个并将可执行文件放入其中
    // 这处理可执行文件在根目录的扁平归档
    if (!hasBinDir) {
      const binDir = join(binPath, 'bin')
      await mkdir(binDir, { recursive: true })

      const ext = platform === Platform.Win32 ? '.exe' : ''
      const executableNames = this.config.executableNames.map(
        (name) => `${name}${ext}`,
      )

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // 可执行文件放入 bin/，其他文件放入 binPath 根目录
        const isExecutable = executableNames.includes(entry.name)
        const destPath = isExecutable
          ? join(binDir, entry.name)
          : join(binPath, entry.name)

        await moveEntry(sourcePath, destPath)
      }
    } else {
      // 有 bin/ 目录 —— 按原样移动所有条目
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
  }

  /**
   * 从 tar.gz 文件中解压 Unix 二进制文件
   */
  protected async extractUnixBinaries(
    tarFile: string,
    binPath: string,
    tempDir: string,
    platform: Platform,
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

    // 将解压后的条目移动到 binPath
    await this.moveExtractedEntries(extractDir, binPath, platform)
  }

  /**
   * 从 zip 文件中解压 Windows 二进制文件
   */
  protected async extractWindowsBinaries(
    zipFile: string,
    binPath: string,
    tempDir: string,
    platform: Platform,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: '正在解压二进制文件...',
    })

    // 首先使用 PowerShell 将 zip 解压到临时目录
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    // 为 PowerShell 转义单引号（将其翻倍）
    const escapeForPowerShell = (s: string) => s.replace(/'/g, "''")

    // 构建 PowerShell 命令
    const command = `Expand-Archive -LiteralPath '${escapeForPowerShell(zipFile)}' -DestinationPath '${escapeForPowerShell(extractDir)}' -Force`

    // 使用 -EncodedCommand 以避免特殊字符导致的 shell 解析问题
    // （例如，用户名中的 $，如 C:\Users\John$Doe 会被解释为变量）
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')

    await spawnAsync('powershell', [
      '-NoProfile',
      '-EncodedCommand',
      encodedCommand,
    ])

    // 将解压后的条目移动到 binPath
    await this.moveExtractedEntries(extractDir, binPath, platform)
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
    const primaryPath = join(
      binPath,
      'bin',
      `${this.config.primaryBinary}${ext}`,
    )

    if (!existsSync(primaryPath)) {
      throw new Error(
        `在 ${binPath}/bin/ 中未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    try {
      const { stdout } = await spawnAsync(primaryPath, ['--version'])
      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`无法从输出中解析版本号：${stdout.trim()}`)
      }

      // 检查完整版本是否精确匹配
      if (reportedVersion === fullVersion) {
        return true
      }

      // 检查语义化版本兼容性：主版本号相同且报告版本 >= 期望版本
      // 这允许二进制文件报告版本时的次要版本差异
      const expectedMajor = fullVersion.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (
        expectedMajor === reportedMajor &&
        compareVersions(reportedVersion, fullVersion) >= 0
      ) {
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
