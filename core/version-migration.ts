/**
 * 版本迁移工具，用于检测和更新过期的容器版本
 *
 * 检测使用版本映射中不再存在的版本的容器
 * （例如来自 zonky.io 时代的版本），并迁移到当前
 * 支持的版本，同时保持主版本兼容性。
 */

import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { paths } from '../config/paths'
import { containerManager } from './container-manager'
import { platformService } from './platform-service'
import { Engine, isFileBasedEngine, type ContainerConfig } from '../types'

// 从所有引擎导入版本映射
import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as PG_MAJORS,
} from '../engines/postgresql/version-maps'
import {
  MYSQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MYSQL_MAJORS,
} from '../engines/mysql/version-maps'
import {
  MARIADB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MARIADB_MAJORS,
} from '../engines/mariadb/version-maps'
import {
  MONGODB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MONGODB_MAJORS,
} from '../engines/mongodb/version-maps'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as FERRET_MAJORS,
} from '../engines/ferretdb/version-maps'
import {
  REDIS_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as REDIS_MAJORS,
} from '../engines/redis/version-maps'
import {
  VALKEY_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as VALKEY_MAJORS,
} from '../engines/valkey/version-maps'
import {
  CLICKHOUSE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as CH_MAJORS,
} from '../engines/clickhouse/version-maps'
import {
  QDRANT_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as QDRANT_MAJORS,
} from '../engines/qdrant/version-maps'
import {
  MEILISEARCH_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MEILI_MAJORS,
} from '../engines/meilisearch/version-maps'

type VersionMapInfo = {
  versionMap: Record<string, string>
  majorVersions: readonly string[]
}

// 每个引擎的版本映射注册表
const VERSION_MAPS: Partial<Record<Engine, VersionMapInfo>> = {
  [Engine.PostgreSQL]: {
    versionMap: POSTGRESQL_VERSION_MAP,
    majorVersions: PG_MAJORS,
  },
  [Engine.MySQL]: {
    versionMap: MYSQL_VERSION_MAP,
    majorVersions: MYSQL_MAJORS,
  },
  [Engine.MariaDB]: {
    versionMap: MARIADB_VERSION_MAP,
    majorVersions: MARIADB_MAJORS,
  },
  [Engine.MongoDB]: {
    versionMap: MONGODB_VERSION_MAP,
    majorVersions: MONGODB_MAJORS,
  },
  [Engine.FerretDB]: {
    versionMap: FERRETDB_VERSION_MAP,
    majorVersions: FERRET_MAJORS,
  },
  [Engine.Redis]: {
    versionMap: REDIS_VERSION_MAP,
    majorVersions: REDIS_MAJORS,
  },
  [Engine.Valkey]: {
    versionMap: VALKEY_VERSION_MAP,
    majorVersions: VALKEY_MAJORS,
  },
  [Engine.ClickHouse]: {
    versionMap: CLICKHOUSE_VERSION_MAP,
    majorVersions: CH_MAJORS,
  },
  [Engine.Qdrant]: {
    versionMap: QDRANT_VERSION_MAP,
    majorVersions: QDRANT_MAJORS,
  },
  [Engine.Meilisearch]: {
    versionMap: MEILISEARCH_VERSION_MAP,
    majorVersions: MEILI_MAJORS,
  },
}

// FerretDB 后端（DocumentDB）的单独映射
const DOCUMENTDB_INFO: VersionMapInfo = {
  versionMap: DOCUMENTDB_VERSION_MAP,
  majorVersions: ['17'],
}

export type OutdatedContainer = {
  container: ContainerConfig
  currentVersion: string
  targetVersion: string
  majorVersion: string
  field: 'version' | 'backendVersion'
}

/**
 * 通过检查前缀与 SUPPORTED_MAJOR_VERSIONS 的匹配，
 * 查找完整版本所属的主版本。
 *
 * 不同引擎使用不同的主版本格式：
 * - PostgreSQL: 单数字（例如 '17'）
 * - MySQL: 两段式（例如 '8.4'）
 * - MariaDB: 两段式（例如 '11.8'）
 * - MongoDB: 两段式（例如 '8.0'）
 * - ClickHouse: 两段式 YY.MM（例如 '25.12'）
 * - Redis/Valkey: 单数字（例如 '7', '8'）
 * - Qdrant/Meilisearch: 单数字（例如 '1'）
 *
 * @param engine - 数据库引擎
 * @param version - 完整版本字符串（例如 '17.2.0'）
 * @returns 主版本字符串，未找到则返回 null
 */
export function getMajorVersion(
  engine: Engine,
  version: string,
): string | null {
  const info = VERSION_MAPS[engine]
  if (!info) return null

  // 按长度降序排序，使 "8.4" 在 "8" 之前匹配
  const sorted = [...info.majorVersions].sort((a, b) => b.length - a.length)
  for (const major of sorted) {
    if (version.startsWith(major + '.') || version === major) {
      return major
    }
  }
  return null
}

/**
 * 获取 FerretDB 后端（DocumentDB）的主版本。
 * 后端版本使用 "17-0.107.0" 格式，其中 "17" 是主版本。
 */
