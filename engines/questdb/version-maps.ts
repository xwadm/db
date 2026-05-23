/**
 * QuestDB 版本映射
 *
 * 对 `hostdb` npm 包的轻量封装。架构原理参见 engines/sqlite/version-maps.ts
 * —— hostdb 是唯一的版本信息来源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

const ENGINE = 'questdb'

function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  // 遍历所有支持的主版本号，构建映射
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  // 遍历所有主版本号.次版本号格式，构建映射
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  // 遍历所有完整版本号，直接映射到自身
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const QUESTDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const FALLBACK_VERSION_MAP = QUESTDB_VERSION_MAP

export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}
