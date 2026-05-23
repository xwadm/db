/**
 * TigerBeetle 版本验证工具
 * 处理版本解析、比较和兼容性检查
 */

/**
 * 将 TigerBeetle 版本字符串解析为各个组成部分
 * 支持 "0.16.70"、"0.16"、"v0.16.70" 等格式
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  if (!cleaned) return null

  const parts = cleaned.split('.')

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major)) return null
  if (parts[1] && isNaN(minor)) return null
  if (parts[2] && isNaN(patch)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * 检查 TigerBeetle 版本是否受 SpinDB 支持
 * 最低支持版本：0.16.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // 支持 0.16 及以上版本
  if (parsed.major === 0) {
    return parsed.minor >= 16
  }
  return parsed.major >= 1
}

/**
 * 从完整版本字符串中获取主版本号（两段式 xy 格式）
 * 例如 "0.16.70" -> "0.16"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * 从完整版本字符串中获取主版本号.次版本号。
 * 这是 getMajorVersion 的有意别名——两者都返回两段式 xy 格式
 * 版本（例如 "0.16"）。作为独立导出保留，以保持与其他引擎
 * 版本验证器的 API 一致性。
 */
export function getMajorMinorVersion(version: string): string {
  return getMajorVersion(version)
}

/**
 * 比较两个 TigerBeetle 版本
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
 * TigerBeetle 数据文件在次版本内通常兼容
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

  // TigerBeetle 要求主版本号.次版本号必须完全一致
  if (backup.major !== restore.major || backup.minor !== restore.minor) {
    return {
      compatible: false,
      warning: `无法将 TigerBeetle ${backupVersion} 数据恢复到 ${restoreVersion} 服务器。主版本号和次版本号必须一致。`,
    }
  }

  return { compatible: true }
}

/**
 * 验证版本字符串是否符合支持的格式
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
