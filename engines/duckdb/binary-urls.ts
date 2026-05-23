/**
 * DuckDB 二进制 URL 工具
 *
 * 对 hostdb-client 的简单同步封装，用于向后兼容。
 * 实际的 URL 构建和平台校验委托给 core/hostdb-client.ts。
 */

import { buildDownloadUrl } from '../../core/hostdb-client'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * 根据 hostdb 构建 DuckDB 二进制的下载链接
 *
 * 格式: https://registry.layerbase.host/duckdb-{version}/duckdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - DuckDB 版本号（如 '1'、'1.4.3'）
 * @param platform - 平台标识符（如 'darwin'、'linux'、'win32'）
 * @param arch - 架构标识符（如 'arm64'、'x64'）
 * @returns 二进制文件的下载链接
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  return buildDownloadUrl(Engine.DuckDB, {
    version: fullVersion,
    platform,
    arch,
  })
}