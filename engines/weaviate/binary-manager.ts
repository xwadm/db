/**
 * Weaviate 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 Weaviate 二进制文件。
 * 继承 BaseBinaryManager 以复用下载/解压逻辑。
 *
 * 注意：Weaviate 不支持 --version 参数（截至 v1.35.x）。
 * 因此我们覆写 verify() 方法，仅检查二进制文件是否存在，而不执行它。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'
import { paths } from '../../config/paths'

class WeaviateBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Weaviate,
    engineName: 'weaviate',
    displayName: 'Weaviate',
    serverBinary: 'weaviate',
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
    // 从类似 "weaviate v1.35.7" 或 "1.35.7" 的输出中提取版本号
    const match = stdout.match(/(?:weaviate\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * 覆写 verify 方法，仅检查二进制文件是否存在。
   * Weaviate 不支持 --version 参数（截至 v1.35.x）。
   * 参见：https://github.com/weaviate/weaviate/issues/6571
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
        `${this.config.displayName} 二进制文件未找到，路径：${binPath}/bin/`,
      )
    }

    // 仅验证二进制文件存在 — Weaviate 不支持运行 --version
    return true
  }
}

export const weaviateBinaryManager = new WeaviateBinaryManager()