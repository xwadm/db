import { REDIS_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识符集合。
 * hostdb 使用标准的 Node.js 平台命名 — 此集合用于验证
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
 * 获取 hostdb 平台标识符
 *
 * hostdb 使用标准平台命名，直接与 Node.js 标识符一致。
 * 此函数验证平台/架构组合是否受支持。
 *
 * @param platform - Node.js 平台（如 'darwin', 'linux', 'win32'）
 * @param arch - Node.js 架构（如 'arm64', 'x64'）
 * @returns hostdb 平台标识符，如果不支持则返回 null
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 从 hostdb 构建 Redis 二进制文件的下载 URL
 *
 * 格式：https://registry.layerbase.host/redis-{version}/redis-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Redis 版本（如 '7', '7.4.7'）
 * @param platform - 平台标识符（如 'darwin', 'linux', 'win32'）
 * @param arch - 架构标识符（如 'arm64', 'x64'）
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
    throw new Error(`不支持的平台: ${platformKey}`)
  }

  // 标准化版本号（处理主版本号查找以及 X.Y -> X.Y.Z 转换）
  const fullVersion = normalizeVersion(version, REDIS_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.Redis, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 将版本字符串标准化为 X.Y.Z 格式
 *
 * 注意：Redis 不使用 validateSemverLikeVersion()，原因如下：
 * 1. Redis 采用宽松策略 — 未知版本仅记录警告并透传
 * 2. 这允许在版本映射表中添加新版本之前先进行测试
 * 3. 无效版本会在下载时以明确的 404 错误失败
 *
 * @param version - 版本字符串（如 '7', '7.4', '7.4.7'）
 * @param versionMap - 可选的主版本号查找映射表
 * @returns 标准化后的版本号（如 '7.4.7'）
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = REDIS_VERSION_MAP,
): string {
  // 检查是否为映射表中的精确键（处理 "7", "8", "7.4" 等）
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // 如果已经是完整版本号 (X.Y.Z)，直接返回
  if (parts.length === 3) {
    return version
  }

  // 对于两位版本号（如 "7.4"），先尝试精确匹配两位键，再回退到主版本号
  if (parts.length === 2) {
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
    // 回退到主版本号，获取最新的补丁版本
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  // 未知版本格式 — 记录日志并原样返回
  // 如果该版本在 hostdb 中不存在，可能导致下载失败
  logDebug(
    `Redis 版本 '${version}' 不在版本映射表中，可能在 hostdb 中不可用`,
  )
  return version
}