/**
 * libSQL 恢复模块
 * 支持二进制（文件复制）和 SQL 导入两种恢复格式
 */

import { existsSync } from 'fs'
import { readFile, mkdir, cp, rm } from 'fs/promises'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import {
  loadCredentials,
  getDefaultUsername,
} from '../../core/credential-manager'
import { libsqlQuery } from './api-client'
import {
  Engine,
  type BackupFormat,
  type RestoreResult,
  type LibSQLFormat,
} from '../../types'

/**
 * 将 SQL 内容拆分为独立的语句，兼顾引号字符串和注释。
 * 避免在字符串字面量内的分号处错误分割。
 */
function splitSqlStatements(content: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let inBlockComment = false
  let i = 0

  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
      }
      i++
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 2
        continue
      }
      if (ch === "'") {
        inSingleQuote = false
      }
      i++
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && next === '"') {
        current += next
        i += 2
        continue
      }
      if (ch === '"') {
        inDoubleQuote = false
      }
      i++
      continue
    }

    // 不处于任何引号或注释内
    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      current += ch
      i++
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      current += ch
      i++
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  const trimmed = current.trim()
  if (trimmed) {
    statements.push(trimmed)
  }

  return statements
}

/**
 * 根据文件路径检测备份格式
 */
export function detectBackupFormat(filePath: string): BackupFormat {
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'SQL 转储',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  if (filePath.endsWith('.db')) {
    return {
      format: 'binary',
      description: '二进制数据库副本',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  // 未知扩展名默认视为二进制格式
  return {
    format: 'binary',
    description: '二进制数据库副本（推测）',
    restoreCommand: `spindb restore <container> ${filePath}`,
  }
}

/**
 * 恢复 libSQL 备份
 */
export async function restoreBackup(
  backupPath: string,
  options: {
    containerName: string
    dataDir: string
    port?: number
    format?: LibSQLFormat
  },
): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到：${backupPath}`)
  }

  const format = options.format || detectBackupFormat(backupPath).format

  if (format === 'sql') {
    return restoreSqlBackup(backupPath, options)
  }

  return restoreBinaryBackup(backupPath, options)
}

/**
 * 通过复制数据库目录从二进制备份恢复。
 * sqld 的 data.db 是一个目录树，不是单个文件。
 * 要求服务器已停止。
 */
async function restoreBinaryBackup(
  backupPath: string,
  options: { containerName: string; dataDir: string },
): Promise<RestoreResult> {
  const dataDir =
    options.dataDir ||
    join(
      paths.getContainerPath(options.containerName, { engine: 'libsql' }),
      'data',
    )
  const dbPath = join(dataDir, 'data.db')

  logDebug(`正在将二进制备份恢复到 ${dbPath}`)

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  // 恢复前删除现有的 data.db 目录/文件
  if (existsSync(dbPath)) {
    await rm(dbPath, { recursive: true, force: true })
  }

  // 复制备份目录树
  await cp(backupPath, dbPath, { recursive: true })

  return {
    format: 'binary',
    stdout: `已将二进制备份恢复到 ${dbPath}。启动容器即可使用。`,
  }
}

/**
 * 通过 HTTP API 从 SQL 转储文件恢复
 * 要求服务器正在运行
 */
async function restoreSqlBackup(
  backupPath: string,
  options: { containerName: string; port?: number },
): Promise<RestoreResult> {
  const port = options.port
  if (!port) {
    throw new Error('SQL 恢复需要正在运行的容器。请先启动容器，然后重试。')
  }

  logDebug(`正在通过端口 ${port} 上的 HTTP API 恢复 SQL 备份`)

  // 若凭证已存储，则加载认证令牌
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(
    options.containerName,
    Engine.LibSQL,
    username,
  )
  const authToken = creds?.apiKey ?? undefined

  const content = await readFile(backupPath, 'utf-8')

  // 使用状态机将内容拆分为独立语句，该状态机能正确识别引号字符串和注释
  // （避免在字面量内的分号处错误分割）
  const statements = splitSqlStatements(content)

  let executed = 0
  const failures: Array<{ statement: string; error: string }> = []

  for (const stmt of statements) {
    // 跳过事务控制语句 — sqld 以不同方式处理事务
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(stmt)) continue

    try {
      await libsqlQuery(port, `${stmt};`, { authToken })
      executed++
    } catch (error) {
      const message = (error as Error).message
      const preview = stmt.length > 80 ? `${stmt.slice(0, 80)}...` : stmt
      failures.push({ statement: preview, error: message })
      logDebug(`警告：恢复过程中语句执行失败：${message}`)
    }
  }

  let summary = `已从备份中恢复了 ${executed} 条 SQL 语句。`
  if (failures.length > 0) {
    summary += ` ${failures.length} 条语句失败。`
    logDebug(
      `恢复失败详情：\n${failures.map((f) => `  ${f.statement}: ${f.error}`).join('\n')}`,
    )
  }

  return {
    format: 'sql',
    stdout: summary,
  }
}
