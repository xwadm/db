/**
 * 远程容器工具
 *
 * 用于解析、检测和管理远程数据库连接的工具函数。
 * 由 `spindb link` 命令和远程容器操作使用。
 */

import { Engine, assertExhaustive } from '../types'
import type { RemoteConnectionConfig, RemoteOrigin } from '../types'

export type ParsedConnectionString = {
  scheme: string
  host: string
  port: number | null
  database: string
  username: string
  password: string
  params: Record<string, string>
  raw: string
}

/**
 * 将数据库连接字符串解析为其组成部分。
 * 支持 postgresql://, mysql://, mongodb://, mongodb+srv://, redis://, rediss://, http://, https://
 */
export function parseConnectionString(url: string): ParsedConnectionString {
  const raw = url.trim()

  // 通过临时替换处理 mongodb+srv:// 以便 URL 解析
  const normalizedUrl = raw.replace(
    /^mongodb\+srv:\/\//,
    'mongodb+srv-placeholder://',
  )

  let parsed: URL
  try {
    // 对于 URL 无法识别的协议，替换为 http 进行解析
    const parseableUrl = normalizedUrl
      .replace(/^postgresql:\/\//, 'http://')
      .replace(/^postgres:\/\//, 'http://')
      .replace(/^mysql:\/\//, 'http://')
      .replace(/^mongodb:\/\//, 'http://')
      .replace(/^mongodb\+srv-placeholder:\/\//, 'http://')
      .replace(/^redis:\/\//, 'http://')
      .replace(/^rediss:\/\//, 'http://')

    parsed = new URL(parseableUrl)
  } catch {
    throw new Error(
      `无效的连接字符串: "${raw}"。期望格式: scheme://[user:pass@]host[:port]/database`,
    )
  }

  // 提取原始协议
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : ''

  // 提取参数
  const params: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    params[key] = value
  })

  // 移除路径名前导斜杠以获取数据库名
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))

  return {
    scheme,
    host: decodeURIComponent(parsed.hostname),
    port: parsed.port ? parseInt(parsed.port, 10) : null,
    database,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    params,
    raw,
  }
}

/**
 * 从连接字符串的协议检测数据库引擎。
 * 如果协议不明确（http/https）或未知，则返回 null。
 */
export function detectEngineFromConnectionString(url: string): Engine | null {
  const scheme = url.trim().split('://')[0]?.toLowerCase()

  switch (scheme) {
    case 'postgresql':
    case 'postgres':
      return Engine.PostgreSQL
    case 'mysql':
      return Engine.MySQL
    case 'mongodb':
    case 'mongodb+srv':
      return Engine.MongoDB
    case 'redis':
    case 'rediss':
      return Engine.Redis
    default:
      return null
  }
}

type ProviderPattern = {
  pattern: RegExp
  name: string
}

// 云服务商主机名匹配模式
const PROVIDER_PATTERNS: ProviderPattern[] = [
  { pattern: /\.neon\.tech$/i, name: 'neon' },
  { pattern: /\.supabase\.(co|com)$/i, name: 'supabase' },
  { pattern: /\.planetscale\.com$/i, name: 'planetscale' },
  { pattern: /\.cockroachlabs\.cloud$/i, name: 'cockroachdb-cloud' },
  { pattern: /\.upstash\.io$/i, name: 'upstash' },
  { pattern: /\.railway\.app$/i, name: 'railway' },
  { pattern: /\.aiven\.io$/i, name: 'aiven' },
  { pattern: /dev\.cloud\.layerbase\.dev$/i, name: 'layerbase-staging' },
  { pattern: /\.layerbase\.dev$/i, name: 'layerbase' },
]

/** 根据服务商名称检测远程来源 */
export function detectRemoteOrigin(provider?: string | null): RemoteOrigin {
  return provider?.startsWith('layerbase') ? 'layerbase-cloud' : 'external'
}

/** 获取远程连接的来源 */
export function getRemoteOrigin(
  remote?: Pick<RemoteConnectionConfig, 'origin' | 'provider'> | null,
): RemoteOrigin {
  return remote?.origin ?? detectRemoteOrigin(remote?.provider ?? null)
}

/** 检查是否为 Layerbase 云端远程连接 */
export function isLayerbaseCloudRemote(
  remote?: Pick<RemoteConnectionConfig, 'origin' | 'provider'> | null,
): boolean {
  return getRemoteOrigin(remote) === 'layerbase-cloud'
}

/**
 * 从主机名检测云服务商。
 * 如果没有已知的服务商模式匹配，则返回 null。
 */
export function detectProvider(host: string): string | null {
  for (const { pattern, name } of PROVIDER_PATTERNS) {
    if (pattern.test(host)) {
      return name
    }
  }
  return null
}

/**
 * 检查主机是否为本地地址（127.0.0.1、localhost、::1）
 */
export function isLocalhost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  )
}

/**
 * 为远程数据库生成容器名称。
 * 使用服务商和数据库名称，或回退到基于主机的命名。
 */
export function generateRemoteContainerName(options: {
  engine: Engine
  host: string
  database: string
  provider?: string | null
}): string {
  const { engine, host, database, provider } = options

  // 如果可用，使用服务商 + 数据库名称
  if (provider && database) {
    return sanitizeName(`${provider}-${database}`)
  }

  // 如果没有数据库名称，使用服务商 + 引擎
  if (provider) {
    return sanitizeName(`${provider}-${engine}`)
  }

  // 使用数据库 + remote 前缀
  if (database) {
    return sanitizeName(`remote-${database}`)
  }

  // 回退：提取主机前缀
  const hostPrefix = host.split('.')[0]
  return sanitizeName(`remote-${hostPrefix}`)
}

/**
 * 将字符串清理为有效的容器名称。
 * 必须以字母开头，仅包含字母数字、连字符和下划线。
 */
function sanitizeName(name: string): string {
  // 将所有非字母数字字符替换为连字符
  let sanitized = name.replace(/[^a-zA-Z0-9-_]/g, '-')

  // 移除连续的连字符
  sanitized = sanitized.replace(/-+/g, '-')

  // 移除首尾的连字符
  sanitized = sanitized.replace(/^-+|-+$/g, '')

  // 确保以字母开头
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `db-${sanitized}`
  }

  // 截断到合理长度
  if (sanitized.length > 50) {
    sanitized = sanitized.slice(0, 50)
  }

  return sanitized || 'remote-db'
}

