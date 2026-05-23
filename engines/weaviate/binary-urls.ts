import { WEAVIATE_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识列表。
 * hostdb 使用标准 Node.js 平台命名 — 此集合用于验证
 * 某个平台/架构组合是否受支持，而非对其进行转换。
 */
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

/**
 * 获取 hostdb 平台标识
 *
 * hostdb 使用标准平台命名，与 Node.js 标识直接对应。
 * 此函数验证平台/架构组合是否受支持。
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（例如 'arm64'、'x64'）
 * @returns hostdb 平台标识，不支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 构建从 hostdb 下载 Weaviate 二进制文件的 URL
 *
 * 格式：https://registry.layerbase.host/weaviate-{version}/weaviate-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Weaviate 版本（例如 '1'、'1.35.7'）
 * @param platform - 平台标识（例如 'darwin'、'linux'、'win32'）
 * @param arch - 架构标识（例如 'arm64'、'x64'）
 * @returns 二进制文件下载 URL
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

  // 标准化版本号（处理主版本号查找及 X.Y → X.Y.Z 转换）
  const fullVersion = normalizeVersion(version, WEAVIATE_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.Weaviate, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串标准化为 X.Y.Z 格式
 *
 * @param version - 版本字符串（例如 '1'、'1.35'、'1.35.7'）
 * @param versionMap - 可选版本映射表，用于主版本号查找
 * @returns 标准化后的版本号（例如 '1.35.7'）
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = WEAVIATE_VERSION_MAP,
): string {
  // 检查是否为映射表中的精确键（处理 "1"、"1.35" 等）
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // 如果已是完整版本号（X.Y.Z），直接返回
  if (parts.length === 3) {
    return version
  }

  // 对于两位版本号（如 "1.35"），优先尝试精确匹配两位键，然后回退到主版本号
  if (parts.length === 2) {
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
    // 回退到主版本号以获取最新补丁版本
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  // 未知版本格式 — 记录日志并按原样返回
  // 如果该版本在 hostdb 中不存在，可能导致下载失败
  logDebug(
    `Weaviate 版本 '${version}' 不在版本映射表中，可能在 hostdb 中不可用`,
  )
  return version
}