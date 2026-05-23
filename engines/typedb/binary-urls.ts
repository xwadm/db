/**
 * TypeDB 二进制文件 URL 生成
 *
 * 从 layerbase 注册表生成 TypeDB 二进制文件的下载 URL。
 */

import { type Platform, type Arch, Engine } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * 获取指定版本和平台的二进制文件下载 URL
 *
 * URL 格式：https://registry.layerbase.host/typedb-{version}/typedb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - TypeDB 版本（如 '3.8.0' 或 '3'）
 * @param platform - 目标平台（darwin、linux、win32）
 * @param arch - 目标架构（x64、arm64）
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = getArchiveExtension(platform)

  return buildHostdbUrl(Engine.TypeDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * 获取平台的归档文件扩展名
 */
export function getArchiveExtension(platform: Platform): 'tar.gz' | 'zip' {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
