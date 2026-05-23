/**
 * CockroachDB 备份模块
 * 支持通过 cockroach sql 进行基于 SQL 的备份
 *
 * CockroachDB 备份格式：
 * - SQL：DDL + INSERT 语句（可移植、人类可读）
 */

import { spawn } from 'child_process'
import { stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireCockroachPath,
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
  buildLocalCockroachSqlArgs,
} from './cli-utils'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * 执行 CockroachDB 查询并返回结果
 */
async function execCockroachQuery(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
  query: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildLocalCockroachSqlArgs({
      containerName,
      port,
      database,
    })
    args.push('--execute', query, '--format=csv')

    const proc = spawn(cockroachPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve(stdout)
      } else {
        reject(new Error(stderr || `cockroach sql 退出码 ${code}`))
      }
    })
  })
}

/**
 * 获取数据库中的表列表
 */
async function getTables(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
): Promise<string[]> {
  // 验证数据库标识符以防止 SQL 注入
  validateCockroachIdentifier(database, 'database')

  const result = await execCockroachQuery(
    cockroachPath,
    containerName,
    port,
    database,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )

  // 解析 CSV 输出（跳过表头行）
  const lines = result.trim().split('\n')
  if (lines.length <= 1) return []

  return lines
    .slice(1) // 跳过表头
    .map((line) => line.trim())
    .filter((t) => t)
}

/**
 * 获取某个表的 CREATE TABLE 语句
 */
async function getCreateTableStatement(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
  table: string,
): Promise<string> {
  // 验证标识符以防止 SQL 注入
  validateCockroachIdentifier(database, 'database')
  validateCockroachIdentifier(table, 'table')
  const escapedTable = escapeCockroachIdentifier(table)

  const result = await execCockroachQuery(
    cockroachPath,
    containerName,
    port,
    database,
    `SHOW CREATE TABLE ${escapedTable}`,
  )

  // 解析 CSV 输出 - 格式为：table_name,create_statement
  const lines = result.trim().split('\n')
  if (lines.length < 2) {
    throw new Error(`无法获取 ${table} 的 CREATE TABLE 语句`)
  }

  // CREATE 语句可能跨多行，所以将表头之后的所有内容合并
  // 然后提取语句部分
  const dataLines = lines.slice(1).join('\n')

  // CockroachDB CSV 输出的 CREATE 语句在第二列
  // 格式："table_name","CREATE TABLE..."
  const match = dataLines.match(/^"?[^"]*"?,\s*"?(CREATE TABLE[\s\S]*)"?$/i)
  if (match) {
    // 移除首尾引号并反转义双引号
    return match[1].replace(/^"|"$/g, '').replace(/""/g, '"')
  }

  // 回退方案：返回第一个逗号之后的所有内容
  const commaIdx = dataLines.indexOf(',')
  if (commaIdx !== -1) {
    return dataLines
      .slice(commaIdx + 1)
      .trim()
      .replace(/^"|"$/g, '')
  }

  return dataLines
}

/**
 * 获取某个表数据的 INSERT 语句
 */
async function getTableData(
  cockroachPath: string,
  containerName: string,
  port: number,
  database: string,
  table: string,
): Promise<string[]> {
  validateCockroachIdentifier(table, 'table')
  const escapedTable = escapeCockroachIdentifier(table)

  // 获取列名
  const columnsResult = await execCockroachQuery(
    cockroachPath,
    containerName,
    port,
    database,
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, "''")}' ORDER BY ordinal_position`,
  )

  const columns = columnsResult
    .trim()
    .split('\n')
    .slice(1) // 跳过表头
    .map((line) => line.trim())
    .filter((c) => c)

  if (columns.length === 0) {
    return []
  }

  // 获取数据
  const dataResult = await execCockroachQuery(
    cockroachPath,
    containerName,
    port,
    database,
    `SELECT * FROM ${escapedTable}`,
  )

  const lines = dataResult.trim().split('\n')
  if (lines.length <= 1) {
    return [] // 无数据行
  }

  const inserts: string[] = []

  // 解析 CSV 数据行
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue

    // 简单的 CSV 解析（处理基本场景）
    const fields = parseCSVLine(line)
    if (fields.length !== columns.length) {
      logWarning(
        `表 ${table} 列数不匹配：期望 ${columns.length} 列，实际 ${fields.length} 列`,
      )
      continue
    }

    const escapedValues = fields.map((field) => {
      // 未加引号的空字符串或未加引号的字面值 'NULL' 转为 SQL NULL
      if (!field.wasQuoted && (field.value === '' || field.value === 'NULL')) {
        return 'NULL'
      }
      // 加引号的空字符串保留为空字符串，其他值进行转义
      return `'${field.value.replace(/'/g, "''")}'`
    })

    const columnList = columns
      .map((c) => escapeCockroachIdentifier(c))
      .join(', ')
    inserts.push(
      `INSERT INTO ${escapedTable} (${columnList}) VALUES (${escapedValues.join(', ')});`,
    )
  }

  return inserts
}

/**
 * 解析后的 CSV 字段，包含值和是否被引号包裹的信息
 */
type CSVField = {
  value: string
  wasQuoted: boolean
}

/**
 * 解析 CSV 行（基础实现）
 * 返回字段值以及该字段是否被引号包裹，
 * 这对于区分空字符串和 NULL 很关键
 */
function parseCSVLine(line: string): CSVField[] {
  const fields: CSVField[] = []
  let current = ''
  let inQuotes = false
  let fieldWasQuoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // 转义引号
        current += '"'
        i++
      } else {
        // 切换引号状态
        if (!inQuotes) {
          fieldWasQuoted = true
        }
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      fields.push({ value: current, wasQuoted: fieldWasQuoted })
      current = ''
      fieldWasQuoted = false
    } else {
      current += char
    }
  }

  fields.push({ value: current, wasQuoted: fieldWasQuoted })
  return fields
}

/**
 * 创建 SQL 备份（DDL + INSERT 语句）
 */
async function createSqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { port, version } = container
  const { name } = container

  const cockroachPath = await requireCockroachPath(version)

  const lines: string[] = []
  lines.push('-- CockroachDB 备份，由 SpinDB 生成')
  lines.push(`-- 日期：${new Date().toISOString()}`)
  lines.push(`-- 数据库：${database}`)
  lines.push('')

  // 获取表列表
  const tables = await getTables(cockroachPath, name, port, database)
  logDebug(`找到 ${tables.length} 张表待备份`)

  for (const table of tables) {
    lines.push(`-- 表：${table}`)
    lines.push('')

    // 获取 CREATE TABLE 语句
    try {
      const createStmt = await getCreateTableStatement(
        cockroachPath,
        name,
        port,
        database,
        table,
      )
      lines.push(createStmt + ';')
      lines.push('')
    } catch (error) {
      logWarning(`无法获取 ${table} 的 CREATE TABLE 语句：${error}`)
      continue
    }

    // 导出数据
    try {
      const inserts = await getTableData(
        cockroachPath,
        name,
        port,
        database,
        table,
      )
      if (inserts.length > 0) {
        lines.push(...inserts)
        lines.push('')
      }
    } catch (error) {
      logWarning(`无法导出 ${table} 的数据：${error}`)
    }
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 写入文件
  const content = lines.join('\n')
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}

/**
 * 创建备份
 *
 * @param container - 容器配置
 * @param outputPath - 备份文件写入路径
 * @param options - 备份选项
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database || 'defaultdb'

  return createSqlBackup(container, outputPath, database)
}

/**
 * 为克隆目的创建备份
 * 使用 SQL 格式以确保可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSqlBackup(
    container,
    outputPath,
    container.database || 'defaultdb',
  )
}