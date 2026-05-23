// MongoDB 版本验证与兼容性检查

import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'

/**
 * 将版本字符串解析为各组成部分
 * 支持格式如 "8.0.4"、"8.0"、"v8.0.4"
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 2) return null

  const major = parseInt(parts[0], 10)
  const minor = parseInt(parts[1], 10)
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major) || isNaN(minor)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * 比较两个版本
 * 返回值：-1 表示 a < b，0 表示 a == b，1 表示 a > b，null 表示任一版本无法解析
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
 * 检查备份版本是否与目标恢复版本兼容
 * MongoDB 允许从旧版本恢复到新版本，但不允许反向操作
 *
 * 兼容场景：
 * - 相同的 major.minor 版本（例如 8.0.2 -> 8.0.4）
 * - 相差一个大版本（例如 7.0.x -> 8.0.x）
 *
 * 不兼容场景：
 * - 将较新的备份恢复到较旧的服务器
 * - 相差超过一个大版本
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
      warning: '无法解析版本号，将继续执行恢复操作',
    }
  }

  // 不能将较新版本的备份恢复到较旧版本的服务器
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `无法将 MongoDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。备份来自更新的主版本。`,
    }
  }

  // 允许相同主版本
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // 允许一个主版本的升级（例如 7.0 -> 8.0）
  if (restore.major - backup.major === 1) {
    return {
      compatible: true,
      warning: `正在将 MongoDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。恢复后建议执行数据库升级流程。`,
    }
  }

  // 相差超过一个大版本
  return {
    compatible: false,
    warning: `无法将 MongoDB ${backupVersion} 备份恢复到 ${restoreVersion} 服务器。版本差距过大。`,
  }
}

/**
 * 从 mongodump 目录中提取版本信息
 * mongodump 会生成包含版本信息的 metadata.json 文件
 */
export async function extractVersionFromDump(
  dumpPath: string,
): Promise<string | null> {
  try {
    // 检查是否为目录形式的备份
    if (!existsSync(dumpPath)) {
      return null
    }

    // 查找 oplog.bson 或任何 .metadata.json 文件
    const files = readdirSync(dumpPath, { recursive: true }) as string[]

    for (const file of files) {
      if (file.endsWith('.metadata.json')) {
        const metadataPath = join(dumpPath, file)
        const content = await readFile(metadataPath, 'utf8')
        const metadata = JSON.parse(content)

        // 在元数据中查找版本信息
        if (metadata.version) {
          return metadata.version
        }
      }
    }

    return null
  } catch (error) {
    logDebug(`从备份中提取版本信息失败：${error}`)
    return null
  }
}

/**
 * 从完整版本字符串中获取 major.minor 版本
 * 例如："8.0.4" -> "8.0"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

// 验证版本字符串是否符合支持的格式
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
