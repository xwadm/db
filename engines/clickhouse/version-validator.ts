/**
 * ClickHouse 版本验证工具
 * 处理版本解析、比较和兼容性检查
 *
 * ClickHouse 使用 YY.MM.X.build 版本格式（例如 25.12.3.21）
 * - YY: 年份（2位数）
 * - MM: 月份
 * - X: 补丁号
 * - build: 构建号
 */

/**
 * 将 ClickHouse 版本字符串解析为各个组成部分
 * 支持格式如 "25.12.3.21"、"25.12.3"、"25.12"、"v25.12.3.21"
 */
export function parseVersion(versionString: string): {
  year: number
  month: number
  patch: number
  build: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 2) return null

  const year = parseInt(parts[0], 10)
  const month = parseInt(parts[1], 10)
  const patch = parts[2] ? parseInt(parts[2], 10) : 0
  const build = parts[3] ? parseInt(parts[3], 10) : 0

  if (isNaN(year) || isNaN(month)) return null
  if (parts[2] && isNaN(patch)) return null
  if (parts[3] && isNaN(build)) return null

  return { year, month, patch, build, raw: cleaned }
}

/**
 * 检查 ClickHouse 版本是否受 SpinDB 支持
 * 最低支持版本：24.1.0.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // 支持 ClickHouse 24.x 及更高版本
  return parsed.year >= 24
}

/**
 * 从完整版本字符串中获取主版本号（YY.MM 格式）
 * 例如："25.12.3.21" -> "25.12"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.year}.${parsed.month}`
}

/**
 * 从完整版本字符串中获取主版本.次版本.补丁版本
 * 例如："25.12.3.21" -> "25.12.3"
 */
export function getMajorMinorPatchVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.year}.${parsed.month}.${parsed.patch}`
}

/**
 * 比较两个 ClickHouse 版本
 * 返回：-1 如果 a < b，0 如果 a == b，1 如果 a > b，如果任一版本无法解析则返回 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return null
  }

  if (parsedA.year !== parsedB.year) {
    return parsedA.year < parsedB.year ? -1 : 1
  }
  if (parsedA.month !== parsedB.month) {
    return parsedA.month < parsedB.month ? -1 : 1
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1
  }
  if (parsedA.build !== parsedB.build) {
    return parsedA.build < parsedB.build ? -1 : 1
  }
  return 0
}

/**
 * 检查备份版本与还原版本是否兼容
 * ClickHouse 备份通常具有前向兼容性
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
      warning: '无法解析版本信息，将继续进行还原',
    }
  }

  // 不能从新太多的版本还原备份
  // 计算总月份数以正确处理年份边界
  const backupMonths = backup.year * 12 + backup.month
  const restoreMonths = restore.year * 12 + restore.month

  if (backupMonths > restoreMonths + 6) {
    // 比还原服务器版本新超过6个月
    return {
      compatible: false,
      warning: `无法将 ClickHouse ${backupVersion} 的备份还原到 ${restoreVersion} 服务器。备份来自一个远新于当前服务器的版本。`,
    }
  }

  // 允许相同或相近版本
  if (backupMonths === restoreMonths) {
    return { compatible: true }
  }

  // 允许从旧版本升级
  if (restoreMonths > backupMonths) {
    return {
      compatible: true,
      warning: `正在将 ClickHouse ${backupVersion} 的备份还原到 ${restoreVersion} 服务器。表结构可能需要更新。`,
    }
  }

  // 还原到稍旧的版本（6个月内）
  return {
    compatible: true,
    warning: `正在将 ClickHouse ${backupVersion} 的备份还原到较旧的 ${restoreVersion} 服务器。某些功能可能不可用。`,
  }
}

// 验证版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
