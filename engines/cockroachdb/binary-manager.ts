/**
 * CockroachDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 CockroachDB 二进制文件。
 * 继承 BaseBinaryManager 以复用下载/解压逻辑。
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class CockroachDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.CockroachDB,
    engineName: 'cockroachdb',
    displayName: 'CockroachDB',
    serverBinary: 'cockroach',
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
    // 从类似以下格式的输出中提取版本号：
    // "Build Tag:        v25.4.2"
    // 或 "CockroachDB CCL v25.4.2"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const cockroachdbBinaryManager = new CockroachDBBinaryManager()