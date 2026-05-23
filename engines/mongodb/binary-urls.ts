/**
 * MongoDB hostdb 二进制文件 URL 生成
 *
 * 从 hostdb GitHub 发布版本生成 MongoDB 二进制文件的下载 URL。
 * 所有平台（macOS、Linux、Windows）均使用 hostdb 二进制文件。
 */

import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

// MongoDB hostdb 二进制文件支持的平台
export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

// MongoDB hostdb 二进制文件支持的平台/架构组合
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// 将 Node.js 平台/架构映射到 hostdb 平台键
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * 获取 MongoDB 二进制文件的下载 URL
 *
 * @param version - MongoDB 版本（主版本.次版本 或完整版本）
 * @param platform - 操作系统（darwin、linux、win32）
 * @param arch - 架构（arm64、x64）
 * @returns 下载 URL
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const hostdbPlatform = getHostdbPlatform(platform, arch)

  if (!hostdbPlatform) {
    throw new Error(
      `不支持的平台：${platform}-${arch}。MongoDB hostdb 二进制文件支持：darwin-arm64、darwin-x64、linux-arm64、linux-x64、win32-x64`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MongoDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}
