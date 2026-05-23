/**
 * 所有引擎的集中式备份格式配置
 *
 * 此配置在以下场景提供一致的格式元数据：
 * - CLI 提示
 * - 文件扩展名
 * - 格式描述
 * - 加载动画消息
 */

import {
  Engine,
  type PostgreSQLFormat,
  type MySQLFormat,
  type MariaDBFormat,
  type SQLiteFormat,
  type DuckDBFormat,
  type MongoDBFormat,
  type FerretDBFormat,
  type RedisFormat,
  type ValkeyFormat,
  type ClickHouseFormat,
  type QdrantFormat,
  type MeilisearchFormat,
  type CouchDBFormat,
  type CockroachDBFormat,
  type SurrealDBFormat,
  type QuestDBFormat,
  type TypeDBFormat,
  type InfluxDBFormat,
  type WeaviateFormat,
  type TigerBeetleFormat,
  type LibSQLFormat,
  type BackupFormatType,
} from '../types'

export type BackupFormatInfo = {
  extension: string
  label: string
  description: string
  spinnerLabel: string
}

// 引擎备份格式的泛型类型
export type EngineBackupFormats<F extends string = string> = {
  formats: Record<F, BackupFormatInfo>
  supportsFormatChoice: boolean
  defaultFormat: F
}

