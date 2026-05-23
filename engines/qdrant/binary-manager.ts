/**
 * Qdrant 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 Qdrant 二进制文件。
 * 继承 BaseBinaryManager 以复用共享的下载/解压逻辑。
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class QdrantBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Qdrant,
    engineName: 'qdrant',
    displayName: 'Qdrant',
    serverBinary: 'qdrant',
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
    // 从输出中提取版本号，如 "qdrant 1.16.3" 或 "v1.16.3"
    const match = stdout.match(/(?:qdrant\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const qdrantBinaryManager = new QdrantBinaryManager()