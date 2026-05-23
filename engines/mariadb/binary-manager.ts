/**
 * MariaDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 MariaDB 二进制文件。
 * MariaDB 二进制文件可能使用 'mariadbd' 或 'mysqld' 作为服务器二进制名称，
 * 因此会按优先级顺序检查两者。
 */

import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MariaDBBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.MariaDB,
    engineName: 'mariadb',
    displayName: 'MariaDB',
    // MariaDB 可能使用 mariadbd（新版）或 mysqld（旧版）作为服务器二进制名称
    serverBinaryNames: ['mariadbd', 'mysqld'],
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
    // 从类似 "mariadbd  Ver 11.8.5-MariaDB" 的输出中提取版本号
    const match = stdout.match(/Ver\s+([\d.]+)/)
    return match?.[1] ?? null
  }
}

export const mariadbBinaryManager = new MariaDBBinaryManager()
