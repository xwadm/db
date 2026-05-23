/**
 * MariaDB 版本映射
 *
 * `hostdb` npm 包的轻量封装。架构原理参见 engines/sqlite/version-maps.ts
 * —— hostdb 是唯一的事实来源。
 *
 * 注意：SUPPORTED_MAJOR_VERSIONS 使用两部分版本号（例如 '11.8'），以保持
 * `core/version-migration.ts:getMajorVersion()` 使用的约定，该函数将
 * 补丁版本归组到其 major.minor LTS 系列下。像 '10' 和 '11' 这样的
 * 一部分键仍然可以通过 MAP 解析（LTS 选择）。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mariadb'

/** 构建版本映射表，包含主版本、次版本和完整版本的映射 */
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

export const MARIADB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

/** 获取主版本对应的完整版本号 */
export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

/** 标准化版本号，尝试从 hostdb 解析完整版本 */
export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `MariaDB 版本 '${version}' 不在 hostdb 中，可能无法下载`,
  )
  return version
}
