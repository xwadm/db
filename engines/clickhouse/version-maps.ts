/**
 * ClickHouse 版本映射
 *
 * 对 `hostdb` npm 包的薄封装。架构原理参见 engines/sqlite/version-maps.ts
 * —— hostdb 是唯一数据源。
 *
 * ClickHouse 使用 YY.MM.X.build 版本控制（例如 25.12.3.21）。YY.MM 形式的
 * 主版本号-次版本号键在整个 spindb 中使用。SUPPORTED_MAJOR_VERSIONS
 * 是 2 部分形式，以保留这一惯例；'25' 仍可通过 MAP 解析。
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'clickhouse'

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
    // ClickHouse 4 部分完整版本有一个 3 部分前缀（例如 25.12.3），
    // 该前缀也应能被解析。将 3 部分前缀添加到 MAP 中，
    // 以支持 spindb 现有的标识匹配调用路径。
    const parts = full.split('.')
    if (parts.length === 4) {
      const threePartPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      const r = hostdbResolveVersion(ENGINE, threePartPrefix)
      if (r) map[threePartPrefix] = r
    }
  }
  return map
}

export const CLICKHOUSE_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export function getFullVersion(version: string): string | null {
  return hostdbResolveVersion(ENGINE, version)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved

  const parts = version.split('.')
  const isValidFormat =
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(`ClickHouse 版本 '${version}' 格式无效，可能在 hostdb 中不可用`)
  } else {
    logDebug(`ClickHouse 版本 '${version}' 不在 hostdb 中，可能无法下载`)
  }
  return version
}

export function getMajorVersion(version: string): string {
  const parts = version.split('.')
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`
  }
  return version
}
