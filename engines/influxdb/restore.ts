/**
 * InfluxDB 恢复模块
 * 支持通过 InfluxDB REST API 进行基于 SQL 的数据恢复
 */

import { open, readFile as readFileAsync } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { influxdbApiRequest } from './api-client'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

const ADMIN_TOKEN_FILE = 'admin-token.json'

async function loadInfluxAuthToken(
  containerName: string,
  username = getDefaultUsername(Engine.InfluxDB),
): Promise<string | undefined> {
  const adminTokenPath = join(
    paths.getContainerPath(containerName, { engine: Engine.InfluxDB }),
    ADMIN_TOKEN_FILE,
  )

  try {
    const parsed = JSON.parse(await readFileAsync(adminTokenPath, 'utf-8')) as {
      token?: unknown
    }
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token
    }
  } catch {
    // 回退到已保存的凭据
  }

  const savedCreds = await loadCredentials(containerName, Engine.InfluxDB, username)
  return savedCreds?.apiKey
}

/**
 * 根据文件检测备份格式
 * InfluxDB 使用 SQL 转储文件
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到：${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '发现目录 - InfluxDB 使用单个 SQL 转储文件',
      restoreCommand: 'InfluxDB 恢复需要单个 .sql 文件',
    }
  }

  // 检查文件扩展名是否为 .sql
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'InfluxDB SQL 转储文件',
      restoreCommand:
        '通过 InfluxDB REST API 恢复（spindb restore 会处理此过程）',
    }
  }

  // 检查文件内容中的 SQL 模式
  try {
    const HEADER_SIZE = 4096
    const buffer = Buffer.alloc(HEADER_SIZE)
    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close().catch(() => {})
    }

    const content = buffer.toString('utf-8', 0, bytesRead)

    // 首先检查 InfluxDB 特有标记
    if (content.includes('-- InfluxDB SQL Backup')) {
      return {
        format: 'sql',
        description: 'InfluxDB SQL 转储文件（通过内容检测）',
        restoreCommand:
          '通过 InfluxDB REST API 恢复（spindb restore 会处理此过程）',
      }
    }

    // 回退到通用 SQL 标记检测并给出警告
    if (content.includes('INSERT INTO') || content.includes('CREATE TABLE')) {
      logDebug(
        `备份文件 "${filePath}" 通过通用标记（INSERT INTO / CREATE TABLE）检测为 SQL 格式 — 未检测到 InfluxDB 特有头部。请确认这是 InfluxDB 备份。`,
      )
      return {
        format: 'sql',
        description:
          'SQL 转储文件（通过通用标记检测，可能不是 InfluxDB 专用的）',
        restoreCommand:
          '通过 InfluxDB REST API 恢复（spindb restore 会处理此过程）',
      }
    }
  } catch (error) {
    logDebug(`读取备份文件头部时出错：${error}`)
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用 .sql 文件进行恢复',
  }
}

// InfluxDB 恢复选项
export type RestoreOptions = {
  containerName: string
  port: number
  database: string
}

/**
 * 将 SQL VALUES 子句解析为字符串值数组。
 * 处理 SQL 字符串转义（'' 表示嵌入的单引号）。
 *
 * 注意：逗号处的 `if (trimmed)` 检查是有意为之的。带引号的字符串在
 * 遇到闭合引号时会推送其值，使 `current` 为空。随后的逗号分隔符
 * 发现该空 `current` 并正确跳过它 —— 它是带引号值之间的分隔符，
 * 而非空字段。备份代码（backup.ts）不会产生真正的空值（始终为
 * NULL、数字、布尔值或带引号的字符串），因此这是安全的。
 * 请勿更改为始终推送，否则需同时修复引号字符串后跟逗号的双重推送问题。
 */
function parseSqlValues(valuesStr: string): string[] {
  const values: string[] = []
  let current = ''
  let inString = false

  for (let i = 0; i < valuesStr.length; i++) {
    const ch = valuesStr[i]

    if (inString) {
      if (ch === "'" && valuesStr[i + 1] === "'") {
        // 转义的单引号
        current += "'"
        i++
      } else if (ch === "'") {
        // 字符串结束
        inString = false
        values.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      if (ch === "'") {
        inString = true
        current = ''
      } else if (ch === ',') {
        const trimmed = current.trim()
        if (trimmed) {
          values.push(trimmed)
        }
        current = ''
      } else {
        current += ch
      }
    }
  }

  const trimmed = current.trim()
  if (trimmed) {
    values.push(trimmed)
  }

  return values
}

/**
 * 将解析后的 INSERT 数据转换为 InfluxDB 行协议格式。
 * 格式：measurement,tag1=val1 field1="val1",field2="val2" timestamp_ns
 *
 * 标签列（来自备份元数据）变为行协议标签，
 * 其余列变为字段。这保留了原始模式结构，
 * 使得具有相同时间戳的记录保持区分。
 */
/**
 * 将 SQL 值编码为 InfluxDB 行协议字段值。
 * - 布尔值：不加引号（true/false）
 * - 整数：末尾加 'i'（例如 123i）—— 仅当原始字符串不含
 *   小数点或指数时，因此 "123.0" 保留为浮点数
 * - 浮点数：不加引号的数字（例如 3.14）
 * - 字符串：双引号包裹并转义
 */
export function encodeFieldValue(val: string): string {
  if (val === 'true' || val === 'false') {
    return val
  }

  const num = Number(val)
  if (!isNaN(num) && val !== '') {
    if (Number.isInteger(num) && !/[.eE]/.test(val)) {
      return `${num}i`
    }
    return `${num}`
  }

  const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function toLineProtocol(
  table: string,
  columns: string[],
  values: string[],
  tagColumns: Set<string>,
): string | null {
  const tags: string[] = []
  const fields: string[] = []
  let timestampNs = ''

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]
    const val = values[i]

    if (!val || val === 'NULL') continue

    if (col === 'time') {
      const ms = new Date(val).getTime()
      if (!isNaN(ms)) {
        timestampNs = String(ms * 1_000_000)
      } else {
        logDebug(`警告：恢复时遇到无法解析的时间戳值 "${val}"`)
      }
      continue
    }

    if (tagColumns.has(col)) {
      // 标签：key=value（不加引号，转义空格/逗号/等号）
      const escaped = val
        .replace(/\\/g, '\\\\')
        .replace(/ /g, '\\ ')
        .replace(/,/g, '\\,')
        .replace(/=/g, '\\=')
      tags.push(`${col}=${escaped}`)
    } else {
      fields.push(`${col}=${encodeFieldValue(val)}`)
    }
  }

  if (fields.length === 0) return null

  let line = table
  if (tags.length > 0) {
    line += `,${tags.join(',')}`
  }
  line += ` ${fields.join(',')}`
  if (timestampNs) {
    line += ` ${timestampNs}`
  }
  return line
}

