/**
 * QuestDB 备份实现
 *
 * QuestDB 使用基于 SQL 导出的自定义备份格式。
 * 由于 QuestDB 使用 PostgreSQL 线协议，可以使用 psql 进行备份，
 * 但 QuestDB 有自己的时序数据 SQL 扩展。
 *
 * 备份策略：
 * - 使用 SHOW CREATE TABLE 导出表结构
 * - 使用 SELECT 导出数据（按指定时间戳列排序）
 * - 输出为标准 SQL 语句
 */

import { writeFile, stat } from 'fs/promises'
import { spawn } from 'child_process'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'
import { loadLocalQuestAuth, type QuestLocalAuth } from './auth'

/**
 * 使用 psql（PostgreSQL 协议）对 QuestDB 执行查询
 */
async function executeQuery(
  port: number,
  database: string,
  query: string,
  auth: QuestLocalAuth,
): Promise<string> {
  // 尝试从配置或 PATH 中查找 psql
  let psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    // 回退到系统 psql
    psqlPath = 'psql'
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      auth.user,
      '-d',
      database,
      '-t', // 仅输出元组（无表头）
      '-A', // 非对齐输出
      '-c',
      query,
    ]

    const proc = spawn(psqlPath!, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: auth.password },
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
        reject(new Error(`psql 错误：${stderr || `退出码 ${code}`}`))
      }
    })
    proc.on('error', (err) => {
      reject(new Error(`执行 psql 失败：${err.message}`))
    })
  })
}

/**
 * 创建 QuestDB 数据库备份
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const database = options.database || container.database || 'qdb'
  const auth = await loadLocalQuestAuth(container.name)

  const lines: string[] = []
  lines.push('-- QuestDB 备份，由 SpinDB 生成')
  lines.push(`-- 数据库：${database}`)
  lines.push(`-- 日期：${new Date().toISOString()}`)
  lines.push('')

  try {
    // 获取表列表
    const tablesQuery = `SELECT table_name FROM tables() WHERE table_name NOT LIKE 'sys.%'`
    const tablesResult = await executeQuery(port, database, tablesQuery, auth)
    const tables = tablesResult.split('\n').filter((t) => t.trim())

    logDebug(`在数据库 ${database} 中找到 ${tables.length} 张表`)

    for (const table of tables) {
      if (!table.trim()) continue

      lines.push(`-- 表：${table}`)
      lines.push('')

      // 获取 CREATE TABLE 语句
      try {
        const createQuery = `SHOW CREATE TABLE "${table}"`
        let createResult = await executeQuery(port, database, createQuery, auth)
        if (createResult) {
          // QuestDB 的 SHOW CREATE TABLE 使用单引号包裹表名，
          // 但 SQL 要求双引号作为标识符。修复引号。
          // 同时，输出有时已以 ; 结尾，避免重复 ;;
          createResult = createResult
            .replace(/^CREATE TABLE '([^']+)'/, 'CREATE TABLE "$1"')
            .replace(/;$/, '') // 移除末尾分号（如果存在）
          lines.push(createResult + ';')
          lines.push('')
        }
      } catch (error) {
        logWarning(`无法获取 ${table} 的 CREATE TABLE：${error}`)
        continue
      }

      // 导出表数据
      try {
        // 尝试使用 table_columns() 函数获取列名
        // 确保 INSERT 语句包含显式列名以提高可靠性
        let columns: string[] = []
        let useExplicitColumns = false

        try {
          const columnsQuery = `SELECT column FROM table_columns('${table}')`
          const columnsResult = await executeQuery(
            port,
            database,
            columnsQuery,
            auth,
          )
          columns = columnsResult.split('\n').filter((c) => c.trim())
          useExplicitColumns = columns.length > 0
        } catch {
          // table_columns() 失败 - 将使用不带显式列名的 SELECT *
          logDebug(`无法获取 ${table} 的列信息，使用 SELECT *`)
        }

        // 获取指定的 timestamp 列（如果有）用于排序
        // QuestDB 表有一个指定的 timestamp 列，名称可以是任意的
        let orderClause = ''
        try {
          const tsQuery = `SELECT designatedTimestamp FROM tables() WHERE table_name = '${table}'`
          const tsResult = await executeQuery(port, database, tsQuery, auth)
          if (tsResult && tsResult.trim()) {
            orderClause = ` ORDER BY "${tsResult.trim()}"`
          }
        } catch {
          // 无指定的 timestamp 或查询失败 - 不排序导出
        }

        // 构建 SELECT 查询 - 如果有显式列名则使用，否则 SELECT *
        const columnList = useExplicitColumns
          ? columns.map((c) => `"${c}"`).join(', ')
          : '*'
        const dataQuery = `SELECT ${columnList} FROM "${table}"${orderClause}`
        const dataResult = await executeQuery(port, database, dataQuery, auth)

        if (dataResult) {
          const rows = dataResult.split('\n').filter((r) => r.trim())
          lines.push(`-- ${table} 的数据：${rows.length} 行`)

          // 生成 INSERT 语句
          for (const row of rows) {
            // 解析管道分隔的输出并转换为 INSERT
            // 修剪每个值以处理 Windows CRLF 换行符
            const values = row.split('|').map((v) => {
              const trimmed = v.trim()
              if (trimmed === '' || trimmed === 'null') return 'NULL'
              // 检查值是否为数字（整数或浮点数）
              if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                return trimmed // 不对数字加引号
              }
              // 转义单引号并包裹字符串
              return `'${trimmed.replace(/'/g, "''")}'`
            })

            // 如果有显式列名则使用，否则使用位置 VALUES
            if (useExplicitColumns) {
              lines.push(
                `INSERT INTO "${table}" (${columnList}) VALUES (${values.join(', ')});`,
              )
            } else {
              lines.push(
                `INSERT INTO "${table}" VALUES (${values.join(', ')});`,
              )
            }
          }
          lines.push('')
        }
      } catch (error) {
        logWarning(`无法导出 ${table} 的数据：${error}`)
      }
    }

    // 写入备份文件
    const content = lines.join('\n')
    await writeFile(outputPath, content, 'utf-8')

    // 获取文件大小
    const stats = await stat(outputPath)

    return {
      path: outputPath,
      format: 'sql',
      size: stats.size,
    }
  } catch (error) {
    throw new Error(
      `创建 QuestDB 备份失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
