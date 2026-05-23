import { FALLBACK_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { validateSemverLikeVersion } from '../../core/version-utils'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载所支持的平台标识符。
 * hostdb 使用标准 Node.js 平台命名。
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
 * hostdb 使用标准平台命名（例如 'darwin-arm64'、'linux-x64'），
 * 与 Node.js 平台标识符直接对应。
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'、'win32'）
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
 * 构建从 hostdb 下载 MySQL 二进制文件的 URL
 *
 * 格式：https://registry.layerbase.host/mysql-{version}/mysql-{version}-{platform}-{arch}.tar.gz
 * Windows：https://registry.layerbase.host/mysql-{version}/mysql-{version}-{platform}-{arch}.zip
 *
 * @param version - MySQL 版本（例如 '8.0'、'8.0.40'）
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
    throw new Error(`不支持的平台：${platformKey}`)
  }

  // 规范化版本（处理主版本查找及 X.Y → X.Y.Z 转换）
  const fullVersion = normalizeVersion(version, FALLBACK_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MySQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串规范化为 X.Y.Z 格式
 *
 * @param version - 版本字符串（例如 '8.0'、'8.0.40'、'9'）
 * @param versionMap - 可选的主版本查找映射表
 * @returns 规范化后的版本（例如 '8.0.40'）
 * @throws TypeError 若版本字符串格式有误
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = FALLBACK_VERSION_MAP,
): string {
  // 检查是否为主版本（存在于映射表中）
  if (versionMap[version]) {
    return versionMap[version]
  }

  // 验证版本格式：必须为数字类 semver（X、X.Y 或 X.Y.Z）
  validateSemverLikeVersion(version, 'MySQL')

  // 规范化为 X.Y.Z 格式
  const parts = version.split('.')
  if (parts.length === 1) {
    return `${version}.0.0`
  } else if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * 获取主版本对应的完整版本字符串
 *
 * @param majorVersion - 主版本（例如 '8.0'、'9'）
 * @returns 完整版本字符串（例如 '8.0.40'），若不支持则返回 null
 */