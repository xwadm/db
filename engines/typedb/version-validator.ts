/**
 * TypeDB 版本校验工具
 * 处理版本解析、比较和兼容性检查
 */

import { SUPPORTED_MAJOR_VERSIONS } from './version-maps'

/**
 * 将 TypeDB 版本字符串解析为各组成部分
 * 支持格式如 "3.8.0"、"3.8"、"v3.8.0"
 * 拒绝预发布后缀（如 "3.8.0-beta"）和多余分段（如 "3.8.0.1"）
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()

  // 拒绝带有预发布后缀或元数据的版本
  if (/[-+]/.test(cleaned)) return null

  const parts = cleaned.split('.')

  // 仅允许 1-3 个分段（主版本、主.次、主.次.补丁）
  if (parts.length > 3) return null

  // 拒绝非纯数字的分段（如 "3b"、"8rc1"）
  if (parts.some((p) => !/^\d+$/.test(p))) return null

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  return { major, minor, patch, raw: cleaned }
}

/**
 * 检查 TypeDB 版本是否受 SpinDB 支持
 * 最低支持版本：3.0.0（v3 是 Rust 重写版）
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return SUPPORTED_MAJOR_VERSIONS.includes(String(parsed.major))
}

/**
 * 从完整版本字符串中获取主版本号
 * 例如 "3.8.0" -> "3"
 * 如果版本字符串无法解析则返回 null。
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : null
}

/**
 * 比较两个 TypeDB 版本
 * 返回：若 a < b 则 -1，若 a == b 则 0，若 a > b 则 1，若任一版本无法解析则 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return null
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1
  }
  return 0
}

/**
 * 检查备份版本与恢复版本是否兼容
 * TypeDB 备份通常在主版本内兼容
 */
export function isVersionCompatible(
  backupVersion: string,
  restoreVersion: string,
): { compatible: boolean; warning?: string } {
  const backup = parseVersion(backupVersion)
  const restore = parseVersion(restoreVersion)

  if (!backup || !restore) {
    return {
      compatible: false,
      warning:
        '无法解析版本号，没有有效版本信息时拒绝继续操作',
    }
  }

  // 不能将较新备份恢复到较旧服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 TypeDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。备份来自更新的主版本。`,
    }
  }

  // 允许相同主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // TypeDB 禁止跨主版本恢复（主版本之间格式不兼容）
  return {
    compatible: false,
    warning: `无法将 TypeDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。不支持跨主版本恢复。请使用 TypeDB 导出/导入进行版本迁移。`,
  }
}

// 验证版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
