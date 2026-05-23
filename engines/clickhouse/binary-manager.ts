/**
 * ClickHouse 二进制文件管理器
 *
 * 处理从 hostdb 下载、解压和管理 ClickHouse 二进制文件。
 * ClickHouse 使用单一的统一二进制文件，支持服务器、客户端和本地模式。
 *
 * 继承自 BaseServerBinaryManager，并包含 ClickHouse 特定的覆盖：
 * - 不支持 Windows（在 Windows 解压时抛出错误）
 * - verify() 中使用 YY.MM 版本匹配
 * - 处理扁平归档（将 clickhouse 二进制文件移动到 bin/ 目录）
 */

import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { logDebug } from '../../core/error-handler'
import { moveEntry } from '../../core/fs-error-utils'
import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import {
  Engine,
  type Platform,
  type Arch,
  type ProgressCallback,
} from '../../types'

const execAsync = promisify(exec)

class ClickHouseBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.ClickHouse,
    engineName: 'clickhouse',
    displayName: 'ClickHouse',
    serverBinaryNames: ['clickhouse'],
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
    // 从类似 "ClickHouse client version 25.12.3.21" 的输出中提取版本号
    const match = stdout.match(/(\d+\.\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * ClickHouse 在 hostdb 上没有 Windows 二进制文件。
   * 覆盖此方法以抛出明确的错误。
   */
  protected override async extractWindowsBinaries(
    _zipFile: string,
    _binPath: string,
    _tempDir: string,
    _onProgress?: ProgressCallback,
  ): Promise<void> {
    throw new Error(
      'ClickHouse 二进制文件不适用于 Windows。' +
        'ClickHouse 仅支持 macOS 和 Linux。',
    )
  }

  /**
   * 覆盖此方法以处理 ClickHouse 的归档结构。
   * ClickHouse 归档可能具有扁平结构，其中二进制文件位于根目录，
   * 而不是 bin/ 子目录中。此方法会将 clickhouse 二进制文件移动到 bin/ 目录。
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // 查找 clickhouse 子目录
    const clickhouseDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'clickhouse' || e.name.startsWith('clickhouse-')),
    )

    const sourceDir = clickhouseDir
      ? join(extractDir, clickhouseDir.name)
      : extractDir
    const sourceEntries = clickhouseDir
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
      // 扁平结构：创建 bin/ 目录并将二进制文件移动到其中
      const destBinDir = join(binPath, 'bin')
      await mkdir(destBinDir, { recursive: true })

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // 判断是否为可执行文件（Unix 上无扩展名，以 'clickhouse' 开头）
        const isExecutable =
          entry.isFile() &&
          !entry.name.includes('.') &&
          entry.name.startsWith('clickhouse')
        const destPath = isExecutable
          ? join(destBinDir, entry.name)
          : join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
  }

  /**
   * 覆盖验证方法，以适配 ClickHouse 的 YY.MM 版本格式。
   * ClickHouse 使用 `clickhouse client --version`，其版本为 4 部分（YY.MM.patch.build）。
   */
  override async verify(
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

    const clickhousePath = join(binPath, 'bin', 'clickhouse')

    if (!existsSync(clickhousePath)) {
      throw new Error(`在 ${binPath}/bin/ 中未找到 ClickHouse 二进制文件`)
    }

    try {
      const { stdout, stderr } = await execAsync(
        `"${clickhousePath}" client --version`,
      )
      // 记录 stderr（可能包含有关配置等的无害警告）
      if (stderr && stderr.trim()) {
        logDebug(`clickhouse 客户端版本检查时的 stderr：${stderr.trim()}`)
      }
      const reportedVersion = this.parseVersionFromOutput(stdout)
      if (!reportedVersion) {
        throw new Error(`无法从输出中解析版本号：${stdout.trim()}`)
      }

      // 检查主版本是否匹配（YY.MM 格式）
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
      if (expectedMajor === reportedMajor) {
        return true
      }

      // 检查完整版本是否匹配
      if (reportedVersion === fullVersion) {
        return true
      }

      throw new Error(`版本不匹配：期望 ${version}，实际 ${reportedVersion}`)
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: number }
      // 在错误消息中包含 stderr 和退出码，以便于调试
      const details = [err.message]
      if (err.stderr) details.push(`stderr: ${err.stderr.trim()}`)
      if (err.code !== undefined) details.push(`退出码: ${err.code}`)
      throw new Error(`验证 ClickHouse 二进制文件失败：${details.join(', ')}`)
    }
  }
}

export const clickhouseBinaryManager = new ClickHouseBinaryManager()
