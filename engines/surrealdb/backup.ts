/**
 * SurrealDB 备份模块
 * 支持使用 surreal export 进行基于 SurrealQL 的备份
 *
 * SurrealDB 备份格式：
 * - SurrealQL：以 SurrealQL 语句形式表示的结构和数据（可移植、人类可读）
 */

import { spawn } from 'child_process'
import { readFile, rename, rm, stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import {
  addSurrealAuthArgs,
  getBootstrapSurrealAuth,
  inferSurrealAuthLevel,
  sanitizeSurrealAuthArgs,
} from './auth'
import { requireSurrealPath } from './cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

/**
 * 判断是否应该从备份中移除某条 SurrealQL 语句
 *
 * 移除用户定义、访问控制和命名空间切换语句，
 * 以避免在恢复时产生冲突或安全问题。
 */
function shouldStripSurrealStatement(statement: string): boolean {
  const normalized = statement.trim().replace(/\s+/g, ' ').toUpperCase()
  return (
    normalized.startsWith('DEFINE USER ') ||
    normalized.startsWith('DEFINE ACCESS ') ||
    normalized === 'OPTION IMPORT;' ||
    normalized.startsWith('USE NS ') ||
    normalized.startsWith('USE DB ')
  )
}

/**
 * 清理备份内容，移除敏感或不必要的语句
 */
export function sanitizeBackupContent(content: string): string {
  let result = ''
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (const char of content) {
    current += char

    if (escaped) {
      escaped = false
      continue
    }

    if (quote) {
      if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (char === ';') {
      result += shouldStripSurrealStatement(current) ? '\n' : current
      current = ''
    }
  }

  if (current.length > 0) {
    result += shouldStripSurrealStatement(current) ? '\n' : current
  }

  return result
}

/**
 * 使用 surreal export 创建 SurrealQL 备份
 */
async function createSurqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { name, port, version } = container
  // SurrealDB 使用命名空间/数据库层级结构 —— 使用容器名作为命名空间
  const namespace = container.name.replace(/-/g, '_')
  const savedCreds = await loadCredentials(
    name,
    Engine.SurrealDB,
    getDefaultUsername(Engine.SurrealDB),
  )
  const auth = savedCreds
    ? {
        username: savedCreds.username,
        password: savedCreds.password,
        authLevel: inferSurrealAuthLevel({
          username: savedCreds.username,
          database: savedCreds.database,
          connectionString: savedCreds.connectionString,
        }),
      }
    : getBootstrapSurrealAuth()

  const surrealPath = await requireSurrealPath(version)

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  return new Promise<BackupResult>((resolve, reject) => {
    // surreal export 命令
    const args = addSurrealAuthArgs(
      [
        'export',
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--ns',
        namespace,
        '--db',
        database,
        outputPath,
      ],
      auth,
    )

    logDebug(`正在执行：surreal ${sanitizeSurrealAuthArgs(args).join(' ')}`)

    const proc = spawn(surrealPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let _stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      _stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          const sanitized = sanitizeBackupContent(
            await readFile(outputPath, 'utf-8'),
          )
          const tempPath = `${outputPath}.tmp`
          try {
            await writeFile(tempPath, sanitized, 'utf-8')
            await rename(tempPath, outputPath)
          } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {})
            throw error
          }
          const stats = await stat(outputPath)
          resolve({
            path: outputPath,
            format: 'surql',
            size: stats.size,
          })
        } catch (error) {
          reject(new Error(`备份文件未创建：${error}`))
        }
      } else if (code === null) {
        reject(
          new Error(
            `surreal export 被信号终止${stderr ? `：${stderr}` : ''}`,
          ),
        )
      } else {
        reject(
          new Error(
            `surreal export 以退出码 ${code} 退出${stderr ? `：${stderr}` : ''}`,
          ),
        )
      }
    })
  })
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
  const database = options.database || container.database || 'default'

  return createSurqlBackup(container, outputPath, database)
}

/**
 * 创建用于克隆的备份
 * 使用 SurrealQL 格式以确保可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSurqlBackup(
    container,
    outputPath,
    container.database || 'default',
  )
}
