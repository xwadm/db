/**
 * InfluxDB 备份模块
 * 支持通过 InfluxDB REST API 进行基于 SQL 的数据导出备份
 */

import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { paths } from '../../config/paths'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { influxdbApiRequest } from './api-client'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

const ADMIN_TOKEN_FILE = 'admin-token.json'

async function loadInfluxAuthToken(
  containerName: string,
  username = getDefaultUsername(Engine.InfluxDB),
): Promise<string | undefined> {
  const tokenPath = dirname(
    paths.getContainerPidPath(containerName, { engine: Engine.InfluxDB }),
  )
  const adminTokenPath = `${tokenPath}/${ADMIN_TOKEN_FILE}`

  try {
    const parsed = JSON.parse(await readFile(adminTokenPath, 'utf-8')) as {
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
 * 使用 InfluxDB REST API 创建 SQL 备份
 * 查询所有表并将数据导出为 SQL INSERT 语句
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container
  const database = options.database || container.database
  const token = await loadInfluxAuthToken(name)

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  logDebug(
    `正在通过端口 ${port} 上的 REST API 创建 InfluxDB SQL 备份，数据库："${database}"`,
  )

  // 获取数据库中的表列表
  const tablesResponse = await influxdbApiRequest(
    port,
    'POST',
    '/api/v3/query_sql',
    {
      db: database,
      q: 'SHOW TABLES',
      format: 'json',
    },
    30000,
    token,
  )

  if (tablesResponse.status !== 200) {
    throw new Error(
      `获取表列表失败：${JSON.stringify(tablesResponse.data)}`,
    )
  }

  const tablesData = tablesResponse.data as Array<Record<string, unknown>>
  const tables: string[] = []

  // 提取用户表名：包含 'iox' 模式或无模式字段的行，
  // 跳过系统模式（information_schema、system 等）
  if (Array.isArray(tablesData)) {
    for (const row of tablesData) {
      const schema = row.table_schema as string | undefined
      if (schema && schema !== 'iox') continue
      const tableName =
        (row.table_name as string) ||
        (row.name as string) ||
        (Object.values(row)[0] as string)
      if (tableName) {
        tables.push(tableName)
      }
    }
  }

  logDebug(`找到 ${tables.length} 张表：${tables.join(', ')}`)

  // 构建 SQL 转储内容
  let sqlContent = `-- InfluxDB SQL 备份\n`
  sqlContent += `-- 数据库：${database}\n`
  sqlContent += `-- 创建时间：${new Date().toISOString()}\n\n`

  for (const table of tables) {
    logDebug(`正在导出表：${table}`)

    // 查询列元数据以识别标签列
    // 在 InfluxDB 3.x 中，标签使用 Dictionary(Int32, Utf8) 类型
    const tagColumns: string[] = []
    try {
      const colResponse = await influxdbApiRequest(
        port,
        'POST',
        '/api/v3/query_sql',
        {
          db: database,
          q: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}'`,
          format: 'json',
        },
        30000,
        token,
      )
      if (colResponse.status === 200 && Array.isArray(colResponse.data)) {
        for (const col of colResponse.data as Array<Record<string, unknown>>) {
          const dataType = String(col.data_type || '')
          if (dataType.includes('Dictionary')) {
            tagColumns.push(String(col.column_name))
          }
        }
      }
    } catch {
      logDebug(`警告：无法查询表 ${table} 的列元数据`)
    }

    // 查询表中的所有数据
    const dataResponse = await influxdbApiRequest(
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: `SELECT * FROM "${table.replace(/"/g, '""')}"`,
        format: 'json',
      },
      30000,
      token,
    )

    if (dataResponse.status !== 200) {
      logDebug(
        `警告：导出表 ${table} 失败：${JSON.stringify(dataResponse.data)}`,
      )
      continue
    }

    const rows = dataResponse.data as Array<Record<string, unknown>>

    if (Array.isArray(rows) && rows.length > 0) {
      sqlContent += `-- 表：${table}\n`
      if (tagColumns.length > 0) {
        sqlContent += `-- 标签：${tagColumns.join(', ')}\n`
      }

      for (const row of rows) {
        const columns = Object.keys(row)
        const values = columns.map((col) => {
          const val = row[col]
          if (val === null || val === undefined) return 'NULL'
          if (typeof val === 'number') return String(val)
          if (typeof val === 'boolean') return val ? 'true' : 'false'
          return `'${String(val).replace(/'/g, "''")}'`
        })
        sqlContent += `INSERT INTO "${table.replace(/"/g, '""')}" (${columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${values.join(', ')});\n`
      }
      sqlContent += '\n'
    }
  }

  // 将 SQL 内容写入文件
  await writeFile(outputPath, sqlContent, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}
