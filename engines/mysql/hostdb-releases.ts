/**
 * MySQL 的 hostdb 发布模块
 *
 * 从 https://github.com/robertjbass/hostdb 仓库获取 MySQL 二进制信息。
 *
 * MySQL 使用条件版本分组：若 X.Y 是受支持的主版本，则按 X.Y 分组；
 * 否则回退到 X（例如：8.0.40 分组到 "8.0"，但 9.5.0 分组到 "9"）。
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { MYSQL_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { mysqlBinaryManager } from './binary-manager'
import { Engine } from '../../types'

/**
 * MySQL 基于 SUPPORTED_MAJOR_VERSIONS 使用条件 X.Y vs X 分组。
 * 若 X.Y 在 SUPPORTED_MAJOR_VERSIONS 中，则使用 X.Y；否则使用 X。
 */
function getMajorVersion(version: string): string {
  const parts = version.split('.')
  const majorXY = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
  const majorX = parts[0]
  return SUPPORTED_MAJOR_VERSIONS.includes(majorXY) ? majorXY : majorX
}

// 当提供 getMajorVersion 时，groupingStrategy 仅影响 getLatestVersion 中的
// 回退版本合成（例如 'xy-format' 生成 `${major}.0` 作为回退）。
// 实际版本分组使用的是 getMajorVersion，而非 groupingStrategy。
const hostdbReleases = createHostdbReleases({
  engine: Engine.MySQL,
  displayName: 'MySQL',
  versionMap: MYSQL_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => mysqlBinaryManager.listInstalled(),
  getMajorVersion,
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
export const fetchDeprecatedVersions = hostdbReleases.fetchDeprecatedVersions