/**
 * InfluxDB 版本验证工具
 * 处理版本解析、比较和兼容性检查
 */

/**
 * 将 InfluxDB 版本字符串解析为各组成部分
 * 支持的格式："3.8.0"、"3.8"、"v3.8.0"
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
 * 检查 InfluxDB 版本是否受 SpinDB 支持
 * 最低支持版本：3.0.0（InfluxDB 3.x 是 Rust 重写版本）
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 3
}

/**
 * 从完整版本字符串获取主版本号
 * 例如："3.8.0" -> "3"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * 从完整版本字符串获取主版本号.次版本号
 * 例如："3.8.0" -> "3.8"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * 比较两个 InfluxDB 版本
 * 返回值：-1 表示 a < b，0 表示 a == b，1 表示 a > b，若任一版本无法解析则返回 null
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
 * 检查备份版本是否与恢复版本兼容
 * InfluxDB 3.x 备份在同一主版本内通常兼容
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
      warning: '无法解析版本号，将继续执行恢复',
    }
  }

  // 不能将较新版本的备份恢复到较旧版本的服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 InfluxDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。备份来自更新的主版本。`,
    }
  }

  // 允许相同主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // 允许从较旧的主版本升级
  return {
    compatible: true,
    warning: `正在将 InfluxDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。数据格式可能会被升级。`,
  }
}

// 验证版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
