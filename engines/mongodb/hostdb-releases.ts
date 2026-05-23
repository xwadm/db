/**
 * MongoDB hostdb 发布版本集成
 *
 * 从 hostdb 仓库（https://github.com/robertjbass/hostdb）获取
 * 可用的 MongoDB 版本。
 *
 * hostdb 提供多平台的预构建 MongoDB 二进制文件。
 */

import { logDebug } from '../../core/error-handler'
import { FALLBACK_VERSION_MAP } from './version-maps'
import { isNewerVersion } from '../../core/version-utils'
import { mongodbBinaryManager } from './binary-manager'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { Engine } from '../../types'

/**
 * 从 hostdb databases.json 获取可用的 MongoDB 版本
 * 回退到本地已安装版本，然后是硬编码版本映射表
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string>
> {
  // 尝试从 hostdb databases.json 获取（权威数据源）
  try {
    const versions = await getHostdbVersions(Engine.MongoDB)

    if (versions && versions.length > 0) {
      const versionMap: Record<string, string> = {}

      // 遍历版本字符串（例如 "7.0.28"、"8.0.17"、"8.2.3"）
      for (const fullVersion of versions) {
        // 提取主版本.次版本（例如 "7.0.28" -> "7.0"）
        const parts = fullVersion.split('.')
        if (parts.length >= 2) {
          const majorMinor = `${parts[0]}.${parts[1]}`
          // 保留每个主版本.次版本的最新完整版本
          if (
            !versionMap[majorMinor] ||
            isNewerVersion(fullVersion, versionMap[majorMinor])
          ) {
            versionMap[majorMinor] = fullVersion
          }
        }
      }

      logDebug('已从 hostdb 获取 MongoDB 版本', { versions: versionMap })
      return versionMap
    }
  } catch (error) {
    logDebug('从 hostdb 获取 MongoDB 版本失败，正在检查本地版本', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // 离线回退：仅返回本地已安装版本
  const installed = await mongodbBinaryManager.listInstalled()
  if (installed.length > 0) {
    const versionMap: Record<string, string> = {}
    for (const binary of installed) {
      // MongoDB 使用 X.Y 格式表示主版本
      const parts = binary.version.split('.')
      if (parts.length >= 2) {
        const majorMinor = `${parts[0]}.${parts[1]}`
        // 保留每个主版本.次版本的最新完整版本
        if (
          !versionMap[majorMinor] ||
          isNewerVersion(binary.version, versionMap[majorMinor])
        ) {
          versionMap[majorMinor] = binary.version
        }
      }
    }
    logDebug('使用本地已安装的 MongoDB 版本', {
      versions: versionMap,
    })
    return versionMap
  }

  // 最后手段：返回硬编码版本映射表
  logDebug('使用回退 MongoDB 版本映射表')
  return FALLBACK_VERSION_MAP
}

// 获取主版本.次版本对应的最新完整版本
export async function getLatestVersion(
  majorMinor: string,
): Promise<string | null> {
  const versions = await fetchAvailableVersions()
  return versions[majorMinor] || null
}
