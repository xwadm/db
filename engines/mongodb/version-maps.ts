/**
 * MongoDB 版本映射
 *
 * 对 `hostdb` npm 包的轻量封装。架构设计原理参见 engines/sqlite/version-maps.ts
 * —— hostdb 是唯一的版本信息来源。
 *
 * 注意：SUPPORTED_MAJOR_VERSIONS 采用两部分版本号格式（例如 '8.0'），
 * 以保持与 `core/version-migration.ts:getMajorVersion()` 的约定一致。
 * 一部分键 '7' 和 '8' 仍可通过 MAP 解析（LTS 优先选择：'8' → 8.0.23，而非 8.2.9）。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mongodb'

// 构建版本映射表：遍历主版本、小版本和完整版本，生成完整的版本号对应关系
function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const MONGODB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export const FALLBACK_VERSION_MAP: Record<string, string> = MONGODB_VERSION_MAP

// 根据主版本号获取完整版本号
export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

// 规范化版本号：尝试通过 hostdb 解析为精确版本，失败则返回原值
export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `MongoDB 版本 '${version}' 未在 hostdb 中找到，可能无法下载`,
  )
  return version
}
