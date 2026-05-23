/**
 * QuestDB 恢复实现
 *
 * 使用 PostgreSQL 线协议将 SQL 备份恢复到 QuestDB。
 * QuestDB 兼容 psql 执行 SQL 语句。
 */

import { open, readFile } from 'fs/promises'
import { spawn, spawnSync } from 'child_process'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'
import { type BackupFormat, type RestoreResult } from '../../types'
import { loadLocalQuestAuth } from './auth'

// 仅读取前 8KB 用于格式检测
const HEADER_SIZE = 8192

/**
 * 根据文件内容检测备份格式
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // 先检查文件扩展名
  const lowerPath = filePath.toLowerCase()
  if (lowerPath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'SQL 转储文件',
      restoreCommand: 'psql',
    }
  }

  // 读取文件头部进行基于内容的格式检测
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

  // 检查 SQL 模式
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim().toUpperCase()
    if (
      trimmed.startsWith('CREATE TABLE') ||
      trimmed.startsWith('INSERT INTO') ||
      trimmed.startsWith('-- QUESTDB') ||
      trimmed.startsWith('-- TABLE:')
    ) {
      return {
        format: 'sql',
        description: 'SQL 转储文件',
        restoreCommand: 'psql',
      }
    }
  }

  return {
    format: 'unknown',
    description: '未知格式',
    restoreCommand: '',
  }
}

/**
 * 解析 QuestDB/PostgreSQL 连接字符串
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user: string
  password?: string
} {
  // 支持 postgresql:// 和 questdb:// 两种协议前缀
  let url: URL
  try {
    // 将 questdb:// 替换为 postgresql:// 以便进行 URL 解析
    const normalized = connectionString.replace(
      /^questdb:\/\//,
      'postgresql://',
    )
    url = new URL(normalized)
  } catch {
    throw new Error(
      `无效的连接字符串: ${connectionString}\n` +
        `期望格式: postgresql://user:password@host:port/database`,
    )
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? parseInt(url.port, 10) : 8812,
    database: url.pathname.replace(/^\//, '') || 'qdb',
    user: url.username || 'admin',
    password: url.password || 'quest',
  }
}

export type RestoreOptions = {
  containerName: string
  port: number
  database: string
  version: string
  clean?: boolean
}

/**
 * 将备份恢复到 QuestDB
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database, clean } = options
  const auth = await loadLocalQuestAuth(containerName)

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  if (format.format === 'unknown') {
    throw new Error(
      `无法检测备份格式: ${backupPath}\n` +
        '支持的格式: .sql（SQL 转储）',
    )
  }

  logDebug(`正在将 ${format.format} 格式备份恢复到 QuestDB 数据库 ${database}`)

  // 查找 psql 可执行文件
  let psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    psqlPath = 'psql'
  }

  // 构建恢复命令参数
  // 使用 ON_ERROR_STOP 在遇到任何 SQL 错误时立即终止（否则 psql 会静默继续执行）
  const args = [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    auth.user,
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    backupPath,
  ]

  // 如果是干净恢复，在恢复前先删除已有表
  if (clean) {
    logDebug('已请求干净恢复 - 正在从备份中提取表名')

    // 读取 SQL 文件，从 CREATE TABLE 语句中提取表名
    const sqlContent = await readFile(backupPath, 'utf-8')
    // 匹配 CREATE TABLE [IF NOT EXISTS] "table_name" 或 CREATE TABLE [IF NOT EXISTS] table_name
    const tableRegex =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))/gi
    const tables: string[] = []
    let match

    while ((match = tableRegex.exec(sqlContent)) !== null) {
      const tableName = match[1] || match[2]
      if (tableName && !tables.includes(tableName)) {
        tables.push(tableName)
      }
    }

    if (tables.length > 0) {
      logDebug(`发现 ${tables.length} 个需要删除的表: ${tables.join(', ')}`)

      // 对每个表执行 DROP TABLE IF EXISTS
      for (const table of tables) {
        const dropQuery = `DROP TABLE IF EXISTS "${table}";`
        logDebug(`正在执行: ${dropQuery}`)

        const dropResult = spawnSync(
          psqlPath!,
          [
            '-h',
            '127.0.0.1',
            '-p',
            String(port),
            '-U',
            auth.user,
            '-d',
            database,
            '-c',
            dropQuery,
          ],
          {
            env: { ...process.env, PGPASSWORD: auth.password },
          },
        )

        if (dropResult.error) {
          logDebug(
            `警告: 删除表 ${table} 失败: ${dropResult.error.message}`,
          )
        } else if (dropResult.status !== 0) {
          logDebug(
            `警告: DROP TABLE ${table} 退出码为 ${dropResult.status}`,
          )
        }
      }
    } else {
      logDebug('备份中未找到 CREATE TABLE 语句')
    }
  }

  return new Promise((resolve, reject) => {
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
        resolve({
          format: format.format,
          stdout,
          stderr,
          code: 0,
        })
      } else if (stderr.includes('already exists')) {
        // 将 "already exists" 视为非致命错误（恢复过程中的表重建）
        resolve({
          format: format.format,
          stdout,
          stderr,
          code: code ?? 1,
        })
      } else {
        reject(new Error(`恢复失败: ${stderr || `退出码 ${code}`}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`执行 psql 失败: ${err.message}`))
    })
  })
}
