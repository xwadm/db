/**
 * Meilisearch 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 Meilisearch 二进制文件。
 * 继承 BaseBinaryManager 以复写共享的下载/解压逻辑。
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MeilisearchBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Meilisearch,
    engineName: 'meilisearch',
    displayName: 'Meilisearch',
    serverBinary: 'meilisearch',
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
    // 从类似 "meilisearch 1.33.1" 或 "v1.33.1" 的输出中提取版本号
    const match = stdout.match(/(?:meilisearch\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const meilisearchBinaryManager = new MeilisearchBinaryManager()