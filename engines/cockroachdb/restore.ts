/**
 * CockroachDB 恢复模块
 * 支持通过 cockroach sql 进行基于 SQL 的恢复
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireCockroachPath,
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
  buildLocalCockroachSqlArgs,
} from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * 标识 CockroachDB/PostgreSQL SQL 备份的 SQL 关键字
 */
const COCKROACHDB_SQL_KEYWORDS = [
  'CREATE TABLE',
  'CREATE DATABASE',
  'CREATE INDEX',
  'CREATE SEQUENCE',
  'INSERT INTO',
  'ALTER TABLE',
  'DROP TABLE',
  'SELECT',
  'SET',
  'BEGIN',
  'COMMIT',
]

/**
 * 检查文件内容是否看起来像 CockroachDB/PostgreSQL SQL
 * 仅读取前 8KB 以避免将大文件加载到内存中
 */
async function looksLikeCockroachSql(filePath: string): Promise<boolean> {
  try {
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
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('--')) continue

      checkedLines++

      // 检查 SQL 关键字
      for (const keyword of COCKROACHDB_SQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          sqlStatementsFound++
          break
        }
      }

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
 * 从文件中检测备份格式
 * 支持：
 * - SQL：DDL + INSERT 语句
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`未找到备份文件：${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description:
        '找到目录 - CockroachDB 恢复需要单个文件',
      restoreCommand: 'CockroachDB 需要单个 .sql 文件进行恢复',
    }
  }

  // 首先检查 .sql 文件的扩展名
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'CockroachDB SQL 备份',
      restoreCommand:
        '通过 cockroach sql 执行 SQL 语句（spindb restore 会处理此操作）',
    }
  }

  // 基于内容的检测
  if (await looksLikeCockroachSql(filePath)) {
    return {
      format: 'sql',
      description: 'CockroachDB SQL 备份（通过内容检测）',
      restoreCommand:
        '通过 cockroach sql 执行 SQL 语句（spindb restore 会处理此操作）',
    }
  }

  return {
    format: 'unknown',
    description: '未知的备份格式',
    restoreCommand: '请使用包含 CockroachDB/PostgreSQL SQL 语句的 .sql 文件',
  }
}

// CockroachDB 恢复选项
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
  // 恢复前删除已有表
  clean?: boolean
}

/**
 * 执行 CockroachDB 查询并返回结果
 */
async function executeQuery(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
  query: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = buildLocalCockroachSqlArgs({
      containerName,
      port,
      database,
    })
    args.push('--execute', query)

    const proc = spawn(cockroachPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
): Promise<string[]> {
  try {
    validateCockroachIdentifier(database, 'database')

    const result = await executeQuery(
      cockroachPath,
      containerName,
      port,
      database,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )

    if (!result) {
      return []
    }

    // 解析输出 - 跳过表头行
    return result
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line && !line.startsWith('table_name') && !line.startsWith('-'),
      )
  } catch (error) {
    logDebug(`获取表列表失败：${error}`)
    return []
  }
}

/**
 * 删除数据库中的所有表（用于干净恢复）
 */
async function dropAllTables(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
): Promise<void> {
  const tables = await getTablesInDatabase(
    cockroachPath,
    containerName,
    port,
    database,
  )

  if (tables.length === 0) {
    logDebug('没有需要删除的已有表')
    return
  }

  logDebug(
    `正在删除数据库 "${database}" 中的 ${tables.length} 张已有表`,
  )

  for (const table of tables) {
    try {
      validateCockroachIdentifier(table, 'table')
      const escapedTable = escapeCockroachIdentifier(table)

      await executeQuery(
        cockroachPath,
        containerName,
        port,
        database,
        `DROP TABLE IF EXISTS ${escapedTable} CASCADE`,
      )
      logDebug(`已删除表：${table}`)
    } catch (error) {
      logWarning(`删除表 "${table}" 失败：${error}`)
    }
  }
}

/**
 * 从 SQL 备份恢复
 * 将 SQL 语句流式传输到 cockroach sql
 */
async function restoreSqlBackup(
  backupPath: string,
  containerName: string,
  port: number,
  database: string,
  version?: string,
  clean: boolean = false,
): Promise<RestoreResult> {
  const cockroachPath = await requireCockroachPath(version)

  // 如果使用干净模式，先删除已有表
  if (clean) {
    logDebug('干净模式：恢复前正在删除已有表')
    await dropAllTables(cockroachPath, containerName, port, database)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = buildLocalCockroachSqlArgs({
      containerName,
      port,
      database,
    })

    const proc = spawn(cockroachPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      if (streamError) {
        const errorParts = [streamError.message]
        if (stderr && stderr.trim()) {
          errorParts.push(`CockroachDB 标准错误输出：${stderr.trim()}`)
        }
        reject(new Error(errorParts.join('. ')))
        return
      }

      if (code === 0) {
        resolve({
          format: 'sql',
          stdout: stdout || 'SQL 语句执行成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `cockroach sql 退出码 ${code}${stderr ? `：${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`启动 cockroach sql 失败：${error.message}`))
    })

    // 将备份文件流式传输到 cockroach sql 的标准输入
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        streamError = new Error(
          'CockroachDB 提前关闭了连接（可能是 SQL 语法错误）',
        )
      } else {
        streamError = new Error(
          `写入 cockroach sql 失败：${error.message}`,
        )
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
 * 从备份恢复
 * 支持：
 * - SQL：通过 cockroach sql 执行语句（需要 CockroachDB 处于运行状态）
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database = 'defaultdb', version, clean = false } = options

  if (!existsSync(backupPath)) {
    throw new Error(`未找到备份文件：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式：${format.format}`)

  if (format.format === 'sql') {
    return restoreSqlBackup(
      backupPath,
      options.containerName,
      port,
      database,
      version,
      clean,
    )
  }

  throw new Error(
    `无效的备份格式：${format.format}。请使用包含 CockroachDB/PostgreSQL SQL 语句的 .sql 文件。`,
  )
}

/**
 * 解析 CockroachDB 连接字符串
 * 格式：postgresql://[user:password@]host[:port][/database]
 *
 * CockroachDB 使用 PostgreSQL 通信协议，因此连接字符串
 * 使用 postgresql:// 方案。
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user?: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 CockroachDB 连接字符串：期望非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // 屏蔽错误消息中的凭据信息
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 CockroachDB 连接字符串："${sanitized}"。` +
        `期望格式：postgresql://[user:password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议 - CockroachDB 使用 PostgreSQL 协议
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(
      `无效的 CockroachDB 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望 "postgresql://" 或 "postgres://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 26257

  // 数据库名位于路径中
  const database = url.pathname.replace(/^\//, '') || 'defaultdb'

  return {
    host,
    port,
    database,
    user: url.username || undefined,
    password: url.password || undefined,
  }
}