import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识符。
 * TigerBeetle 支持全部 5 个平台。
 */
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

/**
 * 获取 hostdb 平台标识符
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（例如 'arm64'、'x64'）
 * @returns hostdb 平台标识符，如不支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 从 hostdb 构建 TigerBeetle 二进制文件的下载 URL
 *
 * @param version - TigerBeetle 版本（例如 '0.16'、'0.16.70'）
 * @param platform - 平台标识符（例如 'darwin'、'linux'、'win32'）
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
    throw new Error(
      `不支持的平台：${platformKey}。支持的平台：${supported}`,
    )
  }

  const fullVersion = normalizeVersion(version)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.TigerBeetle, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}
