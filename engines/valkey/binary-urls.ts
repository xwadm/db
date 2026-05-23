import { VALKEY_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载所支持的平台标识符集合。
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
 * hostdb 使用标准平台命名，与 Node.js 标识符直接匹配。
 * 此函数验证平台/架构组合是否受支持。
 *
 * @param platform - Node.js 平台（如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（如 'arm64'、'x64'）
 * @returns hostdb 平台标识符，如果不受支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 构建 Valkey 二进制文件的 hostdb 下载 URL
 *
 * 格式：https://registry.layerbase.host/valkey-{version}/valkey-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Valkey 版本（如 '8'、'8.0.6'）
 * @param platform - 平台标识符（如 'darwin'、'linux'、'win32'）
 * @param arch - 架构标识符（如 'arm64'、'x64'）
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
      `不支持的平台: ${platformKey}。支持的平台: ${supported}`,
    )
  }

  // 标准化版本号（处理大版本查找和 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version, VALKEY_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.Valkey, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串标准化为 X.Y.Z 格式
 *
 * @param version - 版本字符串（如 '8'、'8.0'、'8.0.6'）
 * @param versionMap - 可选的大版本映射表
 * @returns 标准化后的版本号（如 '8.0.6'）
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = VALKEY_VERSION_MAP,
): string {
  // 检查是否为映射表中的精确键（处理 "8"、"9"、"8.0" 等）
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // 如果已经是完整版本（X.Y.Z），直接返回
  if (parts.length === 3) {
    return version
  }

  // 对于两段版本号（如 "8.0"），先尝试精确的两段键，然后回退到大版本
  if (parts.length === 2) {
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
    // 回退到大版本以获取最新补丁版本
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  // 未知版本格式 —— 记录日志并原样返回
  // 如果该版本在 hostdb 中不存在，可能导致下载失败
  logDebug(
    `Valkey 版本 '${version}' 不在版本映射表中，可能在 hostdb 中不可用`,
  )
  return version
}

/**
 * 获取大版本对应的完整版本字符串
 *
 * @param majorVersion - 大版本号（如 '8'、'9'）
 * @returns 完整版本字符串（如 '8.0.6'），如果不支持则返回 null
 */