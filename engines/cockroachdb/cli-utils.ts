/**
 * CockroachDB CLI 工具类
 *
 * 用于操作 CockroachDB 命令行工具的辅助函数。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const COCKROACH_NOT_FOUND_ERROR =
  '未找到 CockroachDB 二进制文件。请运行：spindb engines download cockroachdb <version>'

/**
 * 获取 cockroach 二进制文件的路径
 *
 * 首先检查配置缓存，然后在已下载的二进制目录中查找。
 * 未找到时返回 null。
 */
export async function getCockroachPath(): Promise<string | null> {
  // 先检查配置缓存
  const cached = await configManager.getBinaryPath('cockroach')
  if (cached && existsSync(cached)) {
    return cached
  }

  return null
}

/**
 * 获取特定版本的 cockroach 二进制文件路径
 */
export async function getCockroachPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'cockroachdb',
    version: fullVersion,
    platform,
    arch,
  })

  const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
  if (existsSync(cockroachPath)) {
    return cockroachPath
  }

  return null
}

/**
 * 获取 cockroach 二进制文件路径，未找到时抛出异常
 *
 * 如果提供了版本号，则仅检查该特定版本。
 * 如果未提供版本号，则回退到配置缓存。
 */
export async function requireCockroachPath(version?: string): Promise<string> {
  // 如果提供了版本号，则要求该特定版本（不回退）
  if (version) {
    const path = await getCockroachPathForVersion(version)
    if (path) {
      return path
    }
    throw new Error(
      `未找到 CockroachDB ${version} 的二进制文件。请运行：spindb engines download cockroachdb ${version}`,
    )
  }

  // 未指定版本 - 尝试配置缓存
  const cached = await getCockroachPath()
  if (cached) {
    return cached
  }

  throw new Error(COCKROACH_NOT_FOUND_ERROR)
}

export function getCockroachCertsDir(containerName: string): string {
  return join(paths.getContainerPath(containerName, { engine: 'cockroachdb' }), 'certs')
}

export function getCockroachCaCertPath(containerName: string): string {
  return join(getCockroachCertsDir(containerName), 'ca.crt')
}

export function getCockroachCaKeyPath(containerName: string): string {
  return join(getCockroachCertsDir(containerName), 'ca.key')
}

export function getCockroachClientCertPath(
  containerName: string,
  username: string,
): string {
  return join(getCockroachCertsDir(containerName), `client.${username}.crt`)
}

export function getCockroachClientKeyPath(
  containerName: string,
  username: string,
): string {
  return join(getCockroachCertsDir(containerName), `client.${username}.key`)
}

export function buildSecureCockroachConnectionString(options: {
  containerName: string
  port: number
  database?: string
  username?: string
  password?: string
  host?: string
}): string {
  const {
    containerName,
    port,
    database = 'defaultdb',
    username = 'root',
    password,
    host = '127.0.0.1',
  } = options

  const url = new URL(
    `postgresql://${encodeURIComponent(username)}@${host}:${port}/${database}`,
  )

  if (password) {
    url.password = password
  }

  url.searchParams.set('sslmode', 'verify-full')
  url.searchParams.set('sslrootcert', getCockroachCaCertPath(containerName))

  if (!password && username === 'root') {
    url.searchParams.set(
      'sslcert',
      getCockroachClientCertPath(containerName, username),
    )
    url.searchParams.set(
      'sslkey',
      getCockroachClientKeyPath(containerName, username),
    )
  }

  return url.toString()
}

export function buildInsecureCockroachConnectionString(options: {
  port: number
  database?: string
  username?: string
  password?: string
  host?: string
}): string {
  const {
    port,
    database = 'defaultdb',
    username = 'root',
    password,
    host = '127.0.0.1',
  } = options

  const url = new URL(
    `postgresql://${encodeURIComponent(username)}@${host}:${port}/${database}`,
  )

  if (password) {
    url.password = password
  }

  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

export function buildLocalCockroachSqlArgs(options: {
  containerName: string
  port: number
  database?: string
  username?: string
  password?: string
  host?: string
}): string[] {
  const {
    containerName,
    port,
    database = 'defaultdb',
    username = 'root',
    password,
    host = '127.0.0.1',
  } = options

  if (!password && username === 'root') {
    return [
      'sql',
      '--certs-dir',
      getCockroachCertsDir(containerName),
      '--user',
      'root',
      '--host',
      `${host}:${port}`,
      '--database',
      database,
    ]
  }

  return [
    'sql',
    '--url',
    buildSecureCockroachConnectionString({
      containerName,
      port,
      database,
      username,
      password,
      host,
    }),
  ]
}

/**
 * 验证 CockroachDB 标识符（数据库名、表名）
 * CockroachDB 使用 PostgreSQL 风格的标识符
 *
 * 有效标识符：
 * - 以字母或下划线开头
 * - 仅包含字母、数字、下划线
 * - 最多 63 个字符（PostgreSQL 限制）
 *
 * @throws 标识符无效时抛出 Error
 */
export function validateCockroachIdentifier(
  identifier: string,
  type: 'database' | 'table' | 'user' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} 名称不能为空`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} 名称不能超过 63 个字符`)
  }

  // PostgreSQL 标识符规则
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `无效的 ${type} 名称 "${identifier}"。` +
        `必须以字母或下划线开头，且仅包含字母、数字和下划线。`,
    )
  }

  // 检查保留字（PostgreSQL 保留字子集）
  const reserved = [
    'all',
    'analyse',
    'analyze',
    'and',
    'any',
    'array',
    'as',
    'asc',
    'asymmetric',
    'both',
    'case',
    'cast',
    'check',
    'collate',
    'column',
    'constraint',
    'create',
    'current_catalog',
    'current_date',
    'current_role',
    'current_schema',
    'current_time',
    'current_timestamp',
    'current_user',
    'default',
    'deferrable',
    'desc',
    'distinct',
    'do',
    'else',
    'end',
    'except',
    'false',
    'fetch',
    'for',
    'foreign',
    'from',
    'grant',
    'group',
    'having',
    'in',
    'initially',
    'intersect',
    'into',
    'lateral',
    'leading',
    'limit',
    'localtime',
    'localtimestamp',
    'not',
    'null',
    'offset',
    'on',
    'only',
    'or',
    'order',
    'placing',
    'primary',
    'references',
    'returning',
    'select',
    'session_user',
    'some',
    'symmetric',
    'table',
    'then',
    'to',
    'trailing',
    'true',
    'union',
    'unique',
    'user',
    'using',
    'variadic',
    'when',
    'where',
    'window',
    'with',
  ]

  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `"${identifier}" 是保留字，不能用作 ${type} 名称`,
    )
  }
}

