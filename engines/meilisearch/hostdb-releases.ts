/**
 * Meilisearch 的 hostdb 发布版本模块
 *
 * 从 hostdb 仓库获取 Meilisearch 二进制信息，
 * 仓库地址：https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import {
  MEILISEARCH_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { meilisearchBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Meilisearch,
  displayName: 'Meilisearch',
  versionMap: MEILISEARCH_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => meilisearchBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion