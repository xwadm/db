/**
 * TypeDB 的 hostdb 发布版本模块
 *
 * 从 hostdb 仓库获取 TypeDB 二进制文件信息，
 * 仓库地址：https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { TYPEDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { typedbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.TypeDB,
  displayName: 'TypeDB',
  versionMap: TYPEDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => typedbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
