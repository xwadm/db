/**
 * hostdb Releases 工厂
 *
 * 为数据库引擎创建标准化的 hostdb-releases 模块。
 * 这减少了遵循相同模式的引擎之间的代码重复。
 *
 * 工厂创建两个函数：
 * - fetchAvailableVersions(): 获取按主版本分组的可用版本
 * - getLatestVersion(major): 获取指定主版本下的最新版本
 */

import { compareVersions } from './version-utils'
import {
  getAvailableVersions as getHostdbVersions,
  getDeprecatedVersions as getHostdbDeprecatedVersions,
} from './hostdb-metadata'
import { logDebug } from './error-handler'
import type { Engine, InstalledBinary } from '../types'

/**
 * 版本号的分组策略：
 * - 'single-digit': 按第一段分组（例如 17.7.0 -> 17）
 * - 'xy-format': 按前两段分组（例如 8.0.40 -> 8.0）
 */
export type GroupingStrategy = 'single-digit' | 'xy-format'

/**
 * 创建 hostdb-releases 函数的配置
 */
export type HostdbReleasesConfig = {
  /** 引擎枚举值 */
  engine: Engine
  /** 日志消息中的显示名称 */
  displayName: string
  /** 从主版本到完整版本的映射 */
  versionMap: Record<string, string>
  /** 支持的主版本列表 */
  supportedMajorVersions: readonly string[]
  /** 按主版本分组版本的策略 */
  groupingStrategy: GroupingStrategy
  /** 列出已安装二进制文件用于离线回退的函数 */
  listInstalled: () => Promise<InstalledBinary[]>
  /**
   * 可选的自定义提取主版本函数。
   * 用于具有非标准版本分组的引擎（例如 ClickHouse 的 YY.MM，
   * MySQL 的条件性 X.Y vs X 分组）。
   */
  getMajorVersion?: (version: string) => string
}

/**
 * 工厂的返回类型
 */
export type HostdbReleasesModule = {
  fetchAvailableVersions: () => Promise<Record<string, string[]>>
  getLatestVersion: (major: string) => Promise<string>
  fetchDeprecatedVersions: () => Promise<Set<string>>
}

/**
 * 基于分组策略提取主版本的默认函数
 */
function defaultGetMajorVersion(
  version: string,
  strategy: GroupingStrategy,
): string {
  const trimmed = version?.trim()
  if (!trimmed) {
    return ''
  }
  const parts = trimmed.split('.')
  if (strategy === 'xy-format') {
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : (parts[0] ?? '')
  }
  return parts[0] ?? ''
}

/**
 * 为引擎创建 hostdb-releases 函数
 */
