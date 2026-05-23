/**
 * 查询结果解析工具
 * 将各种输出格式（CSV、JSON、制表符分隔）转换为 QueryResult
 */

import type { QueryResult, QueryResultRow } from '../types'

/**
 * PostgreSQL 命令标签模式。
 * psql --csv 对写/DDL 操作输出这些标签而非 CSV 数据。
 * 示例: "INSERT 0 1", "UPDATE 3", "DELETE 5", "CREATE TABLE", "ALTER TABLE", "DROP INDEX"
 */
const PG_COMMAND_TAG =
  /^(INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|COPY \d+|SELECT \d+|CREATE\b.*|ALTER\b.*|DROP\b.*|TRUNCATE\b.*|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|GRANT|REVOKE|DO|COMMENT|VACUUM|ANALYZE|DISCARD|CLUSTER|REINDEX|REFRESH MATERIALIZED VIEW|LOCK|NOTIFY|LISTEN|UNLISTEN|PREPARE|EXECUTE|DEALLOCATE)$/

/**
 * 将 CSV 输出解析为 QueryResult
 * 处理带引号字段、转义引号和 PostgreSQL 命令标签
 */
export function parseCSVToQueryResult(csv: string): QueryResult {
  const lines = csv.trim().split(/\r?\n/)

  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  // 检测 PostgreSQL 命令标签（写/DDL 操作输出这些而非 CSV）
  const nonEmptyLines = lines.filter((l) => l.trim())
  if (nonEmptyLines.every((l) => PG_COMMAND_TAG.test(l.trim()))) {
    const lastTag = nonEmptyLines[nonEmptyLines.length - 1].trim()
    const countMatch = lastTag.match(/^(?:INSERT \d+ |UPDATE |DELETE |MERGE |COPY |SELECT )(\d+)$/)
    return {
      columns: [],
      rows: [],
      rowCount: countMatch ? parseInt(countMatch[1], 10) : 0,
      commandTag: nonEmptyLines.join('; '),
    }
  }

  // 解析表头行
  const columns = parseCSVLine(lines[0])

  // 解析数据行
  const rows: QueryResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const values = parseCSVLine(line)
    const row: QueryResultRow = {}

    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = parseValue(values[j])
    }

    rows.push(row)
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
  }
}

/**
 * 解析单行 CSV，处理带引号字段
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // 转义引号
          current += '"'
          i++
        } else {
          // 引号字段结束
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
  }

  result.push(current)
  return result
}

/**
 * 将制表符分隔输出解析为 QueryResult（MySQL、MariaDB 使用 -B 标志）
 */
export function parseTSVToQueryResult(tsv: string): QueryResult {
  const lines = tsv.trim().split(/\r?\n/)

  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  // 解析表头行
  const columns = lines[0].split('\t')

  // 解析数据行
  const rows: QueryResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const values = line.split('\t')
    const row: QueryResultRow = {}

    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = parseValue(values[j])
    }

    rows.push(row)
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
  }
}

/**
 * 将 JSON 输出解析为 QueryResult（ClickHouse、SurrealDB、MongoDB）
 */
export function parseJSONToQueryResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // 处理对象数组（最常见格式）
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { columns: [], rows: [], rowCount: 0 }
    }

    // 从第一行的键中提取列名
    const firstRow = data[0] as Record<string, unknown>
    const columns = Object.keys(firstRow)

    const rows: QueryResultRow[] = data.map((item) => item as QueryResultRow)

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  // 处理单个对象结果
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    const columns = Object.keys(obj)
    return {
      columns,
      rows: [obj as QueryResultRow],
      rowCount: 1,
    }
  }

  // 处理标量结果
  return {
    columns: ['result'],
    rows: [{ result: data }],
    rowCount: 1,
  }
}

/**
 * 解析 ClickHouse JSON 格式输出
 * ClickHouse 返回: { data: [...], meta: [...], rows: N, statistics: {...} }
 */
export function parseClickHouseJSONResult(json: string): QueryResult {
  const result = JSON.parse(json) as {
    data?: unknown[]
    meta?: Array<{ name: string; type: string }>
    rows?: number
    statistics?: { elapsed?: number }
  }

  const columns = result.meta?.map((m) => m.name) || []
  const rows = (result.data || []) as QueryResultRow[]

  return {
    columns,
    rows,
    rowCount: result.rows ?? rows.length,
    executionTimeMs: result.statistics?.elapsed
      ? result.statistics.elapsed * 1000
      : undefined,
  }
}

/**
 * 解析 SurrealDB JSON 结果格式
 *
 * SurrealDB v2 使用 --json 返回: [[{...}, {...}]]（双重嵌套数组）
 * 旧版格式: [{ result: [...], status: "OK", time: "..." }]
 */
export function parseSurrealDBResult(json: string): QueryResult {
  const normalized = normalizeSurrealJSONOutput(json)
  const parsed = JSON.parse(normalized) as unknown[]

  // SurrealDB 返回语句结果数组
  // 对于单个查询，取第一个结果
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  const firstResult = parsed[0]

  // 确定格式：SurrealDB v2 返回 [[...]]，旧版返回 [{result: [...]}]
  let data: unknown[]
  let executionTimeMs: number | undefined

  if (Array.isArray(firstResult)) {
    // SurrealDB v2 格式: [[{...}, {...}]]
    data = firstResult
  } else if (
    typeof firstResult === 'object' &&
    firstResult !== null &&
    'result' in firstResult
  ) {
    // 旧版格式: [{result: [...], status: "OK", time: "..."}]
    const legacyResult = firstResult as {
      result?: unknown[]
      status?: string
      time?: string
    }
    data = legacyResult.result || []

    // 解析执行时间（例如 "1.234ms" 或 "1.234µs" 或 "1.234s"）
    if (legacyResult.time) {
      const timeMatch = legacyResult.time.match(/([\d.]+)(µs|ms|s)/)
      if (timeMatch) {
        const value = parseFloat(timeMatch[1])
        const unit = timeMatch[2]
        if (unit === 'µs') executionTimeMs = value / 1000
        else if (unit === 'ms') executionTimeMs = value
        else if (unit === 's') executionTimeMs = value * 1000
      }
    }
  } else {
    return { columns: [], rows: [], rowCount: 0 }
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  const firstRow = data[0] as Record<string, unknown>
  const columns = Object.keys(firstRow)
  const rows = data as QueryResultRow[]

  return {
    columns,
    rows,
    rowCount: rows.length,
    executionTimeMs,
  }
}

/** 规范化 SurrealDB JSON 输出，提取第一个有效 JSON 文档 */
function normalizeSurrealJSONOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) {
    return '[]'
  }

  const bracketIndices = [trimmed.indexOf('['), trimmed.indexOf('{')].filter(
    (index) => index >= 0,
  )
  if (bracketIndices.length > 0) {
    const start = Math.min(...bracketIndices)
    const extracted = extractFirstJsonDocument(trimmed, start)
    if (extracted) {
      return extracted
    }
  }

  return trimmed
}

/** 从输入字符串中提取第一个完整的 JSON 文档 */
function extractFirstJsonDocument(
  input: string,
  startIndex: number,
): string | null {
  const opening = input[startIndex]
  const closing = opening === '[' ? ']' : opening === '{' ? '}' : null
  if (!closing) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < input.length; i++) {
    const char = input[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (char === opening) {
      depth++
    } else if (char === closing) {
      depth--
      if (depth === 0) {
        return input.slice(startIndex, i + 1)
      }
    }
  }

  return null
}

/**
 * 解析 MongoDB shell 输出（来自 mongosh --json=relaxed 的 EJSON 格式）
 */
export function parseMongoDBResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // 处理游标结果（文档数组）
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { columns: [], rows: [], rowCount: 0 }
    }

    // MongoDB 文档可能具有不同的字段
    // 收集所有唯一键
    const columnSet = new Set<string>()
    for (const doc of data) {
      if (typeof doc === 'object' && doc !== null) {
        for (const key of Object.keys(doc)) {
          columnSet.add(key)
        }
      }
    }
    const columns = Array.from(columnSet)

    const rows = data.map((doc) => {
      if (typeof doc === 'object' && doc !== null) {
        return doc as QueryResultRow
      }
      return { value: doc } as QueryResultRow
    })

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  // 处理单个文档或标量
  return parseJSONToQueryResult(json)
}

/**
 * 根据命令类型解析 Redis 命令输出
 */
