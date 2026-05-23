/**
 * PostgreSQL 远程版本检测
 *
 * 从连接字符串检测远程数据库的 PostgreSQL 版本。
 * 用于确保使用兼容的客户端工具进行导出操作。
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

export type RemoteVersionResult = {
  majorVersion: number
  minorVersion: number
  fullVersion: string
  serverType: 'postgresql' | 'aurora' | 'rds' | 'supabase' | 'neon' | 'unknown'
}

/**
 * 检测远程数据库的 PostgreSQL 版本
 *
 * 使用 psql 查询服务器的版本信息。
 * 适用于所有兼容 PostgreSQL 的数据库，包括 Aurora、RDS、Supabase 等。
 */
export async function detectRemotePostgresVersion(
  connectionString: string,
): Promise<RemoteVersionResult> {
  const psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    throw new Error(
      '未找到 psql —— 远程版本检测所必需。\n' +
        '请下载 PostgreSQL 二进制文件：spindb engines download postgresql',
    )
  }

  // 使用 psql 查询远程服务器版本
  // 使用多个设置获取全面的版本信息
  const sql = "SELECT version(), current_setting('server_version')"
  const cmd = `"${psqlPath}" "${connectionString}" -t -A -F "|||" -c "${sql}"`

  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000 })
    const parts = stdout.trim().split('|||')

    if (parts.length < 2) {
      throw new Error(`意外的版本输出格式：${stdout}`)
    }

    const [versionString, serverVersion] = parts

    // 从 server_version 解析版本（例如 "16.1"、"17.0"）
    const match = serverVersion.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!match) {
      throw new Error(`无法解析服务器版本：${serverVersion}`)
    }

    const majorVersion = parseInt(match[1], 10)
    const minorVersion = parseInt(match[2], 10)
    const fullVersion = match[0]

    // 从 version() 输出检测服务器类型
    const serverType = detectServerType(versionString)

    logDebug('远程 PostgreSQL 版本检测完成', {
      majorVersion,
      minorVersion,
      fullVersion,
      serverType,
    })

    return { majorVersion, minorVersion, fullVersion, serverType }
  } catch (error) {
    const e = error as Error & { code?: string; killed?: boolean }

    // 处理超时
    if (e.killed) {
      throw new Error(
        '连接远程数据库超时（30 秒）',
      )
    }

    // 处理常见连接错误并提供有用的提示信息
    if (
      e.message.includes('could not connect') ||
      e.message.includes('Connection refused')
    ) {
      throw new Error(
        `无法连接到远程数据库。请检查连接字符串并确保数据库可访问。\n\n原始错误：${e.message}`,
      )
    }

    if (
      e.message.includes('password authentication failed') ||
      e.message.includes('authentication failed')
    ) {
      throw new Error(
        `认证失败。请检查连接字符串中的用户名和密码。\n\n原始错误：${e.message}`,
      )
    }

    if (
      e.message.includes('database') &&
      e.message.includes('does not exist')
    ) {
      throw new Error(
        `数据库不存在。请检查连接字符串中的数据库名称。\n\n原始错误：${e.message}`,
      )
    }

    if (e.message.includes('SSL')) {
      throw new Error(
        `SSL 连接错误。你可能需要在连接字符串中添加 ?sslmode=require 或 ?sslmode=disable。\n\n原始错误：${e.message}`,
      )
    }

    // 重新抛出并附带上下文信息
    throw new Error(`检测远程 PostgreSQL 版本失败：${e.message}`)
  }
}

// 从 version() 输出检测 PostgreSQL 服务器类型
function detectServerType(
  versionString: string,
): RemoteVersionResult['serverType'] {
  const lower = versionString.toLowerCase()

  if (lower.includes('aurora')) {
    return 'aurora'
  }
  if (lower.includes('rds') || lower.includes('amazon')) {
    return 'rds'
  }
  if (lower.includes('supabase')) {
    return 'supabase'
  }
  if (lower.includes('neon')) {
    return 'neon'
  }
  if (lower.includes('postgresql')) {
    return 'postgresql'
  }

  return 'unknown'
}

/**
 * 检查本地 pg_dump 版本是否与远程数据库版本兼容
 *
 * PostgreSQL 具有前向兼容性：X 版本的 pg_dump 可以导出版本 <= X 的数据库
 */
export function isVersionCompatible(
  localMajorVersion: number,
  remoteMajorVersion: number,
): boolean {
  return localMajorVersion >= remoteMajorVersion
}
