/**
 * Weaviate hostdb 发布版本模块
 *
 * 从 hostdb 仓库获取 Weaviate 二进制文件信息，
 * 仓库地址：https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { WEAVIATE_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { weaviateBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Weaviate,
  displayName: 'Weaviate',
  versionMap: WEAVIATE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => weaviateBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion