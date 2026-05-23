import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识符。
 * hostdb 使用标准 Node.js 平台命名 —— 此集合用于验证
 * 平台/架构组合是否受支持，而非进行转换。
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
 * hostdb 使用与 Node.js 标识符直接匹配的标准平台命名。
 * 此函数验证平台/架构组合是否受支持。
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（例如 'arm64'、'x64'）
 * @returns hostdb 平台标识符，若不受支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 构建 InfluxDB 二进制文件的 hostdb 下载 URL
 *
 * 格式：https://registry.layerbase.host/influxdb-{version}/influxdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - InfluxDB 版本（例如 '3'、'3.8.0'）
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

  // 标准化版本（处理主版本查找和 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.InfluxDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}