/**
 * 转义 CockroachDB 标识符以在 SQL 中使用
 * 使用双引号进行 PostgreSQL 风格的引用
 */
export function escapeCockroachIdentifier(identifier: string): string {
  // 将已有的双引号加倍，然后用双引号包裹
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * 转义 SQL 值以在 INSERT 语句中使用
 *
 * 对于非 NULL 值，始终输出字符串字面量，以避免类型推断问题
 *（例如 "001" 变成 1，或 "true" 变成布尔值）。数据库
 * 在将字符串插入有类型的列时会进行隐式类型转换。
 *
 * @param value - 要转义的值
 * @param wasQuoted - 该值在原始 CSV 中是否被引号包裹（用于保留空字符串语义）
 */
export function escapeSqlValue(
  value: string | null | undefined,
  wasQuoted = false,
): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  // 空字符串：仅在 CSV 中未被引号包裹时才视为 NULL
  // 加引号的空字符串 ("") 应保留为空字符串
  // CockroachDB CSV 输出使用未加引号的空字段表示 NULL 值
  if (value === '' && !wasQuoted) {
    return 'NULL'
  }

  // 始终输出为字符串字面量 - 通过加倍单引号进行转义
  const escaped = value.replace(/'/g, "''")
  return `'${escaped}'`
}

/**
 * 表示解析后的 CSV 字段，包含值和引号信息
 */
export type CsvField = {
  value: string
  wasQuoted: boolean
}

/**
 * 将多行 CSV 数据解析为独立的记录（行）
 * 支持可能包含嵌入式换行符的引号字段
 * 返回完整的 CSV 记录字符串数组（每行一个）
 *
 * @param csvData - 查询返回的原始 CSV 输出
 * @param skipHeader - 为 true 时跳过第一条记录（表头行）
 * @returns 完整的 CSV 记录字符串数组
 */
export function parseCsvRecords(csvData: string, skipHeader = false): string[] {
  const records: string[] = []
  let currentRecord = ''
  let inQuotes = false

  for (let i = 0; i < csvData.length; i++) {
    const char = csvData[i]

    if (inQuotes) {
      currentRecord += char
      if (char === '"') {
        // 检查转义引号（双引号）
        if (i + 1 < csvData.length && csvData[i + 1] === '"') {
          currentRecord += csvData[i + 1]
          i++ // 跳过下一个引号
        } else {
          inQuotes = false
        }
      }
    } else {
      if (char === '"') {
        inQuotes = true
        currentRecord += char
      } else if (char === '\n') {
        // 记录结束（除非在引号内，已在上面处理）
        const trimmed = currentRecord.trim()
        if (trimmed) {
          records.push(trimmed)
        }
        currentRecord = ''
      } else if (char === '\r') {
        // 跳过回车符（处理 \r\n 换行符）
        continue
      } else {
        currentRecord += char
      }
    }
  }

  // 如果没有末尾换行符，别忘了最后一条记录
  const trimmed = currentRecord.trim()
  if (trimmed) {
    records.push(trimmed)
  }

  // 根据需要跳过表头
  return skipHeader ? records.slice(1) : records
}

/**
 * 解析 CSV 行，正确处理引号字段
 * 处理包含逗号、引号和换行符的字段
 * 返回字段值以及是否被引号包裹的信息（用于保留空字符串语义）
 */
export function parseCsvLine(line: string): CsvField[] {
  const result: CsvField[] = []
  let current = ''
  let inQuotes = false
  let fieldWasQuoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (inQuotes) {
      if (char === '"') {
        // 检查转义引号（双引号）
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++ // 跳过下一个引号
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
        fieldWasQuoted = true
      } else if (char === ',') {
        result.push({ value: current, wasQuoted: fieldWasQuoted })
        current = ''
        fieldWasQuoted = false
      } else {
        current += char
      }
    }
  }

  result.push({ value: current, wasQuoted: fieldWasQuoted })
  return result
}

/**
 * 检查连接字符串是否表示非安全（无 SSL）连接
 */
export function isInsecureConnection(connectionString: string): boolean {
  try {
    const url = new URL(connectionString)
    const sslmode = url.searchParams.get('sslmode')
    const host = url.hostname.toLowerCase()
    // 处理普通主机名和带方括号的 IPv6 地址
    const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      host,
    )

    // 显式禁用表示非安全
    if (sslmode === 'disable') {
      return true
    }

    // 本地主机未显式设置 SSL 时，默认视为非安全（本地开发场景）
    if (isLocalhost && !sslmode) {
      return true
    }

    // 除 'disable' 之外的任何 SSL 模式均视为安全
    return false
  } catch {
    // 无法解析时，假定为安全（更安全的默认值）
    return false
  }
}