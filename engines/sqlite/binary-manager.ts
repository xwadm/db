/**
 * SQLite 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 SQLite 二进制文件。
 * 与其他引擎不同，SQLite 是嵌入式数据库（非服务端）。
 * 本管理器处理 sqlite3 命令行工具及相关工具。
 */

import {
  BaseEmbeddedBinaryManager,
  type EmbeddedBinaryManagerConfig,
} from '../../core/base-embedded-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

export const SQLITE_EXECUTABLES = [
  'sqlite3',
  'sqldiff',
  'sqlite3_analyzer',
  'sqlite3_rsync',
]

class SQLiteBinaryManager extends BaseEmbeddedBinaryManager {
  protected readonly config: EmbeddedBinaryManagerConfig = {
    engine: Engine.SQLite,
    engineName: 'sqlite',
    displayName: 'SQLite',
    primaryBinary: 'sqlite3',
    executableNames: SQLITE_EXECUTABLES,
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
    // 从类似 "3.51.2 2025-01-08 12:00:00 ..." 的输出中提取版本号
    const match = stdout.match(/^(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const sqliteBinaryManager = new SQLiteBinaryManager()