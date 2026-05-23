/**
 * PostgreSQL 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 PostgreSQL 二进制文件。
 * PostgreSQL 二进制文件包含服务端工具（postgres、pg_ctl、initdb）和
 * 客户端工具（psql、pg_dump、pg_restore、pg_basebackup）。
 *
 * 所有平台（macOS、Linux、Windows）均从 hostdb 下载 —— Windows 使用
 * 上传到 hostdb 的 EDB 二进制文件以保持一致性。
 */

import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { paths } from '../../config/paths'
import { spawnAsync } from '../../core/spawn-utils'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'

class PostgreSQLBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.PostgreSQL,
    engineName: 'postgresql',
    displayName: 'PostgreSQL',
    serverBinaryNames: ['postgres'],
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
    // 从类似 "postgres (PostgreSQL) 18.1" 的输出中提取版本号
    const match = stdout.match(/postgres \(PostgreSQL\) ([\d.]+)/)
    return match?.[1] ?? null
  }

  /**
   * 验证 PostgreSQL 二进制文件是否正常工作
   *
   * PostgreSQL 的版本输出格式为："postgres (PostgreSQL) X.Y" 或
   * "postgres (PostgreSQL) X.Y - Percona Server for PostgreSQL X.Y.Z"
   * 这与 MySQL/MariaDB 的 "Ver X.Y.Z" 格式不同。
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
        `在 ${binPath}/bin/ 下未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    let stdout: string
    try {
      const result = await spawnAsync(serverPath, ['--version'])
      stdout = result.stdout
    } catch (error) {
      // 仅包装 spawn/OS 错误，不包装验证错误
      const err = error as Error
      throw new Error(
        `验证 ${this.config.displayName} 二进制文件失败：${err.message}`,
      )
    }

    const reportedVersion = this.parseVersionFromOutput(stdout)
    if (!reportedVersion) {
      throw new Error(`无法从以下输出解析版本：${stdout.trim()}`)
    }
    const expectedNormalized = this.stripTrailingZero(fullVersion)
    const reportedNormalized = this.stripTrailingZero(reportedVersion)

    // 检查版本是否匹配（例如 "18.1.0" 与 "18.1"）
    if (reportedNormalized === expectedNormalized) {
      return true
    }

    // 同时接受主版本号.次版本号匹配（例如期望 "18.1.0"，实际 "18.1"）
    const expectedMajorMinor = fullVersion.split('.').slice(0, 2).join('.')
    const reportedMajorMinor = reportedVersion.split('.').slice(0, 2).join('.')
    if (expectedMajorMinor === reportedMajorMinor) {
      return true
    }

    throw new Error(
      `版本不匹配：期望 ${fullVersion}，实际 ${reportedVersion}`,
    )
  }
}

export const postgresqlBinaryManager = new PostgreSQLBinaryManager()
