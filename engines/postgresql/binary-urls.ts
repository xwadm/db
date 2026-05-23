import { POSTGRESQL_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { validateSemverLikeVersion } from '../../core/version-utils'
import { Engine, Platform, type Arch } from '../../types'

// PostgreSQL hostdb 二进制文件支持的平台/架构组合
const SUPPORTED_PLATFORM_KEYS = new Set([
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
 * @returns hostdb 平台标识符，如果不支持则返回 null
 */

export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * 构建 PostgreSQL 二进制文件的 hostdb 下载 URL
 *
 * 格式：https://registry.layerbase.host/postgresql-{version}/postgresql-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - PostgreSQL 版本（例如 '17'、'17.7.0'）
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

  // 规范化版本（处理主版本查找和 X.Y -> X.Y.0 转换）
  const fullVersion = normalizeVersion(version, POSTGRESQL_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.PostgreSQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串规范化为 X.Y.Z 格式
 *
 * @param version - 版本字符串（例如 '17'、'17.7'、'17.7.0'）
 * @param versionMap - 可选的版本映射表，用于主版本查找
 * @returns 规范化后的版本（例如 '17.7.0'）
 * @throws TypeError 如果版本字符串格式不正确
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = POSTGRESQL_VERSION_MAP,
): string {
  // 检查是否为映射表中的主版本
  if (versionMap[version]) {
    return versionMap[version]
  }

  // 验证版本格式：必须为数字形式的 semver 风格（X、X.Y 或 X.Y.Z）
  validateSemverLikeVersion(version, 'PostgreSQL')

  // 规范化为 X.Y.Z 格式
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * 获取主版本对应的完整版本字符串
 *
 * @param majorVersion - 主版本（例如 '17'）
 * @returns 完整版本字符串（例如 '17.7.0'），如果不支持则返回 null
 */
