/**
 * SQLite 版本映射
 *
 * 对 `hostdb` npm 包的薄封装 — hostdb 是版本列表及短版本字符串解析的唯一数据源。
 *
 * 要升级版本：更新 hostdb 的 databases.yml + sources.json，发布新版 hostdb 到 npm，
 * 然后升级本包对 `hostdb` 的依赖版本。
 *
 * 以下导出保留了旧接口形态，使调用方无需改动。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'sqlite'

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

export const SQLITE_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `SQLite 版本 '${version}' 不在 hostdb 中，可能无法用于下载`,
  )
  return version
}