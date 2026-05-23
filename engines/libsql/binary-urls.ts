import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识符。
 * libSQL (sqld) 没有 Windows 二进制文件。
 */
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
])

/**
 * 获取 hostdb 平台标识符
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'）
 * @param arch - Node.js 架构（例如 'arm64'、'x64'）
 * @returns hostdb 平台标识符，若不支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 为 libSQL 二进制文件构建 hostdb 下载 URL
 *
 * 格式：https://registry.layerbase.host/libsql-{version}/libsql-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - libSQL 版本（例如 '0.24'、'0.24.32'）
 * @param platform - 平台标识符（例如 'darwin'、'linux'）
 * @param arch - 架构标识符（例如 'arm64'、'x64'）
 * @returns 二进制文件的下载 URL
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const platformKey = `${platform}-${arch}`
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    const supported = Array.from(SUPPORTED_PLATFORMS).join(', ')
    throw new Error(`不支持的平台：${platformKey}。支持的平台：${supported}`)
  }

  // 标准化版本（处理主版本号查找以及 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version)

  return buildHostdbUrl(Engine.LibSQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: 'tar.gz',
  })
}
