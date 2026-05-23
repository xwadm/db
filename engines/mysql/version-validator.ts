/**
 * MySQL/MariaDB 版本验证器
 *
 * 验证 mysql 客户端版本与转储文件版本的兼容性。
 * MySQL 通常比 PostgreSQL 更宽松，但仍需对以下情况发出警告：
 * - MariaDB 转储恢复到 MySQL（反之亦然）
 * - 较新的转储恢复到较旧的客户端
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  SpinDBError,
  ErrorCodes,
  logWarning,
  logDebug,
} from '../../core/error-handler'
import { getMysqlClientPath } from './binary-detection'

const execAsync = promisify(exec)

// =============================================================================
// 类型定义
// =============================================================================

export type VersionInfo = {
  major: number
  minor: number
  patch: number
  full: string
}

export type MySQLVariant = 'mysql' | 'mariadb' | 'unknown'

export type DumpInfo = {
  version: VersionInfo | null
  variant: MySQLVariant
  serverVersion?: string
}

export type CompatibilityResult = {
  compatible: boolean
  dumpInfo: DumpInfo
  toolVersion: VersionInfo
  toolVariant: MySQLVariant
  warning?: string
  error?: string
}

// =============================================================================
// 版本解析
// =============================================================================

/**
 * 从 mysql --version 输出中解析版本信息
 * 示例：
 *   "mysql  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)"
 *   "mysql  Ver 14.14 Distrib 5.7.44, for Linux (x86_64)"（MySQL 5.7）
 *   "mysql  Ver 15.1 Distrib 10.11.6-MariaDB, for osx10.19 (arm64)"
 *   "mysql from 11.4.3-MariaDB, client 15.2 for osx10.20 (arm64)"
 */
export function parseToolVersion(output: string): {
  version: VersionInfo
  variant: MySQLVariant
} {
  // 检查是否为 MariaDB——字符串中必须显式包含 "mariadb"
  // 注意：MySQL 5.7 和 MariaDB 都使用 "Distrib"，但仅 MariaDB 包含 "-MariaDB"
  const isMariaDB = output.toLowerCase().includes('mariadb')

  let match: RegExpMatchArray | null = null

  if (isMariaDB) {
    // MariaDB："Distrib 10.11.6-MariaDB" 或 "from 11.4.3-MariaDB"
    match = output.match(/(?:Distrib|from)\s+(\d+)\.(\d+)\.(\d+)/)
  }

  if (!match) {
    // 带 Distrib 的 MySQL："Distrib 5.7.44"（MySQL 5.7 风格）
    match = output.match(/Distrib\s+(\d+)\.(\d+)\.(\d+)/)
  }

  if (!match) {
    // MySQL："Ver 8.0.35"
    match = output.match(/Ver\s+(\d+)\.(\d+)(?:\.(\d+))?/)
  }

  if (!match) {
    // 通用回退
    match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  }

  if (!match) {
    throw new Error(`无法从以下内容解析版本：${output}`)
  }

  return {
    version: {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3] || '0', 10),
      full: match[0].replace(/^(Ver|Distrib|from)\s+/, ''),
    },
    variant: isMariaDB ? 'mariadb' : 'mysql',
  }
}

// 读取文件的前 N 行
async function readFirstLines(
  filePath: string,
  lineCount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream })

    rl.on('line', (line) => {
      lines.push(line)
      if (lines.length >= lineCount) {
        rl.close()
        stream.destroy()
      }
    })

    rl.on('close', () => {
      resolve(lines.join('\n'))
    })

    rl.on('error', reject)
    stream.on('error', reject)
  })
}

/**
 * 从转储文件头部解析版本信息
 *
 * MySQL 转储头部：
 *   -- MySQL dump 10.13  Distrib 8.0.35, for macos14.0 (arm64)
 *   -- Server version   8.0.35
 *
 * MariaDB 转储头部：
 *   -- MariaDB dump 10.19-11.4.3-MariaDB, for osx10.20 (arm64)
 *   -- Server version   11.4.3-MariaDB
 */
