/**
 * SurrealDB 二进制文件 URL 生成
 *
 * 从 layerbase 注册表构建 SurrealDB 二进制文件的下载 URL。
 */

import { Engine, type Platform, type Arch } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * 获取指定版本和平台的二进制文件下载 URL
 *
 * URL 格式：https://registry.layerbase.host/surrealdb-{version}/surrealdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - SurrealDB 版本（例如 '2.3.2' 或 '2'）
 * @param platform - 目标平台（darwin、linux、win32）
 * @param arch - 目标架构（x64、arm64）
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.SurrealDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * 获取指定平台的归档文件扩展名
 */
export function getArchiveExtension(platform: Platform): string {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
