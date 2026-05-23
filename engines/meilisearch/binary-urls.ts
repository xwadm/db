import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载所支持的平台标识符集合。
 * hostdb 使用标准的 Node.js 平台命名规范 — 此集合用于校验
 * 某个平台/架构组合是否受支持，而非做转换。
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
 * hostdb 使用标准平台命名，与 Node.js 标识符直接对应。
 * 本函数用于校验平台/架构组合是否受支持。
 *
 * @param platform - Node.js 平台（如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（如 'arm64'、'x64'）
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
 * 根据 hostdb 构建 Meilisearch 二进制的下载链接
 *
 * 格式: https://registry.layerbase.host/meilisearch-{version}/meilisearch-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Meilisearch 版本号（如 '1'、'1.33.1'）
 * @param platform - 平台标识符（如 'darwin'、'linux'、'win32'）
 * @param arch - 架构标识符（如 'arm64'、'x64'）
 * @returns 二进制文件的下载链接
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
      `不支持的平台: ${platformKey}。支持的平台: ${supported}`,
    )
  }

  // 规范化版本号（处理主版本号查找和 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.Meilisearch, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}