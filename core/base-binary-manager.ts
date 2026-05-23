/**
 * 基础二进制文件管理器
 *
 * 为从 hostdb 下载二进制文件的管理器提供共享实现。
 * 当前由 Redis 和 Valkey 使用，它们的下载/解压逻辑几乎相同。
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
 * 二进制文件管理器实例的配置
 */
export type BinaryManagerConfig = {
  /** 引擎枚举值（例如 Engine.Redis） */
  engine: Engine
  /** 用于路径和 URL 的引擎名称字符串（例如 'redis'） */
  engineName: string
  /** 用于向用户显示的名称（例如 'Redis'） */
  displayName: string
  /** 服务器二进制文件名（不含扩展名）（例如 'redis-server'） */
  serverBinary: string
}

export abstract class BaseBinaryManager {
  protected abstract readonly config: BinaryManagerConfig

  /** 下载后 `--version` 验证的超时时间（毫秒）。如有需要，可在子类中重写。 */
  protected verifyTimeoutMs = 30_000

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
   * 将版本转换为完整版本格式（例如 "7" -> "7.4.7"）
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

      // 从后向前分割，以处理含短横线的版本号（例如 7.4.0-rc1）
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

    // 确保目录存在（binPath 在下载成功后创建）
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })

    let success = false
    try {
      // 下载归档文件（超时时间 5 分钟）
      onProgress?.({
        stage: 'downloading',
        message: `正在下载 ${this.config.displayName} 二进制文件...`,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

      let response: Response
      try {
        response = await fetchWithRegistryFallback(url, {
          signal: controller.signal,
        })
      } catch (error) {
        const err = error as Error
        if (err.name === 'AbortError') {
          throw new Error('下载在 5 分钟后超时')
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
        throw new Error(`下载失败：响应无 body（状态码 ${response.status}）`)
      }

      // 仅在确认 response.body 存在后创建文件流
      const fileStream = createWriteStream(archiveFile)
      try {
        // 将 WHATWG ReadableStream 转换为 Node.js Readable（需要 Node.js 18+）
        const nodeStream = Readable.fromWeb(response.body)
        await pipeline(nodeStream, fileStream)
      } catch (pipelineError) {
        // 确保在管道错误时销毁 fileStream
        fileStream.destroy()
        throw pipelineError
      }

      // 下载成功后才创建 binPath（避免在失败时留下空目录）
      await mkdir(binPath, { recursive: true })

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

    // 使用 PowerShell 首先将 zip 解压到临时目录
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

    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * 将解压后的条目从 extractDir 移动到 binPath，处理嵌套的引擎目录。
   * 归档文件可能具有 {engine}/bin/ 结构或扁平的 {engine}/ 结构。
   * 此方法将两种结构统一为 binPath/bin/ 结构。
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
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // 检查源目录是否包含 bin/ 子目录
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    if (hasBinDir) {
      // 标准结构：按原样移动所有条目（保留 bin/ 子目录）
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    } else {
      // 扁平结构：二进制文件直接位于 engine/ 中，需要创建 bin/ 子目录
      const destBinDir = join(binPath, 'bin')
      await mkdir(destBinDir, { recursive: true })

      // 常见的无扩展名非二进制文件（不区分大小写）
      const nonBinaryFiles = new Set([
        'license',
        'licence',
        'readme',
        'notice',
        'changelog',
        'contributing',
        'authors',
        'copying',
        'version',
        'makefile',
        'dockerfile',
        'manifest',
        'install',
        'news',
        'thanks',
        'todo',
        'history',
      ])

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // 识别可执行文件：Windows 上的 .exe/.dll，或 Unix 上无特定扩展名的文件
        const isWindowsExecutable =
          entry.name.endsWith('.exe') || entry.name.endsWith('.dll')
        const isConfigOrMetadata =
          entry.name.startsWith('.') ||
          entry.name.endsWith('.json') ||
          entry.name.endsWith('.conf') ||
          entry.name.endsWith('.yaml') ||
          entry.name.endsWith('.yml') ||
          entry.name.endsWith('.xml') ||
          entry.name.endsWith('.txt') ||
          entry.name.endsWith('.md')
        const isKnownNonBinary = nonBinaryFiles.has(entry.name.toLowerCase())
        const isUnixExecutable =
          entry.isFile() &&
          !isConfigOrMetadata &&
          !isKnownNonBinary &&
          !entry.name.includes('.')

        const isBinary = isWindowsExecutable || isUnixExecutable
        const destPath = isBinary
          ? join(destBinDir, entry.name)
          : join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
  }

  /**
   * 返回启动引擎二进制文件时所需的额外环境变量。
   * 在子类中重写，用于需要自定义库路径的引擎
   * （例如，InfluxDB 在 Windows 上需要将 python/ 添加到 PATH 以加载 python313.dll）。
   */
  protected getSpawnEnv(_binPath: string): Record<string, string> | undefined {
    return undefined
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
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `在 ${binPath}/bin/ 中未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    try {
      const { stdout, stderr } = await spawnAsync(serverPath, ['--version'], {
        timeout: this.verifyTimeoutMs,
        cwd: binPath,
        env: this.getSpawnEnv(binPath),
      })
      // 如果存在 stderr，记录日志（可能包含警告）
      if (stderr && stderr.trim()) {
        logDebug(`${this.config.serverBinary} stderr`, {
          stderr: stderr.trim(),
        })
      }

      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`无法从输出中解析版本号：${stdout.trim()}`)
      }

      // 检查主版本是否匹配
      const expectedMajor = version.split('.')[0]
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
   * 获取特定二进制文件（如 redis-server、redis-cli）的路径
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
