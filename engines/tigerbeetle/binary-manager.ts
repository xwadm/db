/**
 * TigerBeetle 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 TigerBeetle 二进制文件。
 * 继承 BaseBinaryManager 以复用下载/解压逻辑。
 *
 * 注意：TigerBeetle 使用 `tigerbeetle version`（子命令，非 --version 标志）。
 * 我们覆写 verify() 以使用正确的调用方式。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { spawnAsync } from '../../core/spawn-utils'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'

class TigerBeetleBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.TigerBeetle,
    engineName: 'tigerbeetle',
    displayName: 'TigerBeetle',
    serverBinary: 'tigerbeetle',
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
    // TigerBeetle 输出格式："TigerBeetle v0.16.70" 或类似格式
    const match = stdout.match(/(?:TigerBeetle\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * 覆写 verify 以使用 `tigerbeetle version` 子命令而非 `--version`。
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
        `在 ${binPath}/bin/ 未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    // TigerBeetle 使用 `tigerbeetle version` 子命令（非 --version）
    try {
      const { stdout } = await spawnAsync(serverPath, ['version'], {
        timeout: 10000,
      })
      const parsedVersion = this.parseVersionFromOutput(stdout)
      if (parsedVersion) {
        logDebug(
          `TigerBeetle 二进制文件已验证：${parsedVersion}，路径：${serverPath}`,
        )
      }
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logDebug(`TigerBeetle 版本检查失败 ${serverPath}：${msg}`)
      return false
    }
  }
}

export const tigerbeetleBinaryManager = new TigerBeetleBinaryManager()
