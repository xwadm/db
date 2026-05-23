/**
 * Redis hostdb 发布模块
 *
 * 从 hostdb 仓库 (https://github.com/robertjbass/hostdb) 获取 Redis 二进制文件信息。
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { REDIS_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { redisBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Redis,
  displayName: 'Redis',
  versionMap: REDIS_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => redisBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion