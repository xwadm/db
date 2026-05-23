/**
 * FerretDB 二进制文件 URL 生成模块（用于 hostdb）
 *
 * 从 hostdb GitHub Releases 生成 FerretDB 二进制文件的下载 URL。
 *
 * FerretDB v2 需要两个二进制文件：
 * - ferretdb：MongoDB 兼容代理
 * - postgresql-documentdb：PostgreSQL 17 + DocumentDB 扩展
 *
 * FerretDB v1 需要：
 * - ferretdb：MongoDB 兼容代理
 * - 普通 PostgreSQL（由 postgresqlBinaryManager 管理，不在此下载）
 *
 * v1 和 v2 在 hostdb 中使用相同的 "ferretdb" 引擎名称。
 * v1 支持所有平台，包括 Windows。
 * v2 仅支持 macOS/Linux（postgresql-documentdb 在 Windows 上存在启动问题）。
 */

import {
  normalizeVersion,
  normalizeDocumentDBVersion,
  isV1,
} from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

// FerretDB v2 支持的平台（需要 postgresql-documentdb）
// 由于 postgresql-documentdb 启动问题，排除了 Windows
export const FERRETDB_V2_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
])

// FerretDB v1 支持的平台（使用普通 PostgreSQL）
// 所有平台，包括 Windows
export const FERRETDB_V1_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// postgresql-documentdb 后端支持的平台（仅 v2）
export const DOCUMENTDB_SUPPORTED_PLATFORMS = FERRETDB_V2_SUPPORTED_PLATFORMS

/**
 * 将 Node.js 平台/架构映射为 hostdb 平台键
 * @param version - 可选的 FerretDB 版本，用于确定平台支持（v1 与 v2）
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
  version?: string,
): string | null {
  const key = `${platform}-${arch}`
  const platforms =
    version && isV1(version)
      ? FERRETDB_V1_SUPPORTED_PLATFORMS
      : FERRETDB_V2_SUPPORTED_PLATFORMS
  return platforms.has(key) ? key : null
}

/**
 * 检查当前平台是否支持 FerretDB
 * @param version - 可选的 FerretDB 版本，用于确定平台支持（v1 与 v2）
 */
export function isPlatformSupported(
  platform: Platform,
  arch: Arch,
  version?: string,
): boolean {
  return getHostdbPlatform(platform, arch, version) !== null
}

/**
 * 获取 FerretDB 代理二进制文件的下载 URL
 *
 * @param version - FerretDB 版本（主版本号或完整版本号）
 * @param platform - 操作系统（darwin、linux、win32）
 * @param arch - 架构（arm64、x64）
 * @returns 下载 URL
 */
export function getFerretDBBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const hostdbPlatform = getHostdbPlatform(platform, arch, version)

  if (!hostdbPlatform) {
    const v1 = isV1(version)
    throw new Error(
      `不支持的平台: ${platform}-${arch}。FerretDB ${v1 ? 'v1' : 'v2'} ${v1 ? '在此平台上不可用' : '仅支持 macOS 和 Linux'}。`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.FerretDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * 获取 postgresql-documentdb 后端二进制文件的下载 URL
 *
 * @param version - DocumentDB 版本（例如 "17-0.107.0"）
 * @param platform - 操作系统（darwin、linux、win32）
 * @param arch - 架构（arm64、x64）
 * @returns 下载 URL
 */
export function getDocumentDBBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeDocumentDBVersion(version)
  const key = `${platform}-${arch}`

  if (!DOCUMENTDB_SUPPORTED_PLATFORMS.has(key)) {
    throw new Error(
      `不支持的平台: ${platform}-${arch}。postgresql-documentdb（FerretDB v2 后端）仅支持 macOS 和 Linux。`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  // 使用共享的 buildHostdbUrl，以 'postgresql-documentdb' 作为引擎名
  return buildHostdbUrl('postgresql-documentdb', {
    version: fullVersion,
    hostdbPlatform: key,
    extension: ext,
  })
}

/**
 * 获取 FerretDB 的组合二进制文件 URL（代理和后端）
 *
 * v1：仅返回 ferretdb URL（后端为普通 PostgreSQL，单独管理）
 * v2：同时返回 ferretdb 和 documentdb URL
 *
 * @param version - FerretDB 版本（主版本号或完整版本号）
 * @param backendVersion - postgresql-documentdb 版本（例如 "17-0.107.0"），仅用于 v2
 * @param platform - 操作系统
 * @param arch - 架构
 * @returns 包含 ferretdb URL 和可选 documentdb URL 的对象
 */
export function getBinaryUrls(
  version: string,
  backendVersion: string,
  platform: Platform,
  arch: Arch,
): { ferretdb: string; documentdb?: string } {
  // 验证平台是否支持此 FerretDB 版本
  if (!isPlatformSupported(platform, arch, version)) {
    const v1 = isV1(version)
    throw new Error(
      `FerretDB ${v1 ? 'v1' : 'v2'} 在 ${platform}-${arch} 上不可用。\n` +
        (v1
          ? '此平台不受支持。'
          : 'FerretDB v2 仅支持 macOS 和 Linux。如需 Windows 支持，请尝试 v1。'),
    )
  }

  if (isV1(version)) {
    // v1：后端为普通 PostgreSQL（由 postgresqlBinaryManager 管理）
    return {
      ferretdb: getFerretDBBinaryUrl(version, platform, arch),
    }
  }

  // v2：后端为 postgresql-documentdb
  return {
    ferretdb: getFerretDBBinaryUrl(version, platform, arch),
    documentdb: getDocumentDBBinaryUrl(backendVersion, platform, arch),
  }
}
