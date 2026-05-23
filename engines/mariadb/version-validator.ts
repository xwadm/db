/**
 * MariaDB 版本验证器
 *
 * 验证 MariaDB 转储文件和数据库的版本兼容性。
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { open } from 'fs/promises'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

// 将版本字符串解析为各组成部分
export function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
  full: string
} {
  const parts = version.split('.').map(Number)
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    full: version,
  }
}

// 从转储文件头部提取 MariaDB 版本
export async function extractDumpVersion(
  dumpPath: string,
): Promise<{ version: string; isMariaDB: boolean } | null> {
  try {
    const file = await open(dumpPath, 'r')
    const buffer = Buffer.alloc(2048)
    await file.read(buffer, 0, 2048, 0)
    await file.close()

    const header = buffer.toString('utf8')

    // 查找 MariaDB 转储头部
    // 示例："-- MariaDB dump 10.19  Distrib 11.8.5-MariaDB"
    const mariadbMatch = header.match(
      /MariaDB dump \S+\s+Distrib (\d+\.\d+\.\d+)/,
    )
    if (mariadbMatch) {
      return { version: mariadbMatch[1], isMariaDB: true }
    }

    // 查找 MySQL 转储头部（MariaDB 转储有时显示为 MySQL）
    // 示例："-- MySQL dump 10.19  Distrib 11.8.5-MariaDB"
    const mysqlMatch = header.match(/MySQL dump \S+\s+Distrib (\d+\.\d+\.\d+)/)
    if (mysqlMatch) {
      // 检查是否实际为 MariaDB
      const isMariaDB = header.includes('MariaDB')
      return { version: mysqlMatch[1], isMariaDB }
    }

    // 尝试服务器版本注释
    // 示例："-- Server version: 11.8.5-MariaDB"
    const serverMatch = header.match(/Server version:\s+(\d+\.\d+\.\d+)/)
    if (serverMatch) {
      const isMariaDB = header.includes('MariaDB')
      return { version: serverMatch[1], isMariaDB }
    }

    return null
  } catch (error) {
    logDebug('提取转储版本失败', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// 获取已安装的 MariaDB 服务器版本
export async function getInstalledVersion(
  binaryPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    // 解析类似 "mariadbd  Ver 11.8.5-MariaDB" 的输出
    const match = stdout.match(/Ver\s+(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

// 获取已安装的 mysql 客户端版本
export async function getMysqlClientVersion(
  binaryPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    // 解析类似 "mysql  Ver 15.1 Distrib 11.8.5-MariaDB" 的输出
    const match = stdout.match(/Distrib (\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

// 转储兼容性验证选项
export type ValidateOptions = {
  dumpPath: string
  targetVersion?: string
  strict?: boolean
}

/**
 * 验证转储文件与目标 MariaDB 版本的兼容性
 *
 * MariaDB 在主版本内通常向后兼容。
 */
export async function validateRestoreCompatibility(
  options: ValidateOptions,
): Promise<{ compatible: boolean; warning?: string }> {
  const { dumpPath, targetVersion, strict = false } = options

  const dumpInfo = await extractDumpVersion(dumpPath)

  if (!dumpInfo) {
    // 无法确定版本 - 允许恢复并发出警告
    return {
      compatible: true,
      warning: '无法确定转储版本。仍然继续执行。',
    }
  }

  // 如果未指定目标版本，仅验证转储文件是否可读
  if (!targetVersion) {
    return { compatible: true }
  }

  const dumpVer = parseVersion(dumpInfo.version)
  const targetVer = parseVersion(targetVersion)

  // MariaDB 向后兼容 - 新版本可以恢复旧版本的转储
  if (targetVer.major > dumpVer.major) {
    return { compatible: true }
  }

  // 相同主版本 - 应该兼容
  if (targetVer.major === dumpVer.major) {
    if (targetVer.minor >= dumpVer.minor) {
      return { compatible: true }
    }
    // 从较新的次版本恢复到较旧的次版本
    if (strict) {
      return {
        compatible: false,
        warning: `转储来自 MariaDB ${dumpInfo.version}，但目标是 ${targetVersion}。较新的转储可能使用了旧版本中不可用的功能。`,
      }
    }
    return {
      compatible: true,
      warning: `转储来自 MariaDB ${dumpInfo.version}，但目标是 ${targetVersion}。这可能会成功，但某些功能可能不受支持。`,
    }
  }

  // 从较新的主版本恢复到较旧的主版本
  if (strict) {
    return {
      compatible: false,
      warning: `转储来自 MariaDB ${dumpInfo.version}，但目标是 ${targetVersion}。跨主版本恢复可能会失败。`,
    }
  }

  return {
    compatible: true,
    warning: `转储来自 MariaDB ${dumpInfo.version}，但目标是 ${targetVersion}。跨主版本恢复可能存在兼容性问题。`,
  }
}
