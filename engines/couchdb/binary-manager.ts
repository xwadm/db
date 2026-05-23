/**
 * CouchDB 二进制文件管理器
 *
 * 处理从 hostdb 下载、解压和管理 CouchDB 二进制文件。
 * 继承自 BaseBinaryManager，共享下载/解压逻辑。
 *
 * 注意：CouchDB 不支持 --version 标志。它是一个 Erlang 应用程序，
 * 运行时尝试启动服务器，因此我们覆盖 verify() 仅检查二进制文件是否存在，而不运行它。
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

class CouchDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.CouchDB,
    engineName: 'couchdb',
    displayName: 'CouchDB',
    serverBinary: 'couchdb',
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
    // 从类似 "couchdb 3.5.1" 或 "Apache CouchDB 3.5.1" 的输出中提取版本号
    const match = stdout.match(
      /(?:couchdb\s+)?(?:Apache CouchDB\s+)?v?(\d+\.\d+\.\d+)/i,
    )
    return match?.[1] ?? null
  }

  /**
   * 覆盖 verify 仅检查二进制文件是否存在。
   * CouchDB 不支持 --version 标志 - 它是一个 Erlang 应用程序，
   * 带任何参数运行时都会尝试启动服务器。
   *
   * 注意：在 Windows 上，CouchDB 使用 .cmd 批处理文件，而非 .exe
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

    // CouchDB 在 Windows 上使用 .cmd 批处理文件，而非 .exe
    const ext = platform === Platform.Win32 ? '.cmd' : ''
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `在 ${binPath}/bin/ 中未找到 ${this.config.displayName} 二进制文件`,
      )
    }

    // 仅验证二进制文件是否存在 - 无法在 CouchDB 上运行 --version
    return true
  }
}

export const couchdbBinaryManager = new CouchDBBinaryManager()
