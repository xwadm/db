/**
 * Qdrant hostdb 发布信息模块
 *
 * 从 hostdb 仓库 (https://github.com/robertjbass/hostdb) 获取 Qdrant 二进制信息
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { QDRANT_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { qdrantBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Qdrant,
  displayName: 'Qdrant',
  versionMap: QDRANT_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => qdrantBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion