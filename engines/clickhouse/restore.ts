/**
 * ClickHouse 还原模块
 * 支持使用 clickhouse 客户端进行基于 SQL 的还原
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireClickHousePath,
  validateClickHouseIdentifier,
  escapeClickHouseIdentifier,
} from './cli-utils'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

/**
 * 指示 ClickHouse SQL 备份的 SQL 关键字
 */
const CLICKHOUSE_SQL_KEYWORDS = [
  'CREATE TABLE',
  'CREATE DATABASE',
  'INSERT INTO',
  'ALTER TABLE',
  'DROP TABLE',
  'SELECT',
  'ATTACH',
  'DETACH',
]

type ClickHouseLocalAuth = {
  user?: string
  password?: string
}

function buildClickHouseEnv(auth?: ClickHouseLocalAuth): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (auth?.user) {
    env.CLICKHOUSE_USER = auth.user
  } else {
    delete env.CLICKHOUSE_USER
  }
  if (auth?.password) {
    env.CLICKHOUSE_PASSWORD = auth.password
  } else {
    delete env.CLICKHOUSE_PASSWORD
  }
  return env
}

async function loadLocalClickHouseAuth(
  containerName: string,
): Promise<ClickHouseLocalAuth> {
  const savedCreds = await loadCredentials(
    containerName,
    Engine.ClickHouse,
    getDefaultUsername(Engine.ClickHouse),
  )

  if (!savedCreds) {
    return {}
  }

  return {
    user: savedCreds.username,
    password: savedCreds.password,
  }
}

/**
 * 检查文件内容是否像 ClickHouse SQL
 * 仅读取前 8KB，避免将大文件加载到内存中
 */
async function looksLikeClickHouseSql(filePath: string): Promise<boolean> {
  try {
    // 仅读取前 8KB —— 足够容纳多条 SQL 语句
    // 使用 8KB（相对于 Redis/Valkey 的 4KB），因为 SQL 语句可能更长
    const HEADER_SIZE = 8192
    const buffer = Buffer.alloc(HEADER_SIZE)

    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close()
    }

    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split(/\r?\n/)

    let sqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      // 检查完 linesToCheck 行后停止
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // 跳过空行和注释（不计入 linesToCheck）
      if (!trimmed || trimmed.startsWith('--')) continue

      checkedLines++

      // 检查 SQL 关键字
      for (const keyword of CLICKHOUSE_SQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          sqlStatementsFound++
          break
        }
      }

      // 如果找到 2 条或更多 SQL 语句，提前成功返回
      if (sqlStatementsFound >= 2) {
        return true
      }
    }

    return sqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * 从文件检测备份格式
 * 支持：
 * - SQL：DDL + INSERT 语句
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
      description: '找到目录 —— ClickHouse 还原需要单个文件',
      restoreCommand: 'ClickHouse 需要单个 .sql 文件来进行还原',
    }
  }

  // 首先检查 .sql 文件的文件扩展名
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'ClickHouse SQL 备份',
      restoreCommand:
        '通过 clickhouse 客户端执行 SQL 语句（spindb restore 会处理此操作）',
    }
  }

  // 基于内容的检测
  if (await looksLikeClickHouseSql(filePath)) {
    return {
      format: 'sql',
      description: 'ClickHouse SQL 备份（通过内容检测）',
      restoreCommand:
        '通过 clickhouse 客户端执行 SQL 语句（spindb restore 会处理此操作）',
    }
  }

  return {
    format: 'unknown',
    description: '未知的备份格式',
    restoreCommand: '使用包含 ClickHouse SQL 语句的 .sql 文件',
  }
}

// ClickHouse 还原选项
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
  // 还原前删除现有表
  clean?: boolean
}

/**
 * 执行 ClickHouse 查询并返回结果
 */
async function executeQuery(
  clickhousePath: string,
  port: number,
  database: string,
  query: string,
  auth?: ClickHouseLocalAuth,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
      '--query',
      query,
    ]

    const proc = spawn(clickhousePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClickHouseEnv(auth),
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`查询失败：${stderr || `退出码 ${code}`}`))
      }
    })

    proc.on('error', reject)
  })
}

/**
 * 获取数据库中的表列表
 */