export function createHostdbReleases(
  config: HostdbReleasesConfig,
): HostdbReleasesModule {
  const {
    engine,
    displayName,
    versionMap,
    supportedMajorVersions,
    groupingStrategy,
    listInstalled,
  } = config

  // 如果提供了自定义 getMajorVersion 则使用，否则使用默认值
  const getMajorVersion =
    config.getMajorVersion ??
    ((version: string) => defaultGetMajorVersion(version, groupingStrategy))

  // fetchAvailableVersions 的缓存，避免重复网络请求
  let cachedVersions: Record<string, string[]> | null = null
  let cachedAt = 0
  const cacheTTLMs = 30_000 // 30 秒
  let inflightFetchPromise: Promise<Record<string, string[]>> | null = null

  /**
   * 获取硬编码版本作为最后的回退
   */
  function getHardcodedVersions(): Record<string, string[]> {
    const grouped: Record<string, string[]> = {}
    for (const major of supportedMajorVersions) {
      const version = versionMap[major]
      if (version) {
        grouped[major] = [version]
      }
    }
    return grouped
  }

  /**
   * 从 hostdb 获取可用版本，按主版本分组
   */
  async function fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // 尝试从 hostdb databases.json 获取（权威来源）
    try {
      const versions = await getHostdbVersions(engine)

      if (versions && versions.length > 0) {
        // 按主版本分组
        const grouped: Record<string, string[]> = {}

        for (const version of versions) {
          const major = getMajorVersion(version)
          if (!grouped[major]) {
            grouped[major] = []
          }
          grouped[major].push(version)
        }

        // 每组按降序排序（最新版本在前）
        for (const major of Object.keys(grouped)) {
          grouped[major].sort((a, b) => compareVersions(b, a))
        }

        return grouped
      }
    } catch (error) {
      logDebug(
        `从 hostdb 获取 ${displayName} 版本失败，检查本地安装`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      )
    }

    // 离线回退：仅返回本地已安装的版本
    const installed = await listInstalled()
    if (installed.length > 0) {
      const result: Record<string, string[]> = {}
      for (const binary of installed) {
        const major = getMajorVersion(binary.version)
        if (!result[major]) {
          result[major] = []
        }
        if (!result[major].includes(binary.version)) {
          result[major].push(binary.version)
        }
      }
      // 每个主版本组按降序排序
      for (const major of Object.keys(result)) {
        result[major].sort((a, b) => compareVersions(b, a))
      }
      return result
    }

    // 最后手段：返回硬编码的版本映射
    return getHardcodedVersions()
  }

  /**
   * 如果缓存新鲜则返回缓存版本，否则获取并缓存。
   * 使用 inflightFetchPromise 去重并发请求。
   */
  async function getCachedVersions(): Promise<Record<string, string[]>> {
    const now = Date.now()

    // 如果缓存新鲜则返回缓存结果
    if (cachedVersions && now - cachedAt < cacheTTLMs) {
      return cachedVersions
    }

    // 如果有进行中的请求，等待它而不是启动新请求
    if (inflightFetchPromise) {
      return inflightFetchPromise
    }

    // 启动新的获取，存储 promise 以去重并发调用
    inflightFetchPromise = fetchAvailableVersions()
      .then((versions) => {
        cachedVersions = versions
        cachedAt = Date.now()
        inflightFetchPromise = null
        return versions
      })
      .catch((error) => {
        // 出错时清除进行中的 promise，以便后续调用可以重试
        inflightFetchPromise = null
        throw error
      })

    return inflightFetchPromise
  }

  /**
   * 从 hostdb 获取指定主版本下的最新版本。
   * 使用缓存的 fetchAvailableVersions 结果以避免重复网络请求。
   */
  async function getLatestVersion(major: string): Promise<string> {
    const versions = await getCachedVersions()
    const majorVersions = versions[major]
    if (majorVersions && majorVersions.length > 0) {
      return majorVersions[0] // 第一个是最新版本（因为降序排序）
    }

    // 回退到版本映射
    if (versionMap[major]) {
      return versionMap[major]
    }

    // 基于分组策略生成默认版本
    if (groupingStrategy === 'xy-format') {
      // 对于 X.Y 格式，添加 .0 得到 X.Y.0
      return `${major}.0`
    }
    // 对于 single-digit，添加 .0.0 得到 X.0.0
    return `${major}.0.0`
  }

  // 已弃用版本的缓存
  let cachedDeprecated: Set<string> | null = null
  let deprecatedCachedAt = 0

  async function fetchDeprecatedVersions(): Promise<Set<string>> {
    const now = Date.now()
    if (cachedDeprecated && now - deprecatedCachedAt < cacheTTLMs) {
      return cachedDeprecated
    }

    try {
      cachedDeprecated = await getHostdbDeprecatedVersions(engine)
      deprecatedCachedAt = Date.now()
      return cachedDeprecated
    } catch (error) {
      logDebug(`获取 ${displayName} 的已弃用版本失败`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return new Set()
    }
  }

  return {
    fetchAvailableVersions: getCachedVersions,
    getLatestVersion,
    fetchDeprecatedVersions,
  }
}
