/**
 * ClickHouse CLI 工具函数
 * 用于与 clickhouse 二进制文件交互的共享工具
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const CLICKHOUSE_NOT_FOUND_ERROR =
  '未找到 ClickHouse 二进制文件。请运行：spindb engines download clickhouse <version>'

/**
 * 验证 ClickHouse 标识符（数据库名称、表名等）
 * ClickHouse 标识符必须满足：
 * - 以字母或下划线开头
 * - 仅包含字母、数字和下划线
 * - 不是保留字（基本检查）
 *
 * @param identifier - 要验证的标识符
 * @param type - 用于错误消息的标识符类型（例如 'database'、'table'）
 * @returns 验证通过的标识符
 * @throws 如果标识符无效，则抛出错误
 */
export function validateClickHouseIdentifier(
  identifier: string,
  type: string = 'identifier',
): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error(`无效的 ${type}：必须是非空字符串`)
  }

  // ClickHouse 标识符规则：
  // - 必须以字母（a-z、A-Z）或下划线开头
  // - 可包含字母、数字和下划线
  // - 最大长度为 255 个字符
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/

  if (!validPattern.test(identifier)) {
    throw new Error(
      `无效的 ${type} "${identifier}"：必须以字母或下划线开头，` +
        `且只能包含字母、数字和下划线`,
    )
  }

  if (identifier.length > 255) {
    throw new Error(`无效的 ${type} "${identifier}"：最大长度为 255 个字符`)
  }

  // 基础保留字检查（ClickHouse 系统数据库）
  const reserved = ['system', 'information_schema']
  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `无效的 ${type} "${identifier}"："${identifier}" 是系统保留名称`,
    )
  }

  return identifier
}

/**
 * 为 SQL 查询中的 ClickHouse 标识符添加转义
 * 使用反引号进行转义（ClickHouse 同时支持反引号和双引号）
 *
 * @param identifier - 要转义的标识符
 * @returns 包裹在反引号中的已转义标识符
 */
export function escapeClickHouseIdentifier(identifier: string): string {
  // 将标识符中的反引号替换为转义后的反引号
  const escaped = identifier.replace(/`/g, '``')
  return `\`${escaped}\``
}

/**
 * 获取 clickhouse 二进制文件的路径
 * 首先检查配置缓存，然后回退到已下载的二进制文件路径
 *
 * @param version - 可选的版本号，用于查找特定的二进制文件
 * @returns clickhouse 二进制文件路径，未找到则返回 null
 */
export async function getClickHousePath(
  version?: string,
): Promise<string | null> {
  // 首先检查配置缓存
  const cached = await configManager.getBinaryPath('clickhouse')
  if (cached && existsSync(cached)) {
    return cached
  }

  // 如果提供了版本号，则查找已下载的二进制文件
  if (version) {
    const { platform, arch } = platformService.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      return clickhousePath
    }
  }

  return null
}

/**
 * 获取 clickhouse 二进制文件的路径，若未找到则抛出错误
 *
 * @param version - 可选的版本号，用于查找特定的二进制文件
 * @returns clickhouse 二进制文件路径
 * @throws 如果二进制文件未找到，则抛出错误
 */
export async function requireClickHousePath(version?: string): Promise<string> {
  const path = await getClickHousePath(version)
  if (!path) {
    throw new Error(CLICKHOUSE_NOT_FOUND_ERROR)
  }
  return path
}

/**
 * 构建用于执行 SQL 的 clickhouse 客户端命令
 *
 * @param clickhousePath - clickhouse 二进制文件路径
 * @param port - 连接端口
 * @param database - 要使用的数据库
 * @returns 命令参数数组
 */
export function buildClickHouseClientArgs(
  port: number,
  database: string,
): string[] {
  return [
    'client',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--database',
    database,
  ]
}

/**
 * 构建用于执行查询的 clickhouse 客户端命令
 *
 * @param port - 连接端口
 * @param database - 要使用的数据库
 * @param query - 要执行的 SQL 查询
 * @returns 命令参数数组
 */
export function buildClickHouseQueryArgs(
  port: number,
  database: string,
  query: string,
): string[] {
  return [
    'client',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--database',
    database,
    '--query',
    query,
  ]
}
