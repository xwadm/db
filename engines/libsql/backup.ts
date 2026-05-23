/**
 * libSQL 备份模块
 * 支持二进制（文件复制）和 SQL 转储备份格式
 */

import { mkdir, stat, cp } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import {
  loadCredentials,
  getDefaultUsername,
} from '../../core/credential-manager'
import { libsqlQuery } from './api-client'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
  type LibSQLFormat,
} from '../../types'
import { writeFile } from 'fs/promises'

/**
 * 创建 libSQL 数据库的备份
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const format = (options.format || 'binary') as LibSQLFormat

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  if (format === 'binary') {
    return createBinaryBackup(container, outputPath)
  }

  return createSqlBackup(container, outputPath)
}

/**
 * 通过复制数据库目录创建二进制备份。
 * sqld 的 --db-path 参数会创建目录树（data.db/dbs/default/data 是实际的 SQLite 文件，
 * 还包括 WAL、metastore 等）。我们复制整个目录以保留干净恢复所需的所有状态。
 */
async function createBinaryBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const containerDir = paths.getContainerPath(container.name, {
    engine: 'libsql',
  })
  const dbDir = join(containerDir, 'data', 'data.db')

  if (!existsSync(dbDir)) {
    throw new Error(`未找到数据库目录：${dbDir}。容器是否已初始化？`)
  }

  logDebug(`正在创建 libSQL 数据库的二进制备份：${dbDir}`)

  // 复制整个 data.db 目录树
  await cp(dbDir, outputPath, { recursive: true })

  // 计算备份的总大小
  let totalSize = 0
  const isDir = statSync(outputPath).isDirectory()
  if (isDir) {
    const { readdir } = await import('fs/promises')
    async function sumDir(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await sumDir(fullPath)
        } else {
          totalSize += (await stat(fullPath)).size
        }
      }
    }
    await sumDir(outputPath)
  } else {
    totalSize = (await stat(outputPath)).size
  }

  return {
    path: outputPath,
    format: 'binary',
    size: totalSize,
  }
}

/**
 * 通过 HTTP API 创建 SQL 转储备份
 */
async function createSqlBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { port, name } = container

  logDebug(`正在通过端口 ${port} 上的 HTTP API 创建 libSQL 数据库的 SQL 备份`)

  // 如果存储了凭证，则加载认证令牌
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(name, Engine.LibSQL, username)
  const authToken = creds?.apiKey ?? undefined

  // 获取所有表名
  const tablesResult = await libsqlQuery(
    port,
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%' ORDER BY name",
    { authToken },
  )

  const lines: string[] = [
    '-- libSQL SQL 转储',
    `-- 服务器端口：${port}`,
    `-- 日期：${new Date().toISOString()}`,
    '',
    'BEGIN TRANSACTION;',
    '',
  ]

  for (const row of tablesResult.rows) {
    const tableName = String(row[0]?.type === 'text' ? row[0].value : row[0])
    const createSql = String(row[1]?.type === 'text' ? row[1].value : row[1])
    const escapedName = tableName.replace(/"/g, '""')

    lines.push(`${createSql};`)
    lines.push('')

    // 转储所有行
    const dataResult = await libsqlQuery(
      port,
      `SELECT * FROM "${escapedName}"`,
      { authToken },
    )

    for (const dataRow of dataResult.rows) {
      const values = dataRow.map((val) => {
        if (val.type === 'null') return 'NULL'
        if (val.type === 'integer') return val.value
        if (val.type === 'float') return String(val.value)
        if (val.type === 'text')
          return `'${String(val.value).replace(/'/g, "''")}'`
        if (val.type === 'blob')
          return `X'${Buffer.from(val.base64, 'base64').toString('hex')}'`
        return 'NULL'
      })

      const columns = dataResult.cols.map(
        (c) => `"${c.name.replace(/"/g, '""')}"`,
      )
      lines.push(
        `INSERT INTO "${escapedName}" (${columns.join(', ')}) VALUES (${values.join(', ')});`,
      )
    }

    lines.push('')
  }

  // 获取索引
  const indexResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    { authToken },
  )
  for (const row of indexResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  // 获取视图
  const viewResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='view' ORDER BY name",
    { authToken },
  )
  for (const row of viewResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  // 获取触发器
  const triggerResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    { authToken },
  )
  for (const row of triggerResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  lines.push('')
  lines.push('COMMIT;')
  lines.push('')

  const content = lines.join('\n')
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)
  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}
