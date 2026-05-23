/**
 * TypeDB CLI 工具集
 *
 * 用于操作 TypeDB 命令行工具的辅助函数。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const TYPEDB_NOT_FOUND_ERROR =
  'TypeDB 二进制文件未找到。请运行: spindb engines download typedb <version>'

/** TypeDB 默认凭据（TypeDB 3.x 需要身份验证） */
export const TYPEDB_DEFAULT_USERNAME = 'admin'
export const TYPEDB_DEFAULT_PASSWORD = 'password'

/**
 * 获取标准的 TypeDB 控制台连接参数，包括身份验证。
 * TypeDB 3.x 要求所有控制台操作都提供 --username 和 --password。
 *
 * @param tlsDisabled - 为 true 时（本地开发默认值），追加 --tls-disabled。
 *   连接启用 TLS 的 TypeDB 服务器时传 false。
 */
export function getConsoleBaseArgs(
  port: number,
  host = '127.0.0.1',
  tlsDisabled = true,
  auth?: { username?: string; password?: string },
): string[] {
  const args = [
    '--address',
    `${host}:${port}`,
    ...(tlsDisabled ? ['--tls-disabled'] : []),
    '--username',
    auth?.username || TYPEDB_DEFAULT_USERNAME,
    '--password',
    auth?.password || TYPEDB_DEFAULT_PASSWORD,
  ]
  return args
}

/**
 * 获取 typedb 启动器二进制文件的路径
 *
 * 首先检查配置缓存，然后扫描已下载的二进制文件目录。
 * 未找到则返回 null。
 */
export async function getTypeDBPath(): Promise<string | null> {
  // 先检查配置缓存
  const cached = await configManager.getBinaryPath('typedb')
  if (cached && existsSync(cached)) {
    return cached
  }

  // 回退到文件系统扫描，使用与 getTypeDBPathForVersion 相同的逻辑
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const version of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBPathForVersion(version)
    if (found) {
      await configManager.setBinaryPath('typedb', found, 'bundled')
      return found
    }
  }

  return null
}

/**
 * 获取指定版本的 typedb 二进制文件路径
 */
export async function getTypeDBPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  // TypeDB 启动器在 Windows 上是 .bat 脚本，其他平台无扩展名
  const batExt = platform === 'win32' ? '.bat' : ''

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
  if (existsSync(typedbPath)) {
    return typedbPath
  }

  return null
}

/**
 * 获取指定版本的 typedb_console_bin 路径
 */
export async function getTypeDBConsolePath(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const consolePath = join(
    binPath,
    'bin',
    'console',
    `typedb_console_bin${ext}`,
  )
  if (existsSync(consolePath)) {
    return consolePath
  }

  return null
}

/**
 * 获取必需的 typedb 二进制文件路径，未找到则抛出异常
 */
export async function requireTypeDBPath(version?: string): Promise<string> {
  // 如果提供了版本号，查找该特定版本
  if (version) {
    const path = await getTypeDBPathForVersion(version)
    if (path) {
      return path
    }
  }

  // 尝试配置缓存
  const cached = await getTypeDBPath()
  if (cached) {
    return cached
  }

  throw new Error(TYPEDB_NOT_FOUND_ERROR)
}

/**
 * 获取必需的 typedb_console_bin 路径，未找到则抛出异常
 */
export async function requireTypeDBConsolePath(
  version?: string,
): Promise<string> {
  if (version) {
    const path = await getTypeDBConsolePath(version)
    if (path) {
      return path
    }
  }

  // 尝试配置缓存
  const cached = await configManager.getBinaryPath('typedb_console_bin')
  if (cached && existsSync(cached)) {
    return cached
  }

  // 回退扫描所有已安装的版本（与 requireTypeDBPath 相同的模式）
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const ver of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBConsolePath(ver)
    if (found) {
      return found
    }
  }

  throw new Error(
    'TypeDB 控制台二进制文件未找到。请运行: spindb engines download typedb <version>',
  )
}

/**
 * 验证 TypeDB 标识符（数据库名称）
 * TypeDB 标识符遵循以下规则：
 * - 以字母或下划线开头
 * - 包含字母、数字、下划线、短横线
 * - 最多 63 个字符
 *
 * @throws 如果标识符无效则抛出 Error
 */
export function validateTypeDBIdentifier(
  identifier: string,
  type: 'database' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} 名称不能为空`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} 名称不能超过 63 个字符`)
  }

  // TypeDB 允许字母数字、下划线和短横线
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `无效的 ${type} 名称 "${identifier}"。` +
        `必须以字母或下划线开头，且仅包含字母、数字、下划线和短横线。`,
    )
  }
}