export function parseRedisResult(output: string, command: string): QueryResult {
  const trimmed = output.trim()
  const lines = trimmed.split(/\r?\n/)
  const upperCommand = command.trim().toUpperCase()

  // 从第一个单词确定命令类型
  const cmdWord = upperCommand.split(/\s+/)[0]

  // 返回列表的命令（每行一个值）
  const listCommands = ['KEYS', 'SMEMBERS', 'LRANGE', 'SINTER', 'SUNION']
  if (listCommands.includes(cmdWord)) {
    const rows = lines
      .filter((line) => line.trim())
      .map((line) => ({ value: line }))
    return {
      columns: ['value'],
      rows,
      rowCount: rows.length,
    }
  }

  // HGETALL 返回交替的键值对
  if (cmdWord === 'HGETALL') {
    const rows: QueryResultRow[] = []
    for (let i = 0; i < lines.length - 1; i += 2) {
      rows.push({
        key: lines[i],
        value: lines[i + 1],
      })
    }
    return {
      columns: ['key', 'value'],
      rows,
      rowCount: rows.length,
    }
  }

  // ZRANGE WITHSCORES 返回交替的成员/分数对
  if (cmdWord === 'ZRANGE' && upperCommand.includes('WITHSCORES')) {
    const rows: QueryResultRow[] = []
    for (let i = 0; i < lines.length - 1; i += 2) {
      rows.push({
        member: lines[i],
        score: parseFloat(lines[i + 1]),
      })
    }
    return {
      columns: ['member', 'score'],
      rows,
      rowCount: rows.length,
    }
  }

  // SCAN 返回游标然后是键列表
  if (cmdWord === 'SCAN') {
    // 第一行是游标，其余是键
    const keys = lines.slice(1).filter((line) => line.trim())
    const rows = keys.map((key) => ({ value: key }))
    return {
      columns: ['value'],
      rows,
      rowCount: rows.length,
    }
  }

  // TYPE 返回单个类型字符串
  if (cmdWord === 'TYPE') {
    return {
      columns: ['type'],
      rows: [{ type: trimmed }],
      rowCount: 1,
    }
  }

  // INFO 返回键值对
  if (cmdWord === 'INFO') {
    const rows: QueryResultRow[] = []
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        rows.push({
          key: line.slice(0, colonIdx),
          value: line.slice(colonIdx + 1),
        })
      }
    }
    return {
      columns: ['key', 'value'],
      rows,
      rowCount: rows.length,
    }
  }

  // 默认：单个结果值
  return {
    columns: ['result'],
    rows: [{ result: trimmed }],
    rowCount: 1,
  }
}

/**
 * 解析 REST API JSON 响应（用于向量/搜索数据库）
 */
export function parseRESTAPIResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // 处理带有 'result' 包装器的 Qdrant/Meilisearch 结果格式
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>

    // Qdrant 格式: { result: {...}, status: "ok", time: 0.001 }
    if ('result' in obj) {
      const result = obj.result

      // 如果 result 是数组
      if (Array.isArray(result)) {
        if (result.length === 0) {
          return { columns: [], rows: [], rowCount: 0 }
        }

        const firstItem = result[0]
        if (typeof firstItem === 'object' && firstItem !== null) {
          const columns = Object.keys(firstItem)
          return {
            columns,
            rows: result as QueryResultRow[],
            rowCount: result.length,
          }
        }

        // 基本类型数组
        return {
          columns: ['value'],
          rows: result.map((v) => ({ value: v })),
          rowCount: result.length,
        }
      }

      // 单个对象结果
      if (typeof result === 'object' && result !== null) {
        const columns = Object.keys(result)
        return {
          columns,
          rows: [result as QueryResultRow],
          rowCount: 1,
        }
      }

      // 标量结果
      return {
        columns: ['result'],
        rows: [{ result }],
        rowCount: 1,
      }
    }

    // Meilisearch 搜索格式: { hits: [...], query: "...", processingTimeMs: ... }
    if ('hits' in obj && Array.isArray(obj.hits)) {
      const hits = obj.hits as QueryResultRow[]
      if (hits.length === 0) {
        return { columns: [], rows: [], rowCount: 0 }
      }

      const columns = Object.keys(hits[0])
      return {
        columns,
        rows: hits,
        rowCount: hits.length,
        executionTimeMs: obj.processingTimeMs as number | undefined,
      }
    }

    // CouchDB 格式: { rows: [...] }
    if ('rows' in obj && Array.isArray(obj.rows)) {
      const rows = obj.rows as QueryResultRow[]
      if (rows.length === 0) {
        return { columns: [], rows: [], rowCount: 0 }
      }

      const columns = Object.keys(rows[0])
      return {
        columns,
        rows,
        rowCount: rows.length,
      }
    }
  }

  // 回退到通用 JSON 解析
  return parseJSONToQueryResult(json)
}

/**
 * 将字符串值解析为适当类型（数字、布尔值、null）
 */
function parseValue(value: string | undefined): unknown {
  if (value === undefined || value === '') return null
  if (value === 'NULL' || value === '\\N') return null
  if (value === 'true' || value === 't') return true
  if (value === 'false' || value === 'f') return false

  // 尝试解析为数字
  const num = Number(value)
  if (!isNaN(num) && value.trim() !== '') {
    return num
  }

  return value
}
