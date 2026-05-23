/**
 * SurrealDB 版本映射
 *
 * 对 `hostdb` npm 包的轻量封装。架构原理请参阅 engines/sqlite/version-maps.ts
 * — hostdb 是唯一的真实数据源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

const ENGINE = 'surrealdb'

function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  // 遍历所有支持的主版本号
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  // 遍历所有主.次版本号
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  // 遍历所有完整版本号
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

// SurrealDB 版本映射表
export const SURREALDB_VERSION_MAP: Record<string, string> = buildVersionMap()

// 支持的主版本列表
export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

// 默认版本
export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '2'

/**
 * 规范化版本号
 * 将用户输入的版本号解析为完整版本号
 */
export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}

/**
 * 检查版本是否受支持
 */
export function isVersionSupported(version: string): boolean {
  return version in SURREALDB_VERSION_MAP
}

/**
 * 获取指定主版本的最新补丁版本
 */
export function getLatestPatch(majorVersion: string): string | undefined {
  return SURREALDB_VERSION_MAP[majorVersion]
}
