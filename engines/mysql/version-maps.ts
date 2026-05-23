/**
 * MySQL 版本映射
 *
 * 基于 `hostdb` npm 包的薄封装。架构原理参见 engines/sqlite/version-maps.ts
 * ——hostdb 是唯一数据源。
 *
 * 注意：SUPPORTED_MAJOR_VERSIONS 为 2 段格式（例如 '8.4'），以保持
 * `core/version-migration.ts:getMajorVersion()` 中的使用约定。1 段键
 * '8' 和 '9' 依然通过映射解析（LTS 选择：'8' → 8.4.9，而非 9.6.0）。
 *
 * 已弃用的补丁版本（8.0.40、9.1.0、9.5.0）仍然可解析，以便现有容器
 * 继续工作——hostdb 的 `enabled !== false` 检查会将它们保留在可用版本
 * 列表中；仅 `enabled: false` 会完全移除某个版本。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mysql'

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

export const MYSQL_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export const FALLBACK_VERSION_MAP: Record<string, string> = MYSQL_VERSION_MAP

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
    logDebug(
      `MySQL 版本 '${version}' 格式无效，可能在 hostdb 中不可用`,
    )
  } else {
    logDebug(
      `MySQL 版本 '${version}' 不在 hostdb 中，可能无法下载`,
    )
  }
  return version
}