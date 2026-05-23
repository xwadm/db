/**
 * TigerBeetle 版本映射
 *
 * hostdb npm 包的薄封装。架构原理参见 engines/sqlite/version-maps.ts
 * —— hostdb 是单一事实来源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

const ENGINE = 'tigerbeetle'

function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  // 添加主要版本映射
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  // 添加次要版本映射
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  // 添加完整版本自映射
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const TIGERBEETLE_VERSION_MAP: Record<string, string> =
  buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const FALLBACK_VERSION_MAP = TIGERBEETLE_VERSION_MAP

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  return version
}
