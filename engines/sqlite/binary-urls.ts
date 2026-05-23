/**
 * SQLite 二进制文件 URL 工具
 *
 * 对 hostdb-client 的简单同步封装，用于向后兼容。
 * 实际的 URL 构建和平台校验委托给 core/hostdb-client.ts。
 */

import { buildDownloadUrl } from '../../core/hostdb-client'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * 构建从 hostdb 下载 SQLite 二进制文件的 URL
 *
 * 格式：https://registry.layerbase.host/sqlite-{version}/sqlite-{version}-{platform}-{arch}.{ext}
 *
 * @param version - SQLite 版本号（如 '3'、'3.51.2'）
 * @param platform - 平台标识符（如 'darwin'、'linux'、'win32'）
 * @param arch - 架构标识符（如 'arm64'、'x64'）
 * @returns 二进制文件的下载 URL
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  return buildDownloadUrl(Engine.SQLite, {
    version: fullVersion,
    platform,
    arch,
  })
}