/**
 * 通过将密码替换为 *** 来脱敏连接字符串。
 * 处理标准 URL 编码密码和边缘情况。
 */
export function redactConnectionString(url: string): string {
  try {
    const parsed = parseConnectionString(url)
    if (!parsed.password) {
      return url
    }
    // 在原始 URL 中替换密码
    const encodedPassword = encodeURIComponent(parsed.password)
    return url
      .replace(`:${encodedPassword}@`, ':***@')
      .replace(`:${parsed.password}@`, ':***@')
  } catch {
    // 如果解析失败，尝试基于正则表达式的方法
    return url.replace(/:([^@/:]+)@/, ':***@')
  }
}

/**
 * 从解析的连接信息构建 RemoteConnectionConfig。
 */
export function buildRemoteConfig(options: {
  host: string
  connectionString: string
  provider?: string | null
  providerId?: string
  origin?: RemoteOrigin
  ssl?: boolean
}): RemoteConnectionConfig {
  const { host, connectionString, provider, providerId } = options

  // 非本地连接默认启用 SSL
  const ssl = options.ssl ?? !isLocalhost(host)
  const origin = options.origin ?? detectRemoteOrigin(provider)

  return {
    host,
    connectionString: redactConnectionString(connectionString),
    ssl,
    origin,
    ...(provider && { provider }),
    ...(providerId && { providerId }),
  }
}

/**
 * 获取引擎的默认端口（当连接字符串省略端口时使用）。
 */
export function getDefaultPortForEngine(engine: Engine): number {
  switch (engine) {
    case Engine.PostgreSQL:
      return 5432
    case Engine.MySQL:
    case Engine.MariaDB:
      return 3306
    case Engine.MongoDB:
    case Engine.FerretDB:
      return 27017
    case Engine.Redis:
    case Engine.Valkey:
      return 6379
    case Engine.ClickHouse:
      return 8123
    case Engine.CockroachDB:
      return 26257
    case Engine.SurrealDB:
      return 8000
    case Engine.Qdrant:
      return 6333
    case Engine.Meilisearch:
      return 7700
    case Engine.CouchDB:
      return 5984
    case Engine.QuestDB:
      return 8812
    case Engine.InfluxDB:
      return 8086
    case Engine.Weaviate:
      return 8080
    case Engine.TypeDB:
      return 1729
    case Engine.TigerBeetle:
      return 3000
    case Engine.LibSQL:
      return 8080
    case Engine.SQLite:
    case Engine.DuckDB:
      return 0
    default:
      assertExhaustive(engine, `未知引擎: ${engine}`)
  }
}
