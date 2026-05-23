/**
 * Valkey 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 Valkey 二进制文件。
 * 继承 BaseBinaryManager 以复用下载/解压逻辑。
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class ValkeyBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Valkey,
    engineName: 'valkey',
    displayName: 'Valkey',
    serverBinary: 'valkey-server',
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
    // 从类似 "Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..." 的输出中提取版本号
    // 或匹配 "v=8.0.6" 模式
    const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
    const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+)/) : null
    return match?.[1] ?? altMatch?.[1] ?? null
  }
}

export const valkeyBinaryManager = new ValkeyBinaryManager()