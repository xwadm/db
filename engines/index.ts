import { postgresqlEngine } from './postgresql'
import { mysqlEngine } from './mysql'
import { mariadbEngine } from './mariadb'
import { sqliteEngine } from './sqlite'
import { duckdbEngine } from './duckdb'
import { mongodbEngine } from './mongodb'
import { ferretdbEngine } from './ferretdb'
import { redisEngine } from './redis'
import { valkeyEngine } from './valkey'
import { clickhouseEngine } from './clickhouse'
import { qdrantEngine } from './qdrant'
import { meilisearchEngine } from './meilisearch'
import { couchdbEngine } from './couchdb'
import { cockroachdbEngine } from './cockroachdb'
import { surrealdbEngine } from './surrealdb'
import { questdbEngine } from './questdb'
import { typedbEngine } from './typedb'
import { influxdbEngine } from './influxdb'
import { weaviateEngine } from './weaviate'
import { tigerbeetleEngine } from './tigerbeetle'
import { libsqlEngine } from './libsql'
import { platformService } from '../core/platform-service'
import { Engine, Platform } from '../types'
import type { BaseEngine } from './base-engine'
import type { EngineInfo } from '../types'

// 不受 Windows 支持的引擎
// 这些引擎要么没有 Windows 二进制文件，要么在 Windows 上运行存在问题
// 注意：FerretDB v1 支持 Windows（v2 不支持），因此没有在此处全部阻止。
// 版本相关的平台检查由引擎自身处理。
const WINDOWS_UNSUPPORTED_ENGINES = new Set([Engine.ClickHouse, Engine.LibSQL])

// 可用的数据库引擎注册表
export const engines: Record<string, BaseEngine> = {
  // PostgreSQL 及其别名
  [Engine.PostgreSQL]: postgresqlEngine,
  postgres: postgresqlEngine,
  pg: postgresqlEngine,
  // MySQL 及其别名
  [Engine.MySQL]: mysqlEngine,
  // MariaDB（独立引擎，带有可下载的二进制文件）
  [Engine.MariaDB]: mariadbEngine,
  maria: mariadbEngine,
  // SQLite 及其别名
  [Engine.SQLite]: sqliteEngine,
  lite: sqliteEngine,
  // DuckDB 及其别名
  [Engine.DuckDB]: duckdbEngine,
  duck: duckdbEngine,
  // MongoDB 及其别名
  [Engine.MongoDB]: mongodbEngine,
  mongo: mongodbEngine,
  // FerretDB 及其别名
  [Engine.FerretDB]: ferretdbEngine,
  ferret: ferretdbEngine,
  fdb: ferretdbEngine,
  // Redis 及其别名
  [Engine.Redis]: redisEngine,
  // Valkey 及其别名
  [Engine.Valkey]: valkeyEngine,
  // ClickHouse 及其别名
  [Engine.ClickHouse]: clickhouseEngine,
  ch: clickhouseEngine,
  // Qdrant 及其别名
  [Engine.Qdrant]: qdrantEngine,
  qd: qdrantEngine,
  // Meilisearch 及其别名
  [Engine.Meilisearch]: meilisearchEngine,
  meili: meilisearchEngine,
  ms: meilisearchEngine,
  // CouchDB 及其别名
  [Engine.CouchDB]: couchdbEngine,
  couch: couchdbEngine,
  // CockroachDB 及其别名
  [Engine.CockroachDB]: cockroachdbEngine,
  crdb: cockroachdbEngine,
  // SurrealDB 及其别名
  [Engine.SurrealDB]: surrealdbEngine,
  surreal: surrealdbEngine,
  // QuestDB 及其别名
  [Engine.QuestDB]: questdbEngine,
  quest: questdbEngine,
  // TypeDB 及其别名
  [Engine.TypeDB]: typedbEngine,
  tdb: typedbEngine,
  // InfluxDB 及其别名
  [Engine.InfluxDB]: influxdbEngine,
  influx: influxdbEngine,
  // Weaviate 及其别名
  [Engine.Weaviate]: weaviateEngine,
  wv: weaviateEngine,
  // TigerBeetle 及其别名
  [Engine.TigerBeetle]: tigerbeetleEngine,
  tb: tigerbeetleEngine,
  // LibSQL 及其别名
  [Engine.LibSQL]: libsqlEngine,
  sqld: libsqlEngine,
}

// 通过名称获取引擎
export function getEngine(name: string): BaseEngine {
  const engine = engines[name.toLowerCase()]
  if (!engine) {
    const available = [...new Set(Object.values(engines))].map((e) => e.name)
    throw new Error(`未知的引擎 "${name}"。可用引擎：${available.join(', ')}`)
  }
  return engine
}

// 列出所有可用的引擎（按平台支持情况过滤）
export function listEngines(): EngineInfo[] {
  const { platform } = platformService.getPlatformInfo()
  const isWindows = platform === Platform.Win32
  const seen = new Set<BaseEngine>()

  return Object.entries(engines)
    .filter(([, engine]) => {
      if (seen.has(engine)) return false
      seen.add(engine)
      // 在 Windows 上过滤掉不支持的引擎
      if (isWindows && WINDOWS_UNSUPPORTED_ENGINES.has(engine.name as Engine)) {
        return false
      }
      return true
    })
    .map(([, engine]) => ({
      name: engine.name,
      displayName: engine.displayName,
      defaultPort: engine.defaultPort,
      supportedVersions: engine.supportedVersions,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
