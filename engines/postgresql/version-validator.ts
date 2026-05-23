/**
 * PostgreSQL 版本验证器
 *
 * 验证 pg_restore 工具版本与转储文件版本的兼容性。
 * PostgreSQL 具有向后兼容性 —— 仅当转储版本 > 工具版本时才会失败。
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
import {
  getBundledBinaryPath,
  findCompatibleVersion,
} from '../../core/pg-binary-resolver'
import {
  detectRemotePostgresVersion,
  type RemoteVersionResult,
} from './remote-version'

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

export type CompatibilityResult = {
  compatible: boolean
  dumpVersion: VersionInfo | null
  toolVersion: VersionInfo
  warning?: string
  error?: string
}

// =============================================================================
// 版本解析
// =============================================================================

/**
 * 从 pg_dump/pg_restore --version 输出中解析版本
 * 示例：
 *   "pg_restore (PostgreSQL) 16.1"
 *   "pg_restore (PostgreSQL) 14.9 (Homebrew)"
 *   "pg_dump (PostgreSQL) 17.0"
 */
export function parseToolVersion(output: string): VersionInfo {
  const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) {
    throw new Error(`无法从以下输出解析版本：${output}`)
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3] || '0', 10),
    full: match[0],
  }
}

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
 * 从转储文件头部解析版本
 *
 * 纯 SQL 格式："-- Dumped from database version 16.1"
 * 归档格式：使用 `pg_restore -l` 读取 TOC 头部
 */
