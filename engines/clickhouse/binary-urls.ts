import { CLICKHOUSE_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * hostdb 下载支持的平台标识符。
 * 注意：hostdb 上的 ClickHouse 目前不支持 Windows。
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
 * hostdb 使用标准平台命名，直接匹配 Node.js 标识符。
 * 此函数验证平台/架构组合是否受支持。
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
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * 构建从 hostdb 下载 ClickHouse 二进制文件的 URL
 *
 * 格式：https://registry.layerbase.host/clickhouse-{version}/clickhouse-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - ClickHouse 版本（例如 '25.12'、'25.12.3.21'）
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

  // 规范化版本（处理主版本查找）
  const fullVersion = normalizeVersion(version, CLICKHOUSE_VERSION_MAP)

  // hostdb 上的 ClickHouse 在所有平台上都使用 tar.gz（无 Windows 支持）
  return buildHostdbUrl(Engine.ClickHouse, {
    version: fullVersion,
    hostdbPlatform,
    extension: 'tar.gz',
  })
}

/**
 * 将版本字符串规范化为完整版本格式
 *
 * @param version - 版本字符串（例如 '25.12'、'25.12.3'、'25.12.3.21'）
 * @param versionMap - 可选的版本映射表，用于版本查找
 * @returns 规范化后的版本（例如 '25.12.3.21'）
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = CLICKHOUSE_VERSION_MAP,
): string {
  // 检查是否为映射表中的精确键
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // 如果已经是完整版本（4 部分），直接返回
  if (parts.length === 4) {
    return version
  }

  // 对于部分版本，尝试查找匹配项
  if (parts.length === 3) {
    // 尝试 YY.MM.X 格式
    const threePart = `${parts[0]}.${parts[1]}.${parts[2]}`
    if (versionMap[threePart]) {
      return versionMap[threePart]
    }
  }

  if (parts.length === 2) {
    // 尝试 YY.MM 格式
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
  }

  // 未知版本格式 — 记录日志并原样返回
  logDebug(
    `ClickHouse 版本 '${version}' 不在版本映射表中，可能无法在 hostdb 中获得`,
  )
  return version
}

/**
 * 获取版本的完整版本字符串
 *
 * 支持部分版本查找（例如 '25.12' -> '25.12.3.21'），
 * 通过委托给 normalizeVersion 以实现一致的行为。
 *
 * @param version - 版本（例如 '25.12'、'25.12.3.21'）
 * @returns 完整版本字符串（例如 '25.12.3.21'），如果不在版本映射表中则返回 null
 */
