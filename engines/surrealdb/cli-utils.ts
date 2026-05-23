/**
 * SurrealDB CLI 工具函数
 *
 * 用于处理 SurrealDB 命令行工具的辅助函数。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const SURREAL_NOT_FOUND_ERROR =
  '未找到 SurrealDB 二进制文件。请运行：spindb engines download surrealdb <版本>'

/**
 * 获取 surreal 二进制文件路径
 *
 * 首先检查配置缓存，然后在已下载的二进制文件目录中查找。
 * 如果未找到则返回 null。
 */
export async function getSurrealPath(): Promise<string | null> {
  // 首先检查配置缓存
  const cached = await configManager.getBinaryPath('surreal')
  if (cached && existsSync(cached)) {
    return cached
  }

  return null
}

/**
 * 获取指定版本的 surreal 二进制文件路径
 */
export async function getSurrealPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'surrealdb',
    version: fullVersion,
    platform,
    arch,
  })

  const surrealPath = join(binPath, 'bin', `surreal${ext}`)
  if (existsSync(surrealPath)) {
    return surrealPath
  }

  return null
}

/**
 * 获取 surreal 二进制文件路径，如果未找到则抛出错误
 */
export async function requireSurrealPath(version?: string): Promise<string> {
  // 如果提供了版本，查找该特定版本
  if (version) {
    const path = await getSurrealPathForVersion(version)
    if (path) {
      return path
    }
  }

  // 尝试配置缓存
  const cached = await getSurrealPath()
  if (cached) {
    return cached
  }

  throw new Error(SURREAL_NOT_FOUND_ERROR)
}

/**
 * 验证 SurrealDB 标识符（命名空间、数据库、表名）
 * SurrealDB 标识符遵循特定规则
 *
 * 有效标识符：
 * - 以字母或下划线开头
 * - 包含字母、数字、下划线
 * - 最长 63 个字符
 *
 * @throws Error 如果标识符无效
 */
export function validateSurrealIdentifier(
  identifier: string,
  type: 'namespace' | 'database' | 'table' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type}名称不能为空`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type}名称不能超过 63 个字符`)
  }

  // SurrealDB 标识符规则
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `无效的${type}名称 "${identifier}"。` +
        `必须以字母或下划线开头，且仅包含字母、数字和下划线。`,
    )
  }

  // 检查保留字
  const reserved = [
    'namespace',
    'database',
    'table',
    'field',
    'index',
    'event',
    'param',
    'function',
    'token',
    'scope',
    'true',
    'false',
    'null',
    'none',
    'and',
    'or',
    'not',
    'if',
    'then',
    'else',
    'for',
    'in',
    'where',
    'select',
    'from',
    'create',
    'update',
    'delete',
    'insert',
    'define',
    'remove',
    'begin',
    'commit',
    'cancel',
    'return',
    'let',
    'use',
    'info',
    'live',
    'kill',
    'sleep',
    'throw',
    'break',
    'continue',
  ]

  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `"${identifier}" 是保留字，不能用作${type}名称`,
    )
  }
}

/**
 * 转义 SurrealDB 标识符以用于 SurrealQL
 * 使用反引号进行引用
 */
export function escapeSurrealIdentifier(identifier: string): string {
  // 转义任何反引号并用反引号包裹
  return `\`${identifier.replace(/`/g, '\\`')}\``
}
