/**
 * hostdb 版本同步验证测试
 *
 * 在 spindb→hostdb 迁移之后，每个引擎的 VERSION_MAP 都是在导入时从内置的 hostdb npm 包中的 databases.json +
 * releases.json 快照构建的。
 *
 * 本测试验证 *内置* 快照与 GitHub 上托管的 *实时* releases.json 是否一致。它可以捕获：
 *   - 锁定的 `hostdb` 依赖项落后于最新的 hostdb 发布版
 *     （新版本已发布；spindb 尚未更新依赖）。
 *   - 已发布的 hostdb 包中的内置 releases.json 相对于 R2 上的实际内容过时
 *     （hostdb 的构建流水线问题）。
 *
 * 冒烟测试语义：spindb 的 MAP 发出的每个完整版本（现在只是 hostdb 数据的薄视图）必须作为已知发布版存在于实时 hostdb 注册表中。
 * 任何缺失都意味着 spindb 将尝试下载 R2 不提供的发布版。
 *
 * 需要网络访问。
 */

import { describe, it, before } from 'node:test'
import {
  fetchHostdbReleases,
  getEngineReleases,
  type HostdbReleasesData,
} from '../../core/hostdb-client'

import { POSTGRESQL_VERSION_MAP } from '../../engines/postgresql/version-maps'
import { MYSQL_VERSION_MAP } from '../../engines/mysql/version-maps'
import { MARIADB_VERSION_MAP } from '../../engines/mariadb/version-maps'
import { MONGODB_VERSION_MAP } from '../../engines/mongodb/version-maps'
import { REDIS_VERSION_MAP } from '../../engines/redis/version-maps'
import { SQLITE_VERSION_MAP } from '../../engines/sqlite/version-maps'
import { CLICKHOUSE_VERSION_MAP } from '../../engines/clickhouse/version-maps'
import { COCKROACHDB_VERSION_MAP } from '../../engines/cockroachdb/version-maps'
import { COUCHDB_VERSION_MAP } from '../../engines/couchdb/version-maps'
import { DUCKDB_VERSION_MAP } from '../../engines/duckdb/version-maps'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
} from '../../engines/ferretdb/version-maps'
import { MEILISEARCH_VERSION_MAP } from '../../engines/meilisearch/version-maps'
import { QDRANT_VERSION_MAP } from '../../engines/qdrant/version-maps'
import { QUESTDB_VERSION_MAP } from '../../engines/questdb/version-maps'
import { SURREALDB_VERSION_MAP } from '../../engines/surrealdb/version-maps'
import { TYPEDB_VERSION_MAP } from '../../engines/typedb/version-maps'
import { VALKEY_VERSION_MAP } from '../../engines/valkey/version-maps'
import { INFLUXDB_VERSION_MAP } from '../../engines/influxdb/version-maps'
import { WEAVIATE_VERSION_MAP } from '../../engines/weaviate/version-maps'
import { TIGERBEETLE_VERSION_MAP } from '../../engines/tigerbeetle/version-maps'
import { LIBSQL_VERSION_MAP } from '../../engines/libsql/version-maps'

const ENGINES = [
  { name: 'postgresql', map: POSTGRESQL_VERSION_MAP },
  { name: 'mysql', map: MYSQL_VERSION_MAP },
  { name: 'mariadb', map: MARIADB_VERSION_MAP },
  { name: 'mongodb', map: MONGODB_VERSION_MAP },
  { name: 'redis', map: REDIS_VERSION_MAP },
  { name: 'sqlite', map: SQLITE_VERSION_MAP },
  { name: 'clickhouse', map: CLICKHOUSE_VERSION_MAP },
  { name: 'cockroachdb', map: COCKROACHDB_VERSION_MAP },
  { name: 'couchdb', map: COUCHDB_VERSION_MAP },
  { name: 'duckdb', map: DUCKDB_VERSION_MAP },
  { name: 'ferretdb', map: FERRETDB_VERSION_MAP },
  { name: 'postgresql-documentdb', map: DOCUMENTDB_VERSION_MAP },
  { name: 'meilisearch', map: MEILISEARCH_VERSION_MAP },
  { name: 'qdrant', map: QDRANT_VERSION_MAP },
  { name: 'questdb', map: QUESTDB_VERSION_MAP },
  { name: 'surrealdb', map: SURREALDB_VERSION_MAP },
  { name: 'typedb', map: TYPEDB_VERSION_MAP },
  { name: 'valkey', map: VALKEY_VERSION_MAP },
  { name: 'influxdb', map: INFLUXDB_VERSION_MAP },
  { name: 'weaviate', map: WEAVIATE_VERSION_MAP },
  { name: 'tigerbeetle', map: TIGERBEETLE_VERSION_MAP },
  { name: 'libsql', map: LIBSQL_VERSION_MAP },
] as const

describe('hostdb 版本同步验证', () => {
  let hostdbReleases: HostdbReleasesData

  before(async () => {
    console.log('\n🌐 正在获取实时 hostdb releases.json...')
    try {
      hostdbReleases = await fetchHostdbReleases()
      console.log(
        `   ✓ 已获取实时发布版 (更新时间: ${hostdbReleases.updatedAt})`,
      )
    } catch (error) {
      const err = error as Error
      console.error(`   ✗ 获取发布版失败: ${err.message}`)
      throw new Error('无法在没有网络访问 hostdb 的情况下验证版本同步')
    }
  })

  for (const { name, map } of ENGINES) {
    it(`${name} 内置 hostdb 快照与实时发布版匹配`, () => {
      const releases = getEngineReleases(hostdbReleases, name)

      if (!releases) {
        throw new Error(
          `在实时 hostdb releases.json 中未找到引擎 '${name}'。` +
            `可用引擎: ${Object.keys(hostdbReleases.databases).join(', ')}`,
        )
      }

      const availableVersions = Object.keys(releases)
      const mappedVersions = Object.values(map)
      const missingVersions: string[] = []

      for (const version of mappedVersions) {
        if (!availableVersions.includes(version)) {
          missingVersions.push(version)
        }
      }

      if (missingVersions.length > 0) {
        throw new Error(
          `${name} 版本漂移！\n` +
            `  内置 hostdb 快照期望的版本: ${missingVersions.join(', ')}\n` +
            `  实时 hostdb releases.json 中的版本:   ${availableVersions.join(', ')}\n` +
            `  修复方法: 将 package.json 中的 'hostdb' 依赖项升级到较新版本 ` +
            `(或者，如果内置快照领先于实时注册表，下一次 hostdb 发布版将把这些缺失的二进制文件发布到 R2)。`,
        )
      }

      console.log(
        `   ✓ ${name}: ${mappedVersions.length} 个版本已验证 (${mappedVersions.join(', ')})`,
      )
    })
  }

  it('所有实时 hostdb 引擎均在 SpinDB 中体现', () => {
    const hostdbEngines = Object.keys(hostdbReleases.databases)
    const spindbEngines: string[] = ENGINES.map((e) => e.name)
    const missingEngines = hostdbEngines.filter(
      (e) => !spindbEngines.includes(e),
    )

    if (missingEngines.length > 0) {
      const message = `hostdb 中有尚未在 SpinDB 中实现的引擎: ${missingEngines.join(', ')}`
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${message}`)
      }
      console.warn(`   ⚠ ${message}`)
    }

    console.log(
      `   ✓ SpinDB 覆盖了 ${spindbEngines.length}/${hostdbEngines.length} 个 hostdb 引擎`,
    )
  })
})
