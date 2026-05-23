/**
 * SQLite 的 hostdb 发布版本模块
 *
 * 从 https://github.com/robertjbass/hostdb 仓库获取 SQLite 二进制文件信息
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { SQLITE_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { sqliteBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.SQLite,
  displayName: 'SQLite',
  versionMap: SQLITE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => sqliteBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion