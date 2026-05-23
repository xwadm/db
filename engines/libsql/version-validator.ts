/**
 * libSQL 版本验证工具
 * 处理版本解析、比较和兼容性检查
 */

/**
 * 将 libSQL 版本字符串解析为各个组成部分
 * 支持 "0.24.32"、"0.24"、"v0.24.32" 等格式
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  if (!cleaned) return null

  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null

  const major = Number(match[1])
  const minor = match[2] ? Number(match[2]) : 0
  const patch = match[3] ? Number(match[3]) : 0

  return { major, minor, patch, raw: cleaned }
}

/**
 * 检查 libSQL 版本是否受 SpinDB 支持
 * 最低支持版本：0.24.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // 支持 0.24 及以上版本
  if (parsed.major === 0) {
    return parsed.minor >= 24
  }
  return parsed.major >= 1
}

/**
 * 从完整版本字符串中提取主版本号
 * 例如 "0.24.32" -> "0"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * 从完整版本字符串中提取主版本号.次版本号
 * 例如 "0.24.32" -> "0.24"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * 比较两个 libSQL 版本
 * 返回值：若 a < b 则返回 -1，若 a == b 则返回 0，若 a > b 则返回 1，若任一版本无法解析则返回 null
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
 * libSQL 备份在同一主版本内通常兼容
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
      warning: '无法解析版本信息，将继续进行恢复',
    }
  }

  // 无法将较新的备份恢复到较旧的服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 libSQL ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。备份来自更新的主版本。`,
    }
  }

  // 允许相同的主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // 允许从较旧的主版本升级（restore.major > backup.major）
  return {
    compatible: true,
    warning: `正在将 libSQL ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。libSQL 将在下次保存时升级数据格式。`,
  }
}

/**
 * 验证版本字符串是否符合支持的格式
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
