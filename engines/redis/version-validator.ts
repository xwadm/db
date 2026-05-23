/**
 * Redis 版本验证工具模块
 *
 * 用于解析、验证和比较 Redis 版本号。包含版本号解析、
 * 支持状态检查、版本比较和兼容性判断等功能。
 *
 * 版本格式: "8.4.0"
 * - 主版本号 (8)
 * - 次版本号 (4)
 * - 修订号 (0)
 */

export interface RedisVersion {
  major: number
  minor: number
  patch: number
  raw: string
}

/**
 * 将版本字符串解析为一个结构化的 RedisVersion 对象
 *
 * @param version - 版本字符串，例如 "8.4.0" 或 "8"
 * @returns 包含 major、minor 和 patch 字段的 RedisVersion 对象
 * @throws 如果版本字符串无效则抛出错误
 *
 * @example
 * parseVersion("8.4.0")
 * // => { major: 8, minor: 4, patch: 0, raw: "8.4.0" }
 *
 * parseVersion("8")
 * // => { major: 8, minor: 0, patch: 0, raw: "8" }
 */
export function parseVersion(version: string): RedisVersion {
  const parts = version.split('.')
  if (parts.length === 0 || parts.length > 3) {
    throw new Error(
      `无效的版本字符串: "${version}"。版本号应类似于 "8.4.0"`,
    )
  }
  const major = parseInt(parts[0], 10)
  const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0
  const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw new Error(
      `无效的版本字符串: "${version}"。版本号各字段必须为数字。`,
    )
  }

  return { major, minor, patch, raw: version }
}

/**
 * 检查版本是否受支持
 *
 * @param version - 版本字符串
 * @param supportedVersions - 受支持的主版本号数组
 * @returns 如果版本受支持则返回 true
 */
export function isVersionSupported(
  version: string,
  supportedVersions: string[],
): boolean {
  try {
    const parsed = parseVersion(version)
    return supportedVersions.includes(String(parsed.major))
  } catch {
    return false
  }
}

/**
 * 比较两个 Redis 版本
 *
 * @returns
 * - 如果 v1 > v2，返回 1
 * - 如果 v1 < v2，返回 -1
 * - 如果 v1 === v2，返回 0
 *
 * @throws 如果任一版本无效则抛出错误
 *
 * @example
 * compareVersions("8.4.0", "8.3.0") // => 1
 * compareVersions("8.0.0", "8.0.1") // => -1
 * compareVersions("8.4.0", "8.4.0") // => 0
 */
export function compareVersions(v1: string, v2: string): number {
  const a = parseVersion(v1)
  const b = parseVersion(v2)
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/**
 * 检查两个版本是否兼容（同一主版本号）
 *
 * @example
 * isVersionCompatible("8.4.0", "8.3.5") // => true
 * isVersionCompatible("8.4.0", "7.4.7") // => false
 */
export function isVersionCompatible(v1: string, v2: string): boolean {
  try {
    const a = parseVersion(v1)
    const b = parseVersion(v2)
    return a.major === b.major
  } catch {
    return false
  }
}