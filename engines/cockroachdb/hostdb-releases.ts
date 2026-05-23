/**
 * CockroachDB 的 hostdb 发行版模块
 *
 * 从 https://github.com/robertjbass/hostdb 仓库获取 CockroachDB 二进制信息
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import {
  COCKROACHDB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { cockroachdbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.CockroachDB,
  displayName: 'CockroachDB',
  versionMap: COCKROACHDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => cockroachdbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion