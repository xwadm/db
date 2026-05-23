/**
 * QuestDB 版本验证器
 *
 * 提供版本解析、验证和比较工具函数。
 */

import { SUPPORTED_MAJOR_VERSIONS, QUESTDB_VERSION_MAP } from './version-maps'

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  full: string
}

/**
 * 将版本字符串解析为各组成部分
 * @param version 版本字符串（例如 '9.2.3'、'9.2'、'9'）
 * @returns 解析后的版本信息，无效时返回 null
 */
export function parseVersion(version: string): ParsedVersion | null {
  // 匹配版本模式: 9.2.3、9.2、9
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null

  const major = parseInt(match[1], 10)
  const minor = match[2] ? parseInt(match[2], 10) : 0
  const patch = match[3] ? parseInt(match[3], 10) : 0

  return {
    major,
    minor,
    patch,
    full: `${major}.${minor}.${patch}`,
  }
}

/**
 * 检查版本是否受支持
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  const majorStr = String(parsed.major)
  return SUPPORTED_MAJOR_VERSIONS.includes(majorStr)
}

/**
 * 从版本字符串中获取主版本号
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) return null
  return String(parsed.major)
}

/**
 * 比较两个版本
 * @returns -1 表示 a < b，0 表示 a == b，1 表示 a > b
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    // 解析失败时回退到字符串比较
    return a.localeCompare(b)
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor
  }
  return parsedA.patch - parsedB.patch
}

/**
 * 检查两个版本是否兼容（用于备份/恢复）
 * QuestDB 允许恢复到相同或更新的主版本
 */
export function isVersionCompatible(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  const sourceMajor = getMajorVersion(sourceVersion)
  const targetMajor = getMajorVersion(targetVersion)

  if (!sourceMajor || !targetMajor) return false

  // 相同主版本始终兼容
  if (sourceMajor === targetMajor) return true

  // 目标主版本必须 >= 源主版本
  return parseInt(targetMajor, 10) >= parseInt(sourceMajor, 10)
}

/**
 * 将版本别名解析为完整版本号
 */
export function resolveVersion(version: string): string {
  // 检查是否已是映射中的完整版本
  if (QUESTDB_VERSION_MAP[version]) {
    return QUESTDB_VERSION_MAP[version]
  }

  // 如果已经是完整版本格式，直接返回
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version
  }

  // 尝试通过主版本号查找
  const majorVersion = getMajorVersion(version)
  if (majorVersion && QUESTDB_VERSION_MAP[majorVersion]) {
    return QUESTDB_VERSION_MAP[majorVersion]
  }

  return version
}
