/**
 * FerretDB 版本映射表
 *
 * 对 `hostdb` npm 包的轻量封装。有关架构设计原理，
 * 请参见 engines/sqlite/version-maps.ts —— hostdb 是唯一的版本信息来源。
 *
 * FerretDB 在 hostdb 中有两个引擎：'ferretdb'（代理）和
 * 'postgresql-documentdb'（v2 后端）。两者都在此查找。
 *
 * v1.x 使用普通 PostgreSQL 作为后端（支持所有平台，包括 Windows）
 * v2.x 使用 postgresql-documentdb 作为后端（仅支持 macOS/Linux）
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'ferretdb'
const DOCUMENTDB_ENGINE = 'postgresql-documentdb'

// 根据引擎名称构建版本映射表
function buildVersionMap(engine: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(engine)) {
    const r = hostdbResolveVersion(engine, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(engine, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(engine, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(engine, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const FERRETDB_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const DOCUMENTDB_VERSION_MAP: Record<string, string> =
  buildVersionMap(DOCUMENTDB_ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_DOCUMENTDB_VERSION =
  hostdbResolveVersion(DOCUMENTDB_ENGINE, '17') ?? '17-0.107.0'

export const DEFAULT_V1_POSTGRESQL_VERSION = '17'

export const FALLBACK_VERSION_MAP: Record<string, string> = {
  ...FERRETDB_VERSION_MAP,
}

// 判断给定版本是否为 v1 版本
export function isV1(version: string): boolean {
  const normalized = normalizeVersion(version)
  return normalized.startsWith('1.')
}

// 获取完整版本字符串
export function getFullVersion(version: string): string | null {
  return hostdbResolveVersion(ENGINE, version)
}

// 规范化 FerretDB 版本号
export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `FerretDB 版本 '${version}' 不在 hostdb 中，可能无法下载`,
  )
  return version
}

// 规范化 DocumentDB 版本号
export function normalizeDocumentDBVersion(version: string): string {
  return hostdbResolveVersion(DOCUMENTDB_ENGINE, version) ?? version
}
