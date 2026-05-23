/**
 * DuckDB 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 DuckDB 二进制文件。
 * 与其他数据库引擎不同，DuckDB 是嵌入式数据库（非服务端程序）。
 * 本管理器负责管理 duckdb 命令行工具。
 */

import {
  BaseEmbeddedBinaryManager,
  type EmbeddedBinaryManagerConfig,
} from '../../core/base-embedded-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class DuckDBBinaryManager extends BaseEmbeddedBinaryManager {
  protected readonly config: EmbeddedBinaryManagerConfig = {
    engine: Engine.DuckDB,
    engineName: 'duckdb',
    displayName: 'DuckDB',
    primaryBinary: 'duckdb',
    executableNames: ['duckdb'],
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
    // 从类似 "v1.4.3 abcdef123" 的输出中提取版本号
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const duckdbBinaryManager = new DuckDBBinaryManager()