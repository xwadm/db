/**
 * CouchDB 版本映射
 *
 * 对 `hostdb` npm 包的薄封装。架构原理参见 engines/sqlite/version-maps.ts
 * — hostdb 是唯一的数据源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'couchdb'

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

export const COUCHDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved

  const parts = version.split('.')
  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(`CouchDB 版本 '${version}' 格式无效，可能在 hostdb 中不可用`)
  } else {
    logDebug(`CouchDB 版本 '${version}' 不在 hostdb 中，可能无法下载`)
  }
  return version
}
