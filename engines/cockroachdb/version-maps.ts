/**
 * CockroachDB 版本映射
 *
 * `hostdb` npm 包的薄封装层。架构原理参见 engines/sqlite/version-maps.ts
 * — hostdb 是唯一数据源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

const ENGINE = 'cockroachdb'

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

export const COCKROACHDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '25'

export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}

export function isVersionSupported(version: string): boolean {
  return version in COCKROACHDB_VERSION_MAP
}

export function getLatestPatch(majorVersion: string): string | undefined {
  return COCKROACHDB_VERSION_MAP[majorVersion]
}