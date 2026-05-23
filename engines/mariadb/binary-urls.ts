import { MARIADB_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * 获取 hostdb 平台标识符
 *
 * hostdb 使用标准平台命名（例如 'darwin-arm64'、'linux-x64'），
 * 与 Node.js 平台标识符直接匹配。
 *
 * @param platform - Node.js 平台（例如 'darwin'、'linux'、'win32'）
 * @param arch - Node.js 架构（例如 'arm64'、'x64'）
 * @returns hostdb 平台标识符，如果不支持则返回 null
 */
// MariaDB hostdb 二进制文件支持的平台/架构组合
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * 构建 MariaDB 二进制文件的 hostdb 下载 URL
 *
 * 格式：https://registry.layerbase.host/mariadb-{version}/mariadb-{version}-{platform}-{arch}.tar.gz
 * Windows：https://registry.layerbase.host/mariadb-{version}/mariadb-{version}-{platform}-{arch}.zip
 *
 * @param version - MariaDB 版本（例如 '11.8'、'11.8.5'）
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

  // 标准化版本（处理主版本查找和 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version, MARIADB_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MariaDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串标准化为 X.Y.Z 格式
 *
 * 注意：MariaDB 不使用 validateSemverLikeVersion()，因为：
 * 1. MariaDB 版本可能带有后缀（例如 "--version" 输出中的 "11.8.5-MariaDB"）
 * 2. 版本映射表处理已知版本；未知版本直接传递，
 *    在下载时会因明确的 404 错误而失败
 *
 * @param version - 版本字符串（例如 '11.8'、'11.8.5'）
 * @param versionMap - 可选的版本映射表，用于主版本查找
 * @returns 标准化后的版本（例如 '11.8.5'）
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = MARIADB_VERSION_MAP,
): string {
  // 检查是否为映射表中的主版本
  if (versionMap[version]) {
    return versionMap[version]
  }

  // 标准化为 X.Y.Z 格式
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * 获取主版本对应的完整版本字符串
 *
 * @param majorVersion - 主版本（例如 '11.8'）
 * @returns 完整版本字符串（例如 '11.8.5'），如果不支持则返回 null
 */