export function getDocumentDBMajorVersion(version: string): string | null {
  // 格式: "17-0.107.0" -> 主版本为 "17"
  const dashIndex = version.indexOf('-')
  if (dashIndex > 0) {
    const major = version.substring(0, dashIndex)
    if (DOCUMENTDB_INFO.majorVersions.includes(major)) {
      return major
    }
  }
  return null
}

/**
 * 检查版本是否作为版本映射中的值存在
 * （不仅仅是键）。
 *
 * @param engine - 数据库引擎
 * @param version - 要检查的版本字符串
 * @returns 如果版本是受支持的完整版本则返回 true
 */
export function isVersionSupported(engine: Engine, version: string): boolean {
  const info = VERSION_MAPS[engine]
  if (!info) return false

  const supportedVersions = Object.values(info.versionMap)
  return supportedVersions.includes(version)
}

/**
 * 检查 DocumentDB 后端版本是否受支持。
 */
export function isDocumentDBVersionSupported(version: string): boolean {
  const supportedVersions = Object.values(DOCUMENTDB_INFO.versionMap)
  return supportedVersions.includes(version)
}

/**
 * 获取主版本对应的当前完整版本。
 *
 * @param engine - 数据库引擎
 * @param majorVersion - 主版本（例如 '17', '8.4'）
 * @returns 当前完整版本，未找到则返回 null
 */
export function getTargetVersion(
  engine: Engine,
  majorVersion: string,
): string | null {
  const info = VERSION_MAPS[engine]
  if (!info) return null

  return info.versionMap[majorVersion] || null
}

/**
 * 获取 DocumentDB 主版本对应的当前完整版本。
 */
export function getDocumentDBTargetVersion(
  majorVersion: string,
): string | null {
  return DOCUMENTDB_INFO.versionMap[majorVersion] || null
}

/**
 * 查找所有版本过期的容器。
 * 返回版本不在当前版本映射中的容器。
 *
 * @returns 过期容器信息数组
 */
export async function findOutdatedContainers(): Promise<OutdatedContainer[]> {
  const containers = await containerManager.list()
  const outdated: OutdatedContainer[] = []

  for (const container of containers) {
    const engine = container.engine as Engine

    // 跳过基于文件的引擎 - 它们使用简化的主版本（例如 "3", "1"）
    // 始终解析为当前版本
    if (isFileBasedEngine(engine)) {
      continue
    }

    // 检查主版本
    if (!isVersionSupported(engine, container.version)) {
      const majorVersion = getMajorVersion(engine, container.version)
      if (majorVersion) {
        const targetVersion = getTargetVersion(engine, majorVersion)
        if (targetVersion && targetVersion !== container.version) {
          outdated.push({
            container,
            currentVersion: container.version,
            targetVersion,
            majorVersion,
            field: 'version',
          })
        }
      }
    }

    // 检查 FerretDB 后端版本
    if (engine === Engine.FerretDB && container.backendVersion) {
      if (!isDocumentDBVersionSupported(container.backendVersion)) {
        const majorVersion = getDocumentDBMajorVersion(container.backendVersion)
        if (majorVersion) {
          const targetVersion = getDocumentDBTargetVersion(majorVersion)
          if (targetVersion && targetVersion !== container.backendVersion) {
            outdated.push({
              container,
              currentVersion: container.backendVersion,
              targetVersion,
              majorVersion,
              field: 'backendVersion',
            })
          }
        }
      }
    }
  }

  return outdated
}

/**
 * 更新容器配置文件中的版本。
 *
 * @param name - 容器名称
 * @param targetVersion - 要设置的新版本
 * @param field - 要更新的字段（'version' 或 'backendVersion'）
 */
export async function migrateContainerVersion(
  name: string,
  targetVersion: string,
  field: 'version' | 'backendVersion',
): Promise<void> {
  await containerManager.updateConfig(name, { [field]: targetVersion })
}

/**
 * 检查是否有容器正在使用特定版本。
 *
 * @param engine - 数据库引擎
 * @param version - 要检查的版本
 * @returns 如果至少有一个容器使用此版本则返回 true
 */
export async function isVersionInUse(
  engine: Engine,
  version: string,
): Promise<boolean> {
  const containers = await containerManager.list()
  return containers.some(
    (c) =>
      c.engine === engine &&
      (c.version === version || c.backendVersion === version),
  )
}

/**
 * 从 ~/.spindb/bin/ 中删除旧的二进制目录
 * 仅在没有其他容器使用此版本时才删除。
 *
 * @param engine - 数据库引擎
 * @param oldVersion - 要移除的旧版本
 * @returns 如果二进制文件已删除返回 true，如果仍在使用或未找到返回 false
 */
export async function deleteOldBinaryIfUnused(
  engine: Engine | string,
  oldVersion: string,
): Promise<boolean> {
  // 检查是否仍有容器使用此版本
  if (await isVersionInUse(engine as Engine, oldVersion)) {
    return false
  }

  const platformInfo = platformService.getPlatformInfo()
  const binaryPath = paths.getBinaryPath({
    engine: engine as string,
    version: oldVersion,
    platform: platformInfo.platform,
    arch: platformInfo.arch,
  })

  if (existsSync(binaryPath)) {
    await rm(binaryPath, { recursive: true, force: true })
    return true
  }

  return false
}