/**
 * 通过解析 INSERT 语句、转换为行协议，
 * 并通过 write_lp 端点写入来恢复 SQL 备份。
 *
 * InfluxDB 3.x 不支持通过 query_sql 端点执行 INSERT ——
 * 数据写入必须通过 /api/v3/write_lp 进行。
 */
async function restoreSqlBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database } = options
  const token = await loadInfluxAuthToken(containerName)

  logDebug(
    `正在恢复 SQL 备份到 InfluxDB（端口 ${port}，数据库 ${database}）`,
  )

  const content = await readFileAsync(backupPath, 'utf-8')

  // 从备份注释中解析标签元数据（-- Tags: col1, col2）
  const tagsByTable = new Map<string, Set<string>>()
  const tagsRegex = /-- Table: (\S+)\r?\n-- Tags: (.+)/g
  let tagsMatch
  while ((tagsMatch = tagsRegex.exec(content)) !== null) {
    const table = tagsMatch[1]
    const tags = new Set(tagsMatch[2].split(',').map((t) => t.trim()))
    tagsByTable.set(table, tags)
  }

  // 解析 INSERT INTO 语句并转换为行协议
  const insertRegex =
    /INSERT INTO "([^"]+)"\s*\(([^)]+)\)\s*VALUES\s*\((.+)\);/g
  const linesByTable = new Map<string, string[]>()

  let match
  while ((match = insertRegex.exec(content)) !== null) {
    const table = match[1]
    const columns = match[2].split(',').map((c) => c.trim().replace(/"/g, ''))
    const values = parseSqlValues(match[3])
    const tableTags = tagsByTable.get(table) ?? new Set<string>()
    const line = toLineProtocol(table, columns, values, tableTags)

    if (line) {
      if (!linesByTable.has(table)) linesByTable.set(table, [])
      linesByTable.get(table)!.push(line)
    }
  }

  logDebug(
    `已从 ${linesByTable.size} 张表中解析 ${[...linesByTable.values()].reduce((sum, l) => sum + l.length, 0)} 条记录`,
  )

  let totalRecords = 0
  const errors: string[] = []

  for (const [table, lines] of linesByTable) {
    const body = lines.join('\n')
    try {
      const response = await influxdbApiRequest(
        port,
        'POST',
        `/api/v3/write_lp?db=${encodeURIComponent(database)}`,
        body,
        30000,
        token,
      )

      if (response.status < 300) {
        totalRecords += lines.length
      } else {
        errors.push(
          `写入 ${table} 失败：${JSON.stringify(response.data)}`,
        )
        logDebug(
          `${table} 的 write_lp 错误：${JSON.stringify(response.data)}`,
        )
      }
    } catch (error) {
      errors.push(
        `写入 ${table} 时出错：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const message =
    `已从 ${linesByTable.size} 张表中恢复 ${totalRecords} 条记录` +
    (errors.length > 0 ? `。${errors.length} 个错误。` : '')

  return {
    format: 'sql',
    stdout: message,
    code: errors.length > 0 ? 1 : 0,
  }
}

/**
 * 从备份恢复
 * 支持 SQL 格式
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到的备份格式：${format.format}`)

  if (format.format === 'sql') {
    return restoreSqlBackup(backupPath, options)
  }

  throw new Error(
    `无效的备份格式：${format.format}。请使用 .sql 文件进行恢复。`,
  )
}

/**
 * 解析 InfluxDB 连接字符串
 * 格式：http://host[:port]、https://host[:port] 或 influxdb://host[:port]
 *
 * influxdb:// 协议是 http:// 的别名
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
  database?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 InfluxDB 连接字符串：期望一个非空字符串',
    )
  }

  // 处理 influxdb:// 协议
  let normalized = connectionString.trim()
  if (normalized.startsWith('influxdb://')) {
    normalized = normalized.replace('influxdb://', 'http://')
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch (error) {
    throw new Error(
      `无效的 InfluxDB 连接字符串："${connectionString}"。` +
        `期望格式：http://host[:port] 或 influxdb://host[:port]`,
      { cause: error },
    )
  }

  // 验证协议
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `无效的 InfluxDB 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望 "http://"、"https://" 或 "influxdb://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 8086
  const database = url.searchParams.get('db') || undefined

  return {
    host,
    port,
    protocol,
    database,
  }
}
