/**
 * QuestDB 的 hostdb 发布版本模块
 *
 * 从 hostdb 仓库（https://github.com/robertjbass/hostdb）获取
 * QuestDB 二进制文件信息。
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { QUESTDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { questdbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.QuestDB,
  displayName: 'QuestDB',
  versionMap: QUESTDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => questdbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
