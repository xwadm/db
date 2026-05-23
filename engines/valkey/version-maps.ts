/**
 * Valkey 版本映射
 *
 * 对 `hostdb` npm 包的薄封装。关于架构原理，
 * 参见 engines/sqlite/version-maps.ts —— hostdb 是唯一数据源。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'valkey'

/**
 * 构建版本映射表，包含大版本、主次版本和完整版本号
 */
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

export const VALKEY_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

/**
 * 根据大版本号获取对应的完整版本字符串
 */
export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

/**
 * 标准化版本号，将不完整的版本号解析为完整版本
 */
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
      `Valkey 版本 '${version}' 格式无效，可能在 hostdb 中不可用`,
    )
  } else {
    logDebug(
      `Valkey 版本 '${version}' 不在 hostdb 中，可能无法下载`,
    )
  }
  return version
}