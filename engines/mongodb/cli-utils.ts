/**
 * MongoDB CLI 共享工具
 *
 * 提供定位 MongoDB 二进制文件的通用函数，
 * 供 backup.ts、restore.ts 和 index.ts 使用以避免重复代码。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'

/**
 * 获取指定 MongoDB 版本的 mongodump 二进制文件路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理的二进制文件，
 * 仅在未找到匹配版本时才回退到系统 mongodump。
 *
 * 查找顺序：
 * 1. 与容器精确版本匹配的 SpinDB 管理的 mongodump
 * 2. 与主版本匹配的 SpinDB 管理的 mongodump
 * 3. configManager 缓存（来自 hostdb 的内置/已下载二进制文件）
 * 4. 系统 PATH（回退到系统安装的 mongodb-database-tools）
 *
 * @param containerVersion - 可选的容器 MongoDB 版本，用于版本匹配查找
 * @returns mongodump 路径，未找到则返回 null
 */
export async function getMongodumpPath(
  containerVersion?: string,
): Promise<string | null> {
  // 如果提供了 containerVersion，尝试版本匹配的 SpinDB 二进制文件
  if (containerVersion) {
    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // 尝试精确版本匹配
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMongodump = join(versionedBinPath, 'bin', `mongodump${ext}`)
    if (existsSync(versionedMongodump)) {
      return versionedMongodump
    }

    // 尝试主版本匹配
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mongodb',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMongodump = join(installed.path, 'bin', `mongodump${ext}`)
      if (existsSync(installedMongodump)) {
        return installedMongodump
      }
    }
  }

  // 检查是否有来自 hostdb 的缓存/内置 mongodump
  const cachedPath = await configManager.getBinaryPath('mongodump')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('mongodump')
}

/**
 * 获取指定 MongoDB 版本的 mongorestore 二进制文件路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理的二进制文件，
 * 仅在未找到匹配版本时才回退到系统 mongorestore。
 *
 * 查找顺序：
 * 1. 与容器精确版本匹配的 SpinDB 管理的 mongorestore
 * 2. 与主版本匹配的 SpinDB 管理的 mongorestore
 * 3. configManager 缓存（来自 hostdb 的内置/已下载二进制文件）
 * 4. 系统 PATH（回退到系统安装的 mongodb-database-tools）
 *
 * @param containerVersion - 可选的容器 MongoDB 版本，用于版本匹配查找
 * @returns mongorestore 路径，未找到则返回 null
 */
export async function getMongorestorePath(
  containerVersion?: string,
): Promise<string | null> {
  // 如果提供了 containerVersion，尝试版本匹配的 SpinDB 二进制文件
  if (containerVersion) {
    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // 尝试精确版本匹配
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMongorestore = join(
      versionedBinPath,
      'bin',
      `mongorestore${ext}`,
    )
    if (existsSync(versionedMongorestore)) {
      return versionedMongorestore
    }

    // 尝试主版本匹配
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mongodb',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMongorestore = join(
        installed.path,
        'bin',
        `mongorestore${ext}`,
      )
      if (existsSync(installedMongorestore)) {
        return installedMongorestore
      }
    }
  }

  // 检查是否有来自 hostdb 的缓存/内置 mongorestore
  const cachedPath = await configManager.getBinaryPath('mongorestore')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('mongorestore')
}

/**
 * 缺失 mongodump 时的错误提示信息
 * 引导用户通过 hostdb（首选）或 MongoDB 网站（回退）下载
 */
export const MONGODUMP_NOT_FOUND_ERROR =
  '未找到 mongodump。请下载 MongoDB 二进制文件：\n' +
  '  spindb engines download mongodb\n' +
  '\n' +
  '或从以下地址下载：\n' +
  '  https://www.mongodb.com/try/download/database-tools'

/**
 * 缺失 mongorestore 时的错误提示信息
 * 引导用户通过 hostdb（首选）或 MongoDB 网站（回退）下载
 */
export const MONGORESTORE_NOT_FOUND_ERROR =
  '未找到 mongorestore。请下载 MongoDB 二进制文件：\n' +
  '  spindb engines download mongodb\n' +
  '\n' +
  '或从以下地址下载：\n' +
  '  https://www.mongodb.com/try/download/database-tools'