export async function parseDumpVersion(
  dumpPath: string,
  format: string,
  pgRestorePath?: string,
): Promise<VersionInfo | null> {
  try {
    if (format === 'custom' || format === 'directory') {
      // 使用 pg_restore -l 获取归档信息
      const restorePath = pgRestorePath || 'pg_restore'
      const { stdout } = await execAsync(
        `"${restorePath}" -l "${dumpPath}" 2>&1 | head -20`,
      )
      // 查找："; Dumped from database version 16.1"
      const match = stdout.match(
        /Dumped from database version (\d+)\.(\d+)(?:\.(\d+))?/,
      )
      if (match) {
        return {
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3] || '0', 10),
          full: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
        }
      }
    } else {
      // 纯 SQL 格式 - 读取前 50 行
      const header = await readFirstLines(dumpPath, 50)
      const match = header.match(
        /Dumped from database version (\d+)\.(\d+)(?:\.(\d+))?/,
      )
      if (match) {
        return {
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3] || '0', 10),
          full: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
        }
      }
    }
  } catch (error) {
    logDebug('解析转储文件版本失败', {
      dumpPath,
      format,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return null // 未在转储文件中找到版本信息
}

// 获取 pg_restore 的版本
export async function getPgRestoreVersion(
  pgRestorePath: string,
): Promise<VersionInfo> {
  const { stdout } = await execAsync(`"${pgRestorePath}" --version`)
  return parseToolVersion(stdout)
}

// =============================================================================
// 兼容性检查
// =============================================================================

/**
 * 检查版本兼容性 - 仅当转储文件比工具更新时才失败
 *
 * | 场景 | 结果 |
 * |----------|--------|
 * | pg_restore v16 + 来自 v14 的转储 | ✅ 可用（向后兼容） |
 * | pg_restore v16 + 来自 v16 的转储 | ✅ 可用（同版本） |
 * | pg_restore v14 + 来自 v16 的转储 | ❌ 失败（转储比工具更新） |
 * | pg_restore v16 + 来自 v10 的转储 | ⚠️ 可用但有警告（版本过旧） |
 */
export function checkVersionCompatibility(
  dumpVersion: VersionInfo | null,
  toolVersion: VersionInfo,
): CompatibilityResult {
  // 如果无法解析转储文件版本，发出警告后继续
  if (!dumpVersion) {
    return {
      compatible: true,
      dumpVersion: null,
      toolVersion,
      warning: '无法检测转储文件版本，将继续执行。',
    }
  }

  // 失败：转储文件比工具更新（例如 pg_restore 14 + 来自 16 的转储）
  if (dumpVersion.major > toolVersion.major) {
    return {
      compatible: false,
      dumpVersion,
      toolVersion,
      error:
        `备份文件由 PostgreSQL ${dumpVersion.major} 创建，` +
        `但你的 pg_restore 版本为 ${toolVersion.major}。` +
        `请安装 PostgreSQL ${dumpVersion.major} 客户端工具以恢复此备份。`,
    }
  }

  // 警告：转储文件版本过旧（落后 3 个以上主版本）
  if (dumpVersion.major < toolVersion.major - 2) {
    return {
      compatible: true,
      dumpVersion,
      toolVersion,
      warning:
        `备份文件由 PostgreSQL ${dumpVersion.major} 创建。` +
        `部分功能可能无法正确恢复。`,
    }
  }

  // 正常：同版本或转储文件更旧（向后兼容）
  return { compatible: true, dumpVersion, toolVersion }
}

// =============================================================================
// 主验证函数
// =============================================================================

/**
 * 验证转储文件是否可以用现有的 pg_restore 恢复
 *
 * @throws SpinDBError 如果版本不兼容
 */
export async function validateRestoreCompatibility(options: {
  dumpPath: string
  format: string
  pgRestorePath: string
}): Promise<{ dumpVersion: VersionInfo | null; toolVersion: VersionInfo }> {
  const { dumpPath, format, pgRestorePath } = options

  // 获取工具版本
  const toolVersion = await getPgRestoreVersion(pgRestorePath)
  logDebug('pg_restore 版本检测完成', { version: toolVersion.full })

  // 获取转储文件版本
  const dumpVersion = await parseDumpVersion(dumpPath, format, pgRestorePath)
  if (dumpVersion) {
    logDebug('转储文件版本检测完成', { version: dumpVersion.full })
  } else {
    logDebug('无法检测转储文件版本')
  }

  // 检查兼容性
  const result = checkVersionCompatibility(dumpVersion, toolVersion)

  if (!result.compatible) {
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      result.error!,
      'fatal',
      `请下载匹配的 PostgreSQL 客户端工具：spindb engines download postgresql ${dumpVersion!.major}`,
      { dumpVersion, toolVersion },
    )
  }

  if (result.warning) {
    logWarning(result.warning)
  }

  return { dumpVersion, toolVersion }
}

// =============================================================================
// 导出前兼容性验证
// =============================================================================

export type DumpCompatibilityResult = {
  compatible: boolean
  localToolVersion: VersionInfo
  remoteDbVersion: RemoteVersionResult
  requiredAction: 'none' | 'use_bundled' | 'download'
  alternativePath?: string // 兼容主版本的内置 pg_dump 路径
  targetMajor?: string // 应下载的主版本号（requiredAction=download 时）
  error?: string
}

export async function getPgDumpVersion(
  pgDumpPath: string,
): Promise<VersionInfo> {
  const { stdout } = await execAsync(`"${pgDumpPath}" --version`)
  return parseToolVersion(stdout)
}

/**
 * 验证当前 pg_dump 是否可以导出远程数据库。
 *
 * 如果当前 pg_dump 版本低于远程服务器，将在 spindb 自身的二进制缓存中
 * 查找更新的内置 pg_dump。如果没有可用的，将提示用户使用
 * `spindb engines download postgresql <major>` 下载。
 *
 * 我们不会检查系统安装的 PostgreSQL —— spindb 管理其所有的数据库二进制文件。
 */
export async function validateDumpCompatibility(options: {
  connectionString: string
  pgDumpPath: string
}): Promise<DumpCompatibilityResult> {
  const { connectionString, pgDumpPath } = options

  const localVersion = await getPgDumpVersion(pgDumpPath)
  logDebug('本地 pg_dump 版本', { version: localVersion.full })

  const remoteVersion = await detectRemotePostgresVersion(connectionString)
  logDebug('远程数据库版本', {
    version: remoteVersion.fullVersion,
    serverType: remoteVersion.serverType,
  })

  // 当前 pg_dump 已经可以读取远程数据库 —— 无需额外操作
  if (localVersion.major >= remoteVersion.majorVersion) {
    return {
      compatible: true,
      localToolVersion: localVersion,
      remoteDbVersion: remoteVersion,
      requiredAction: 'none',
    }
  }

  const targetMajor = String(remoteVersion.majorVersion)

  // 优先从 spindb 内置二进制中查找精确的主版本匹配
  const exactBundled = getBundledBinaryPath('pg_dump', targetMajor)
  if (exactBundled) {
    return {
      compatible: false,
      localToolVersion: localVersion,
      remoteDbVersion: remoteVersion,
      requiredAction: 'use_bundled',
      alternativePath: exactBundled,
      targetMajor,
    }
  }

  // 否则，接受任何 >= 远程版本的内置主版本
  const compatibleVersion = findCompatibleVersion(remoteVersion.majorVersion)
  if (compatibleVersion) {
    const bundledPath = getBundledBinaryPath(
      'pg_dump',
      compatibleVersion.majorVersion,
    )
    if (bundledPath) {
      return {
        compatible: false,
        localToolVersion: localVersion,
        remoteDbVersion: remoteVersion,
        requiredAction: 'use_bundled',
        alternativePath: bundledPath,
        targetMajor: compatibleVersion.majorVersion,
      }
    }
  }

  // 没有内置二进制文件可以读取此服务器 —— 提示用户下载
  return {
    compatible: false,
    localToolVersion: localVersion,
    remoteDbVersion: remoteVersion,
    requiredAction: 'download',
    targetMajor,
    error:
      `你的 pg_dump 版本（${localVersion.major}）无法导出 PostgreSQL ${remoteVersion.majorVersion} 的数据。` +
      `请下载匹配的客户端工具：spindb engines download postgresql ${targetMajor}`,
  }
}
