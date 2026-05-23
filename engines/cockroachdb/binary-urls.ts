/**
 * CockroachDB 二进制文件 URL 生成
 *
 * 从 layerbase 注册表中生成 CockroachDB 二进制文件的下载 URL。
 */

import { type Platform, type Arch, Engine } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * 获取特定版本和平台的二进制文件下载 URL
 *
 * URL 格式：https://registry.layerbase.host/cockroachdb-{version}/cockroachdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - CockroachDB 版本（例如 '25.4.2' 或 '25'）
 * @param platform - 目标平台（darwin, linux, win32）
 * @param arch - 目标架构（x64, arm64）
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.CockroachDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * 获取某平台对应的压缩包扩展名
 */
export function getArchiveExtension(platform: Platform): string {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}