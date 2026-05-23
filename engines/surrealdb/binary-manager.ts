/**
 * SurrealDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 SurrealDB 二进制文件。
 * 继承 BaseBinaryManager 以复用下载/解压逻辑。
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class SurrealDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.SurrealDB,
    engineName: 'surrealdb',
    displayName: 'SurrealDB',
    serverBinary: 'surreal',
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

  /**
   * 从版本输出中解析版本号
   *
   * 输出格式示例：
   * - "surreal 2.3.2 for linux on x86_64"
   * - 或仅 "2.3.2"
   */
  protected parseVersionFromOutput(stdout: string): string | null {
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const surrealdbBinaryManager = new SurrealDBBinaryManager()
