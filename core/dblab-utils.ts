import { Engine, type ContainerConfig } from '../types'

/** 固定的 dblab 版本 —— 下载 URL 的唯一真实来源 */
export const DBLAB_VERSION = '0.34.2'

/** 支持 dblab 的数据库引擎（PostgreSQL、MySQL 或 SQLite 线协议） */
export const DBLAB_ENGINES = new Set([
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MariaDB,
  Engine.CockroachDB,
  Engine.SQLite,
  Engine.QuestDB,
])

/**
 * 获取 dblab 下载 URL 的平台后缀。
 * 返回值示例：'darwin_arm64'、'linux_amd64'、'windows_amd64'
 */
export function getDblabPlatformSuffix(): string {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') return 'darwin_arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin_amd64'
  if (platform === 'linux' && arch === 'arm64') return 'linux_arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux_amd64'
  if (platform === 'win32' && arch === 'x64') return 'windows_amd64'

  throw new Error(`不支持的平台: ${platform} ${arch}`)
}

/**
 * 构建用于启动 dblab 连接容器的 CLI 参数数组。
 * 使用标志位方式以避免 MySQL tcp() URL 包装器的问题。
 */
export function getDblabArgs(
  config: ContainerConfig,
  database: string,
): string[] {
  switch (config.engine) {
    case Engine.PostgreSQL:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'postgres',
        '--db',
        database,
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.MySQL:
    case Engine.MariaDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'root',
        '--db',
        database,
        '--driver',
        'mysql',
      ]

    case Engine.CockroachDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'root',
        '--db',
        database,
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.QuestDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'admin',
        '--pass',
        'quest',
        '--db',
        database || 'qdb',
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.SQLite:
      return ['--db', config.database, '--driver', 'sqlite3']

    default:
      throw new Error(`dblab 不支持该引擎: ${config.engine}`)
  }
}
