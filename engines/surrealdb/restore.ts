/**
 * SurrealDB 恢复模块
 * 支持使用 surreal import 进行基于 SurrealQL 的恢复操作
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import {
  addSurrealAuthArgs,
  getBootstrapSurrealAuth,
  inferSurrealAuthLevel,
  parseSurrealConnectionString,
  sanitizeSurrealAuthArgs,
} from './auth'
import { requireSurrealPath } from './cli-utils'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

/**
 * 标识 SurrealDB 备份文件的 SurrealQL 关键字
 */
const SURREALQL_KEYWORDS = [
  'DEFINE',
  'CREATE',
  'INSERT',
  'UPDATE',
  'SELECT',
  'DELETE',
  'RELATE',
  'LET',
  'BEGIN',
  'COMMIT',
  'USE NS',
  'USE DB',
  'OPTION IMPORT',
]

/**
 * 检查文件内容是否为 SurrealQL 格式
 * 仅读取前 8KB 以避免将大文件加载到内存中
 */
async function looksLikeSurql(filePath: string): Promise<boolean> {
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

    let surqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('#'))
        continue

      checkedLines++

      // 检查是否包含 SurrealQL 关键字
      for (const keyword of SURREALQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          surqlStatementsFound++
          break
        }
      }

      if (surqlStatementsFound >= 2) {
        return true
      }
    }

    return surqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * 从文件检测备份格式
 * 支持的格式：
 * - SurrealQL：包含模式定义和数据语句
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件不存在: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '检测到目录 - SurrealDB 恢复操作需要单个文件',
      restoreCommand: 'SurrealDB 需要单个 .surql 文件进行恢复',
    }
  }

  // 优先检查 .surql 文件扩展名
  if (filePath.endsWith('.surql')) {
    return {
      format: 'surql',
      description: 'SurrealDB SurrealQL 备份文件',
      restoreCommand:
        '通过 surreal import 执行 SurrealQL 语句（spindb restore 会处理此操作）',
    }
  }

  // 基于内容检测
  if (await looksLikeSurql(filePath)) {
    return {
      format: 'surql',
      description: 'SurrealDB SurrealQL 备份文件（通过内容检测）',
      restoreCommand:
        '通过 surreal import 执行 SurrealQL 语句（spindb restore 会处理此操作）',
    }
  }

  return {
    format: 'unknown',
    description: '未知的备份格式',
    restoreCommand: '请使用包含 SurrealQL 语句的 .surql 文件',
  }
}

// SurrealDB 恢复选项
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
}

/**
 * 使用 surreal import 从 SurrealQL 备份恢复
 */
async function restoreSurqlBackup(
  backupPath: string,
  containerName: string,
  port: number,
  namespace: string,
  database: string,
  version?: string,
): Promise<RestoreResult> {
  const surrealPath = await requireSurrealPath(version)
  const savedCreds = await loadCredentials(
    containerName,
    Engine.SurrealDB,
    getDefaultUsername(Engine.SurrealDB),
  )
  const savedAuthLevel = savedCreds
    ? inferSurrealAuthLevel({
        username: savedCreds.username,
        database: savedCreds.database,
        connectionString: savedCreds.connectionString,
      })
    : null
  const auth =
    savedCreds && savedAuthLevel === 'root'
      ? {
          username: savedCreds.username,
          password: savedCreds.password,
          authLevel: savedAuthLevel,
        }
      : getBootstrapSurrealAuth()

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = addSurrealAuthArgs(
      [
        'import',
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--ns',
        namespace,
        '--db',
        database,
        backupPath,
      ],
      auth,
    )

    logDebug(`执行命令: surreal ${sanitizeSurrealAuthArgs(args).join(' ')}`)

    const proc = spawn(surrealPath, args, {
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
        resolve({
          format: 'surql',
          stdout: stdout || 'SurrealQL 语句导入成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `surreal import 退出码为 ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`无法启动 surreal import: ${error.message}`))
    })
  })
}

/**
 * 从备份恢复
 * 支持的格式：
 * - SurrealQL：通过 surreal import 执行语句
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database = 'default', version } = options
  // 使用容器名称作为命名空间（将连字符转换为下划线）
  const namespace = containerName.replace(/-/g, '_')

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件不存在: ${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式: ${format.format}`)

  if (format.format === 'surql') {
    return restoreSurqlBackup(
      backupPath,
      containerName,
      port,
      namespace,
      database,
      version,
    )
  }

  throw new Error(
    `无效的备份格式: ${format.format}。请使用包含 SurrealQL 语句的 .surql 文件。`,
  )
}

/**
 * 解析 SurrealDB 连接字符串
 * 格式: surrealdb://[用户名:密码@]主机[:端口][/命名空间/数据库]
 * 或: ws://主机:端口 或 http://主机:端口
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  namespace: string
  database: string
  user?: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 SurrealDB 连接字符串：期望非空字符串',
    )
  }

  try {
    const parsed = parseSurrealConnectionString(connectionString)
    return {
      host: parsed.host,
      port: parsed.port,
      namespace: parsed.namespace,
      database: parsed.database,
      user: parsed.username,
      password: parsed.password,
    }
  } catch (error) {
    // 如果存在凭据信息，则在错误消息中隐藏
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 SurrealDB 连接字符串: "${sanitized}"。` +
        `期望格式: surrealdb://[用户名:密码@]主机[:端口][/命名空间/数据库]`,
      { cause: error },
    )
  }
}