export async function parseDumpVersion(dumpPath: string): Promise<DumpInfo> {
  try {
    const header = await readFirstLines(dumpPath, 30)

    // 检测数据库变体
    let variant: MySQLVariant = 'unknown'
    if (header.includes('MariaDB dump') || header.includes('-MariaDB')) {
      variant = 'mariadb'
    } else if (header.includes('MySQL dump')) {
      variant = 'mysql'
    }

    // 尝试获取服务器版本（比转储工具版本更准确）
    // "-- Server version   8.0.35" 或 "-- Server version   11.4.3-MariaDB"
    const serverMatch = header.match(
      /--\s*Server version\s+(\d+)\.(\d+)(?:\.(\d+))?/,
    )
    if (serverMatch) {
      return {
        version: {
          major: parseInt(serverMatch[1], 10),
          minor: parseInt(serverMatch[2], 10),
          patch: parseInt(serverMatch[3] || '0', 10),
          full: `${serverMatch[1]}.${serverMatch[2]}${serverMatch[3] ? `.${serverMatch[3]}` : ''}`,
        },
        variant,
        serverVersion: header.match(/--\s*Server version\s+([^\n]+)/)?.[1],
      }
    }

    // 回退到头部的 Distrib 版本
    // "Distrib 8.0.35" 或 "10.19-11.4.3-MariaDB"
    let distribMatch = header.match(/Distrib\s+(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!distribMatch && variant === 'mariadb') {
      // MariaDB 格式："dump 10.19-11.4.3-MariaDB"
      distribMatch = header.match(/dump\s+[\d.]+-(\d+)\.(\d+)\.(\d+)/)
    }

    if (distribMatch) {
      return {
        version: {
          major: parseInt(distribMatch[1], 10),
          minor: parseInt(distribMatch[2], 10),
          patch: parseInt(distribMatch[3] || '0', 10),
          full: `${distribMatch[1]}.${distribMatch[2]}${distribMatch[3] ? `.${distribMatch[3]}` : ''}`,
        },
        variant,
      }
    }

    return { version: null, variant }
  } catch (error) {
    logDebug('解析转储文件版本失败', {
      dumpPath,
      error: error instanceof Error ? error.message : String(error),
    })
    return { version: null, variant: 'unknown' }
  }
}

// 获取 mysql 客户端的版本
export async function getMysqlClientVersion(): Promise<{
  version: VersionInfo
  variant: MySQLVariant
}> {
  const mysqlPath = await getMysqlClientPath()
  if (!mysqlPath) {
    throw new Error('未找到 mysql 客户端')
  }

  const { stdout } = await execAsync(`"${mysqlPath}" --version`)
  return parseToolVersion(stdout)
}

// =============================================================================
// 兼容性检查
// =============================================================================

/**
 * 检查版本兼容性
 *
 * MySQL/MariaDB 兼容性矩阵：
 * | 场景 | 结果 |
 * |----------|--------|
 * | MySQL 8 客户端 + MySQL 8 转储 | ✅ 正常 |
 * | MySQL 8 客户端 + MySQL 5.7 转储 | ✅ 正常（向下兼容） |
 * | MySQL 5.7 客户端 + MySQL 8 转储 | ⚠️ 可能有问题 |
 * | MariaDB 客户端 + MySQL 转储 | ⚠️ 警告（大部分兼容） |
 * | MySQL 客户端 + MariaDB 转储 | ⚠️ 警告（大部分兼容） |
 */
export function checkVersionCompatibility(
  dumpInfo: DumpInfo,
  toolVersion: VersionInfo,
  toolVariant: MySQLVariant,
): CompatibilityResult {
  const result: CompatibilityResult = {
    compatible: true,
    dumpInfo,
    toolVersion,
    toolVariant,
  }

  // 若无法解析转储版本，发出警告后继续
  if (!dumpInfo.version) {
    result.warning = '无法检测转储文件版本，仍将继续尝试恢复。'
    return result
  }

  // 检查数据库变体不匹配（MySQL vs MariaDB）
  if (
    dumpInfo.variant !== 'unknown' &&
    toolVariant !== 'unknown' &&
    dumpInfo.variant !== toolVariant
  ) {
    result.warning =
      `转储文件由 ${dumpInfo.variant === 'mariadb' ? 'MariaDB' : 'MySQL'} 创建，` +
      `但当前使用 ${toolVariant === 'mariadb' ? 'MariaDB' : 'MySQL'} 恢复。` +
      `通常可以正常工作，但部分功能可能不兼容。`
    return result
  }

  // MySQL 8 引入了重大变更
  // 用 MySQL 5.x 客户端恢复 MySQL 8+ 转储可能失败
  if (dumpInfo.version.major >= 8 && toolVersion.major < 8) {
    result.compatible = false
    result.error =
      `转储文件由 MySQL ${dumpInfo.version.major} 创建，` +
      `但您的 mysql 客户端版本为 ${toolVersion.major}。` +
      `MySQL 8 转储可能包含旧版客户端不支持的语法。`
    return result
  }

  // MariaDB 10.x 恢复到 MySQL 时，部分特定功能可能有问题
  if (
    dumpInfo.variant === 'mariadb' &&
    toolVariant === 'mysql' &&
    dumpInfo.version.major >= 10
  ) {
    result.warning =
      `转储文件由 MariaDB ${dumpInfo.version.full} 创建。` +
      `部分 MariaDB 特有功能可能无法正确恢复到 MySQL。`
    return result
  }

  // 若转储文件版本比工具版本更新，发出警告（任意变体）
  if (dumpInfo.version.major > toolVersion.major) {
    result.warning =
      `转储文件版本为 ${dumpInfo.version.full}，` +
      `但您的客户端版本为 ${toolVersion.full}。` +
      `部分功能可能无法正确恢复。`
    return result
  }

  // 若转储文件版本过旧（5 年以上），发出警告
  if (
    dumpInfo.version.major < 5 ||
    (dumpInfo.version.major === 5 && dumpInfo.version.minor < 7)
  ) {
    result.warning =
      `转储文件由 MySQL ${dumpInfo.version.full} 创建。` +
      `这是一个非常旧的版本，部分数据类型可能无法正确导入。`
    return result
  }

  return result
}

// =============================================================================
// 主验证函数
// =============================================================================

/**
 * 验证转储文件是否可用当前 mysql 客户端恢复
 *
 * @throws SpinDBError 若版本不兼容
 */
export async function validateRestoreCompatibility(options: {
  dumpPath: string
}): Promise<{
  dumpInfo: DumpInfo
  toolVersion: VersionInfo
  toolVariant: MySQLVariant
}> {
  const { dumpPath } = options

  // 获取工具版本
  const { version: toolVersion, variant: toolVariant } =
    await getMysqlClientVersion()
  logDebug('检测到 mysql 客户端版本', {
    version: toolVersion.full,
    variant: toolVariant,
  })

  // 获取转储文件版本
  const dumpInfo = await parseDumpVersion(dumpPath)
  if (dumpInfo.version) {
    logDebug('检测到转储文件版本', {
      version: dumpInfo.version.full,
      variant: dumpInfo.variant,
    })
  } else {
    logDebug('无法检测转储文件版本')
  }

  // 检查兼容性
  const result = checkVersionCompatibility(dumpInfo, toolVersion, toolVariant)

  if (!result.compatible) {
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      result.error!,
      'fatal',
      '请安装更新版本的 MySQL 客户端工具',
      { dumpInfo, toolVersion, toolVariant },
    )
  }

  if (result.warning) {
    logWarning(result.warning)
  }

  return { dumpInfo, toolVersion, toolVariant }
}