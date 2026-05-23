/**
 * DuckDB 版本校验器
 *
 * 负责 DuckDB 的版本解析、校验和兼容性检查。
 */

import { DUCKDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  full: string
}

/**
 * 将版本字符串解析为各组成部分。
 *
 * @param version - 版本字符串（如 '1.4.3'、'1.4'、'1'）
 * @returns 解析后的版本对象，若无效则返回 null
 */
export function parseVersion(version: string): ParsedVersion | null {
  const parts = version.split('.')

  if (parts.length < 1 || parts.length > 3) {
    return null
  }

  const major = parseInt(parts[0], 10)
  const minor = parts.length >= 2 ? parseInt(parts[1], 10) : 0
  const patch = parts.length >= 3 ? parseInt(parts[2], 10) : 0

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null
  }

  return {
    major,
    minor,
    patch,
    full: `${major}.${minor}.${patch}`,
  }
}

/**
 * 检查某个版本是否受 SpinDB 支持。
 *
 * @param version - 待检查的版本字符串
 * @returns 若该版本受支持则返回 true
 */
export function isVersionSupported(version: string): boolean {
  // 直接检查版本映射表中是否存在
  if (DUCKDB_VERSION_MAP[version]) {
    return true
  }

  // 检查主版本号是否受支持
  const parsed = parseVersion(version)
  if (!parsed) {
    return false
  }

  return SUPPORTED_MAJOR_VERSIONS.includes(String(parsed.major))
}

/**
 * 从版本字符串中提取主版本号。
 *
 * @param version - 版本字符串（如 '1.4.3'）
 * @returns 主版本号字符串（如 '1'），无效则返回 null
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) {
    return null
  }
  return String(parsed.major)
}