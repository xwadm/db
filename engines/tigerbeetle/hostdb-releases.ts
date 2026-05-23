/**
 * TigerBeetle 的 hostdb 发布版本模块
 *
 * 从 hostdb 仓库（https://github.com/robertjbass/hostdb）获取
 * TigerBeetle 二进制文件信息。
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import {
  TIGERBEETLE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { tigerbeetleBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.TigerBeetle,
  displayName: 'TigerBeetle',
  versionMap: TIGERBEETLE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => tigerbeetleBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