// 按引擎分类的备份格式配置，使用语义化格式名称
export const BACKUP_FORMATS: {
  [Engine.PostgreSQL]: EngineBackupFormats<PostgreSQLFormat>
  [Engine.MySQL]: EngineBackupFormats<MySQLFormat>
  [Engine.MariaDB]: EngineBackupFormats<MariaDBFormat>
  [Engine.SQLite]: EngineBackupFormats<SQLiteFormat>
  [Engine.DuckDB]: EngineBackupFormats<DuckDBFormat>
  [Engine.MongoDB]: EngineBackupFormats<MongoDBFormat>
  [Engine.FerretDB]: EngineBackupFormats<FerretDBFormat>
  [Engine.Redis]: EngineBackupFormats<RedisFormat>
  [Engine.Valkey]: EngineBackupFormats<ValkeyFormat>
  [Engine.ClickHouse]: EngineBackupFormats<ClickHouseFormat>
  [Engine.Qdrant]: EngineBackupFormats<QdrantFormat>
  [Engine.Meilisearch]: EngineBackupFormats<MeilisearchFormat>
  [Engine.CouchDB]: EngineBackupFormats<CouchDBFormat>
  [Engine.CockroachDB]: EngineBackupFormats<CockroachDBFormat>
  [Engine.SurrealDB]: EngineBackupFormats<SurrealDBFormat>
  [Engine.QuestDB]: EngineBackupFormats<QuestDBFormat>
  [Engine.TypeDB]: EngineBackupFormats<TypeDBFormat>
  [Engine.InfluxDB]: EngineBackupFormats<InfluxDBFormat>
  [Engine.Weaviate]: EngineBackupFormats<WeaviateFormat>
  [Engine.TigerBeetle]: EngineBackupFormats<TigerBeetleFormat>
  [Engine.LibSQL]: EngineBackupFormats<LibSQLFormat>
} = {
  [Engine.PostgreSQL]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: '纯 SQL - 人类可读，文件较大',
        spinnerLabel: 'SQL 转储',
      },
      custom: {
        extension: '.dump',
        label: '.dump',
        description: '自定义格式 - 文件更小，恢复更快',
        spinnerLabel: '自定义格式',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.MySQL]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: '纯 SQL - 人类可读，文件较大',
        spinnerLabel: 'SQL 转储',
      },
      compressed: {
        extension: '.sql.gz',
        label: '.sql.gz',
        description: '压缩 SQL - 文件更小',
        spinnerLabel: '压缩 SQL',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.MariaDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: '纯 SQL - 人类可读，文件较大',
        spinnerLabel: 'SQL 转储',
      },
      compressed: {
        extension: '.sql.gz',
        label: '.sql.gz',
        description: '压缩 SQL - 文件更小',
        spinnerLabel: '压缩 SQL',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.SQLite]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - 人类可读，可移植',
        spinnerLabel: 'SQL 转储',
      },
      binary: {
        extension: '.sqlite',
        label: '.sqlite',
        description: '二进制复制 - 精确副本，速度更快',
        spinnerLabel: '二进制',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'binary',
  },
  [Engine.DuckDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - 人类可读，可移植',
        spinnerLabel: 'SQL 转储',
      },
      binary: {
        extension: '.duckdb',
        label: '.duckdb',
        description: '二进制复制 - 精确副本，速度更快',
        spinnerLabel: '二进制',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'binary',
  },
  [Engine.MongoDB]: {
    formats: {
      bson: {
        extension: '', // 目录，无扩展名
        label: '.bson',
        description: '目录转储 - 每个集合单独 BSON 文件',
        spinnerLabel: 'BSON 目录',
      },
      archive: {
        extension: '.archive',
        label: '.archive',
        description: '压缩归档 - 单文件，体积更小',
        spinnerLabel: '归档',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'archive',
  },
  [Engine.FerretDB]: {
    formats: {
      bson: {
        extension: '',
        label: '.bson',
        description: '目录转储 - 每个集合单独 BSON 文件',
        spinnerLabel: 'BSON 目录',
      },
      archive: {
        extension: '.archive',
        label: '.archive',
        description: '压缩归档 - 单文件，体积更小',
        spinnerLabel: '归档',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'archive',
  },
  [Engine.Redis]: {
    formats: {
      text: {
        extension: '.redis',
        label: '.redis',
        description: '文本命令 - 人类可读，可编辑',
        spinnerLabel: '文本',
      },
      rdb: {
        extension: '.rdb',
        label: '.rdb',
        description: 'RDB 快照 - 二进制格式，恢复更快',
        spinnerLabel: 'RDB 快照',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'rdb',
  },
  [Engine.Valkey]: {
    formats: {
      text: {
        extension: '.valkey',
        label: '.valkey',
        description: '文本命令 - 人类可读，可编辑',
        spinnerLabel: '文本',
      },
      rdb: {
        extension: '.rdb',
        label: '.rdb',
        description: 'RDB 快照 - 二进制格式，恢复更快',
        spinnerLabel: 'RDB 快照',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'rdb',
  },
  [Engine.ClickHouse]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - DDL + INSERT 语句',
        spinnerLabel: 'SQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 SQL 格式
    defaultFormat: 'sql',
  },
  [Engine.Qdrant]: {
    formats: {
      snapshot: {
        extension: '.snapshot',
        label: '.snapshot',
        description: 'Qdrant 快照 - 完整数据库备份',
        spinnerLabel: '快照',
      },
    },
    supportsFormatChoice: false, // 仅支持快照格式
    defaultFormat: 'snapshot',
  },
  [Engine.Meilisearch]: {
    formats: {
      snapshot: {
        extension: '.snapshot',
        label: '.snapshot',
        description: 'Meilisearch 快照 - 完整数据库备份',
        spinnerLabel: '快照',
      },
    },
    supportsFormatChoice: false, // 仅支持快照格式
    defaultFormat: 'snapshot',
  },
  [Engine.CouchDB]: {
    formats: {
      json: {
        extension: '.json',
        label: '.json',
        description: 'JSON 备份 - 所有文档导出为 JSON',
        spinnerLabel: 'JSON',
      },
    },
    supportsFormatChoice: false, // 仅支持 JSON 格式
    defaultFormat: 'json',
  },
  [Engine.CockroachDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - DDL + INSERT 语句',
        spinnerLabel: 'SQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 SQL 格式
    defaultFormat: 'sql',
  },
  [Engine.SurrealDB]: {
    formats: {
      surql: {
        extension: '.surql',
        label: '.surql',
        description: 'SurrealQL 转储 - 模式和数据以 SurrealQL 语句形式导出',
        spinnerLabel: 'SurrealQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 SurrealQL 格式
    defaultFormat: 'surql',
  },
  [Engine.QuestDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - 时间序列数据以 SQL 语句形式导出',
        spinnerLabel: 'SQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 SQL 格式
    defaultFormat: 'sql',
  },
  [Engine.TypeDB]: {
    formats: {
      typeql: {
        extension: '.typeql',
        label: '.typeql',
        description: 'TypeQL 转储 - 模式和数据以 TypeQL 语句形式导出',
        spinnerLabel: 'TypeQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 TypeQL 格式
    defaultFormat: 'typeql',
  },
  [Engine.InfluxDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - 时间序列数据以 SQL 语句形式导出',
        spinnerLabel: 'SQL 转储',
      },
    },
    supportsFormatChoice: false, // 仅支持 SQL 格式
    defaultFormat: 'sql',
  },
  [Engine.Weaviate]: {
    formats: {
      snapshot: {
        extension: '.snapshot',
        label: '.snapshot',
        description: 'Weaviate 快照 - 完整数据库备份',
        spinnerLabel: '快照',
      },
    },
    supportsFormatChoice: false, // 仅支持快照格式
    defaultFormat: 'snapshot',
  },
  [Engine.TigerBeetle]: {
    formats: {
      binary: {
        extension: '.tigerbeetle',
        label: '.tigerbeetle',
        description: 'TigerBeetle 数据文件 - 完整数据库副本',
        spinnerLabel: '二进制',
      },
    },
    supportsFormatChoice: false, // 仅支持二进制格式
    defaultFormat: 'binary',
  },
  [Engine.LibSQL]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL 转储 - 人类可读，可移植',
        spinnerLabel: 'SQL 转储',
      },
      binary: {
        extension: '.db',
        label: '.db',
        description: '二进制复制 - 精确副本，速度更快',
        spinnerLabel: '二进制',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'binary',
  },
}

/**
 * 类型守卫：验证字符串是否为有效的 Engine 枚举值
 */
export function isEngine(value: string): value is Engine {
  return Object.values(Engine).includes(value as Engine)
}

/**
 * 检查给定格式是否对指定的引擎有效
 * @param engine - 数据库引擎
 * @param format - 要验证的格式名称
 * @returns 如果格式对此引擎有效，则返回 true
 */
export function isValidFormat(engine: Engine, format: string): boolean {
  const engineFormats = BACKUP_FORMATS[engine]
  return format in engineFormats.formats
}

/**
 * 获取引擎的有效格式名称
 * @param engine - 数据库引擎
 * @returns 有效格式名称的数组
 */
export function getValidFormats(engine: Engine): string[] {
  return Object.keys(BACKUP_FORMATS[engine].formats)
}

// 获取引擎特定格式的备份格式信息
export function getBackupFormatInfo(
  engine: Engine,
  format: BackupFormatType,
): BackupFormatInfo {
  const engineFormats = BACKUP_FORMATS[engine]
  // 需要类型断言，因为 TypeScript 无法将联合类型缩小到特定引擎的格式
  const formatInfo =
    engineFormats.formats[format as keyof typeof engineFormats.formats]

  if (!formatInfo) {
    const validFormats = Object.keys(engineFormats.formats).join(', ')
    throw new Error(
      `无效的备份格式 "${format}"，引擎 ${engine} 不支持。有效格式：${validFormats}`,
    )
  }

  return formatInfo
}

// 获取备份格式的文件扩展名
export function getBackupExtension(
  engine: Engine,
  format: BackupFormatType,
): string {
  return getBackupFormatInfo(engine, format).extension
}

// 获取备份格式的加载动画标签
export function getBackupSpinnerLabel(
  engine: Engine,
  format: BackupFormatType,
): string {
  return getBackupFormatInfo(engine, format).spinnerLabel
}

// 检查引擎是否支持格式选择
export function supportsFormatChoice(engine: Engine): boolean {
  return BACKUP_FORMATS[engine].supportsFormatChoice
}

// 获取引擎的默认格式
export function getDefaultFormat(engine: Engine): BackupFormatType {
  return BACKUP_FORMATS[engine].defaultFormat
}

// 大型备份阈值（100MB）—— 恢复前警告用户
export const LARGE_BACKUP_THRESHOLD = 100 * 1024 * 1024

// 超大型备份阈值（1GB）—— 需要二次确认
export const VERY_LARGE_BACKUP_THRESHOLD = 1024 * 1024 * 1024
