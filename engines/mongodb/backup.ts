/**
 * MongoDB 备份模块
 * 封装 mongodump 用于创建数据库备份
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import { buildMongoUri } from '../mongo-uri'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

function redactMongoUri(uri: string): string {
  try {
    const url = new URL(uri)
    if (!url.username && !url.password) {
      return uri
    }
    return `${url.protocol}//<已脱敏>@${url.host}${url.pathname}${url.search}`
  } catch {
    return 'mongodb://<已脱敏>'
  }
}

function sanitizeMongoArgs(args: string[]): string[] {
  const sanitized = [...args]
  const uriIndex = sanitized.indexOf('--uri')
  if (uriIndex >= 0 && uriIndex + 1 < sanitized.length) {
    sanitized[uriIndex + 1] = redactMongoUri(sanitized[uriIndex + 1])
  }
  return sanitized
}

async function getDirectorySize(dirPath: string): Promise<number> {
  const { readdir } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  let total = 0

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath)
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size
    }
  }

  return total
}

/**
 * 使用 mongodump 创建 MongoDB 数据库备份
 *
 * 支持两种格式：
 * - 'bson'：按集合的 BSON 文件目录转储
 * - 'archive'（默认）：单个压缩归档文件
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, database, version } = container
  const db = options.database || database

  const mongodump = await getMongodumpPath(version)
  if (!mongodump) {
    throw new Error(MONGODUMP_NOT_FOUND_ERROR)
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const savedCreds = await loadCredentials(
    name,
    Engine.MongoDB,
    getDefaultUsername(Engine.MongoDB),
  )

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, db, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }, container.bindAddress ?? '127.0.0.1'),
        '--db',
        db,
      ]
    : [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--db',
        db,
      ]

  // 确定输出格式（默认为 'archive'，参见 backup-formats.ts）
  const format = options.format ?? 'archive'
  if (format === 'archive') {
    // 归档格式：单个压缩文件
    args.push('--archive=' + outputPath, '--gzip')
  } else {
    // 目录格式（bson）：输出到目录
    args.push('--out', outputPath)
  }

  logDebug(`正在执行 mongodump，参数：${sanitizeMongoArgs(args).join(' ')}`)

  // 注意：不要使用 shell 模式 —— spawn 在 shell: false（默认值）时
  // 能正确处理包含空格的路径。shell 模式会破坏类似 "C:\Program Files\..." 的路径
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongodump, args, spawnOptions)

    let stderr = ''

    proc.stdout?.on('data', () => {
      // mongodump 将进度信息输出到 stderr，stdout 通常为空
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        // 获取备份大小
        let size = 0
        try {
          if (options.format === 'archive') {
            // 归档文件
            const stats = await stat(outputPath)
            size = stats.size
          } else {
            // 目录 - 累加所有转储文件大小
            const dbDir = join(outputPath, db)
            if (existsSync(dbDir)) {
              size = await getDirectorySize(dbDir)
            }
          }
        } catch {
          // 大小计算失败，使用 0
        }

        resolve({
          path: outputPath,
          format: options.format === 'archive' ? 'archive' : 'directory',
          size,
        })
      } else {
        reject(new Error(stderr || `mongodump 以退出码 ${code} 退出`))
      }
    })
  })
}

/**
 * 创建用于克隆的备份
 * 默认使用归档格式以确保可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, {
    database: container.database,
    format: 'archive',
  })
}