async function getTablesInDatabase(
  clickhousePath: string,
  port: number,
  database: string,
  auth?: ClickHouseLocalAuth,
): Promise<string[]> {
  try {
    // 验证数据库名称
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = database.replace(/'/g, "''")

    const result = await executeQuery(
      clickhousePath,
      port,
      database,
      `SELECT name FROM system.tables WHERE database = '${escapedDb}'`,
      auth,
    )

    if (!result) {
      return []
    }

    return result
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    logDebug(`获取表列表失败：${error}`)
    return []
  }
}

/**
 * 删除数据库中的所有表（用于干净还原）
 */
async function dropAllTables(
  clickhousePath: string,
  port: number,
  database: string,
  auth?: ClickHouseLocalAuth,
): Promise<void> {
  const tables = await getTablesInDatabase(clickhousePath, port, database, auth)

  if (tables.length === 0) {
    logDebug('没有要删除的现有表')
    return
  }

  logDebug(`正在删除数据库 "${database}" 中的 ${tables.length} 个现有表`)

  for (const table of tables) {
    try {
      // 验证表名
      validateClickHouseIdentifier(table, 'table')
      const escapedTable = escapeClickHouseIdentifier(table)

      await executeQuery(
        clickhousePath,
        port,
        database,
        `DROP TABLE IF EXISTS ${escapedTable}`,
        auth,
      )
      logDebug(`已删除表：${table}`)
    } catch (error) {
      // 记录警告，但继续处理其他表
      logWarning(`删除表 "${table}" 失败：${error}`)
    }
  }
}

/**
 * 从 SQL 备份还原
 * 将 SQL 语句通过管道传给 clickhouse 客户端
 */
async function restoreSqlBackup(
  backupPath: string,
  containerName: string,
  port: number,
  database: string,
  version?: string,
  clean: boolean = false,
): Promise<RestoreResult> {
  const clickhousePath = await requireClickHousePath(version)
  const auth = await loadLocalClickHouseAuth(containerName)

  // 如果是干净模式，首先删除现有表
  if (clean) {
    logDebug('干净模式：在还原前删除现有表')
    await dropAllTables(clickhousePath, port, database, auth)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
      '--multiquery',
    ]

    const proc = spawn(clickhousePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildClickHouseEnv(auth),
    })

    let stdout = ''
    let stderr = ''
    let streamError: Error | null = null

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      // 如果存在流错误，报告它（包含 stderr 作为上下文）
      if (streamError) {
        const errorParts = [streamError.message]
        if (stderr && stderr.trim()) {
          errorParts.push(`ClickHouse 标准错误：${stderr.trim()}`)
        }
        reject(new Error(errorParts.join('. ')))
        return
      }

      if (code === 0) {
        resolve({
          format: 'sql',
          stdout: stdout || 'SQL 语句已成功执行',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `clickhouse 客户端退出，错误码 ${code}${stderr ? `：${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`启动 clickhouse 客户端失败：${error.message}`))
    })

    // 将备份文件通过管道传给 clickhouse 客户端标准输入
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    // 处理标准输入错误（例如，客户端因 SQL 错误提前退出时产生的 EPIPE）
    proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // EPIPE 表示客户端关闭了其标准输入（可能因错误退出）
      // 实际的错误消息将在 'close' 处理程序中通过 stderr 获得
      if (error.code === 'EPIPE') {
        streamError = new Error(
          'ClickHouse 客户端过早关闭连接（可能是 SQL 语法错误）',
        )
      } else {
        streamError = new Error(`写入 clickhouse 客户端失败：${error.message}`)
      }
      fileStream.destroy()
    })

    fileStream.on('error', (error) => {
      streamError = new Error(`读取备份文件失败：${error.message}`)
      fileStream.destroy()
      proc.stdin.end()
    })

    fileStream.pipe(proc.stdin)
  })
}

/**
 * 从备份还原
 * 支持：
 * - SQL：通过 clickhouse 客户端执行语句（ClickHouse 必须处于运行状态）
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    containerName,
    port,
    database = 'default',
    version,
    clean = false,
  } = options

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到的备份格式：${format.format}`)

  if (format.format === 'sql') {
    return restoreSqlBackup(
      backupPath,
      containerName,
      port,
      database,
      version,
      clean,
    )
  }

  throw new Error(
    `无效的备份格式：${format.format}。请使用包含 ClickHouse SQL 语句的 .sql 文件。`,
  )
}

/**
 * 解析 ClickHouse 连接字符串
 * 格式：clickhouse://[user:password@]host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user?: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('无效的 ClickHouse 连接字符串：期望一个非空字符串')
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // 如果包含凭据，在错误消息中进行遮盖
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 ClickHouse 连接字符串："${sanitized}"。` +
        `期望的格式：clickhouse://[user:password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议
  if (
    url.protocol !== 'clickhouse:' &&
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error(
      `无效的 ClickHouse 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望 "clickhouse://"、"http://" 或 "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  // 默认端口取决于协议 —— 原生端口 9000，HTTP 端口 8123
  const defaultPort =
    url.protocol === 'http:' || url.protocol === 'https:' ? 8123 : 9000
  const port = parseInt(url.port, 10) || defaultPort

  // 数据库名在路径名中
  const database = url.pathname.replace(/^\//, '') || 'default'

  return {
    host,
    port,
    database,
    user: url.username || undefined,
    password: url.password || undefined,
  }
}
