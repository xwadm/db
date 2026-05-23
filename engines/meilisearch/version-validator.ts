/**
 * Meilisearch 版本校验工具
 * 处理版本解析、比较和兼容性检查
 */

/**
 * 将 Meilisearch 版本字符串解析为各组成部分
 * 支持 "1.33.1"、"1.33"、"v1.33.1" 等格式
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 1) return null

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major)) return null
  if (parts[1] && isNaN(minor)) return null
  if (parts[2] && isNaN(patch)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * 检查某个 Meilisearch 版本是否受 SpinDB 支持
 * 最低支持版本: 1.0.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 1
}

/**
 * 从完整版本字符串中提取主版本号
 * 示例: "1.33.1" -> "1"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * 从完整版本字符串中提取 major.minor 版本号
 * 示例: "1.33.1" -> "1.33"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * 比较两个 Meilisearch 版本
 * 返回值: a < b 为 -1，a == b 为 0，a > b 为 1，任一版本无法解析则为 null
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
 * 检查备份版本与恢复目标版本是否兼容
 * Meilisearch 快照在同一主版本内通常是向前兼容的
 */
export function isVersionCompatible(
  backupVersion: string,
  restoreVersion: string,
): { compatible: boolean; warning?: string } {
  const backup = parseVersion(backupVersion)
  const restore = parseVersion(restoreVersion)

  if (!backup || !restore) {
    return {
      compatible: true,
      warning: '无法解析版本号，继续执行恢复',
    }
  }

  // 不能将较新版本的快照恢复到较旧版本的服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 Meilisearch ${backupVersion} 快照恢复到 ${restoreVersion} 服务器。备份来自更高的主版本。`,
    }
  }

  // 允许相同主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // 允许从旧版主版本升级（restore.major > backup.major）
  return {
    compatible: true,
    warning: `正在将 Meilisearch ${backupVersion} 快照恢复到 ${restoreVersion} 服务器。Meilisearch 将在下次保存时升级快照格式。`,
  }
}

// 校验版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}