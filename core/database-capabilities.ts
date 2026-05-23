import { Engine, assertExhaustive } from '../types'

type DatabaseCapabilities = {
  supportsCreate: boolean
  supportsDrop: boolean
  supportsRename: 'native' | 'backup-restore' | false
  unsupportedReason?: string
}

function getDatabaseCapabilities(engine: Engine): DatabaseCapabilities {
  switch (engine) {
    // 完整支持 —— 创建、重命名（原生）、删除
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
    case Engine.ClickHouse:
    case Engine.Meilisearch:
      return {
        supportsCreate: true,
        supportsDrop: true,
        supportsRename: 'native',
      }

    // 完整支持 —— 创建、重命名（备份/恢复）、删除
    case Engine.MySQL:
    case Engine.MariaDB:
    case Engine.MongoDB:
    case Engine.FerretDB:
    case Engine.SurrealDB:
    case Engine.TypeDB:
    case Engine.InfluxDB:
    case Engine.CouchDB:
    case Engine.Qdrant:
    case Engine.Weaviate:
      return {
        supportsCreate: true,
        supportsDrop: true,
        supportsRename: 'backup-restore',
      }

    // 不支持 —— 基于文件
    case Engine.SQLite:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'SQLite 是基于文件的。文件本身就是数据库。使用 "spindb create" 创建新的数据库文件。',
      }
    case Engine.DuckDB:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'DuckDB 是基于文件的。文件本身就是数据库。使用 "spindb create" 创建新的数据库文件。',
      }

    // 不支持 —— 固定编号数据库
    case Engine.Redis:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'Redis 使用固定编号的数据库（0-15），它们始终存在。使用以下命令选择数据库：spindb run <容器> -c "SELECT 3"',
      }
    case Engine.Valkey:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'Valkey 使用固定编号的数据库（0-15），它们始终存在。使用以下命令选择数据库：spindb run <容器> -c "SELECT 3"',
      }

    // 不支持 —— 单数据库模型
    case Engine.QuestDB:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'QuestDB 使用单数据库模型（"qdb"）。使用以下命令直接创建表：spindb run <容器> -c "CREATE TABLE ..."',
      }

    // 不支持 —— 单账本
    case Engine.TigerBeetle:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'TigerBeetle 是具有固定模式的单账本实例。使用 "spindb delete" 移除整个账本。',
      }

    // 不支持 —— 每个服务器实例运行单个 SQLite 数据库
    case Engine.LibSQL:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'libSQL 每个服务器实例运行一个 SQLite 数据库。使用 "spindb create" 创建新实例。',
      }

    default:
      assertExhaustive(engine, `未知引擎：${engine}`)
  }
}

function canCreateDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsCreate
}

function canRenameDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsRename !== false
}

function canDropDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsDrop
}

function getUnsupportedCreateMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsCreate) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'SQLite 不支持创建数据库。文件本身就是数据库。使用 "spindb create" 创建新的数据库文件。'
    case Engine.DuckDB:
      return 'DuckDB 不支持创建数据库。文件本身就是数据库。使用 "spindb create" 创建新的数据库文件。'
    case Engine.Redis:
      return 'Redis 不支持创建数据库。Redis 使用固定编号的数据库（0-15），它们始终存在。使用以下命令选择数据库：spindb run <容器> -c "SELECT 3"'
    case Engine.Valkey:
      return 'Valkey 不支持创建数据库。Valkey 使用固定编号的数据库（0-15），它们始终存在。使用以下命令选择数据库：spindb run <容器> -c "SELECT 3"'
    case Engine.QuestDB:
      return 'QuestDB 不支持创建数据库。QuestDB 使用单数据库模型（"qdb"）。使用以下命令直接创建表：spindb run <容器> -c "CREATE TABLE ..."'
    case Engine.TigerBeetle:
      return 'TigerBeetle 不支持创建数据库。每个容器是具有固定模式的单账本实例。'
    default:
      return (
        caps.unsupportedReason ||
        `${engine} 不支持创建数据库。`
      )
  }
}

function getUnsupportedRenameMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsRename !== false) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'SQLite 不支持重命名数据库。使用 "spindb edit --relocate" 移动文件，或直接重命名后使用 "spindb attach" 重新挂载。'
    case Engine.DuckDB:
      return 'DuckDB 不支持重命名数据库。使用 "spindb edit --relocate" 移动文件，或直接重命名后使用 "spindb attach" 重新挂载。'
    case Engine.Redis:
      return 'Redis 不支持重命名数据库。Redis 数据库通过编号（0-15）标识，无法重命名。'
    case Engine.Valkey:
      return 'Valkey 不支持重命名数据库。Valkey 数据库通过编号（0-15）标识，无法重命名。'
    case Engine.QuestDB:
      return 'QuestDB 不支持重命名数据库。QuestDB 使用单数据库模型。'
    case Engine.TigerBeetle:
      return 'TigerBeetle 不支持重命名数据库。每个容器是单账本实例。'
    default:
      return (
        caps.unsupportedReason ||
        `${engine} 不支持重命名数据库。`
      )
  }
}

function getUnsupportedDropMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsDrop) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'SQLite 不支持删除数据库。使用 "spindb delete" 移除容器，或直接删除文件。'
    case Engine.DuckDB:
      return 'DuckDB 不支持删除数据库。使用 "spindb delete" 移除容器，或直接删除文件。'
    case Engine.Redis:
      return 'Redis 不支持删除数据库。使用 "spindb run" 执行 "FLUSHDB" 清空编号数据库。'
    case Engine.Valkey:
      return 'Valkey 不支持删除数据库。使用 "spindb run" 执行 "FLUSHDB" 清空编号数据库。'
    case Engine.QuestDB:
      return 'QuestDB 不支持删除数据库。QuestDB 使用单数据库模型。'
    case Engine.TigerBeetle:
      return 'TigerBeetle 不支持删除数据库。使用 "spindb delete" 移除整个账本。'
    default:
      return (
        caps.unsupportedReason ||
        `${engine} 不支持删除数据库。`
      )
  }
}

export {
  type DatabaseCapabilities,
  getDatabaseCapabilities,
  canCreateDatabase,
  canRenameDatabase,
  canDropDatabase,
  getUnsupportedCreateMessage,
  getUnsupportedRenameMessage,
  getUnsupportedDropMessage,
}
