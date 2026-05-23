/**
 * Valkey 版本验证工具
 * 处理版本解析、比较和兼容性检查
 */

/**
 * 将 Valkey 版本字符串解析为组件
 * 支持 "8.0.6"、"8.0"、"v8.0.6" 等格式
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
 * 检查 Valkey 版本是否受 SpinDB 支持
 * 最低支持版本: 8.0.0
 * 支持 Valkey 8 和 9
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 8
}

/**
 * 从完整版本字符串中提取大版本号
 * 例如 "8.0.6" -> "8"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * 从完整版本字符串中提取主次版本号
 * 例如 "8.0.6" -> "8.0"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * 比较两个 Valkey 版本
 * 返回: -1 表示 a < b, 0 表示 a == b, 1 表示 a > b, null 表示任一版本无法解析
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
 * Valkey RDB 文件在同一大版本内通常是向前兼容的
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
      warning: '无法解析版本号，继续执行恢复操作',
    }
  }

  // 不能将较新的 RDB 恢复到较旧的服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 Valkey ${backupVersion} RDB 备份恢复到 ${restoreVersion} 服务器。备份来自较新的大版本。`,
    }
  }

  // 允许相同大版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // 允许从旧大版本升级（restore.major > backup.major）
  // 这是最后一个剩余情况，因为我们已经处理了: !backup || !restore,
  // backup.major > restore.major, 和 backup.major === restore.major
  return {
    compatible: true,
    warning: `正在将 Valkey ${backupVersion} RDB 备份恢复到 ${restoreVersion} 服务器。Valkey 将在下次保存时升级 RDB 格式。`,
  }
}

/**
 * 验证版本字符串格式是否有效
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}