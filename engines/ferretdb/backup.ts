/**
 * FerretDB 备份模块
 *
 * 在 MongoDB 兼容代理上使用 mongodump 创建备份。
 * 此方式能正确保留 FerretDB 的文档模型，并且在启用 SCRAM 认证时也能正常工作，
 * 与旧的基于 pg_dump 的后端备份不同。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { buildMongoUri } from '../mongo-uri'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from '../mongodb/cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

// 对 MongoDB URI 中的凭据进行脱敏处理
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

// 对 MongoDB 命令行参数中的 URI 进行脱敏处理
function sanitizeMongoArgs(args: string[]): string[] {
  const sanitized = [...args]
  const uriIndex = sanitized.indexOf('--uri')
  if (uriIndex >= 0 && uriIndex + 1 < sanitized.length) {
    sanitized[uriIndex + 1] = redactMongoUri(sanitized[uriIndex + 1])
  }
  return sanitized
}

/**
 * 使用 pg_dump 创建 FerretDB 数据库备份
 *
 * 支持两种格式：
 * - 'sql'：纯 SQL 文本格式
 * - 'custom'（默认）：PostgreSQL 自定义格式（.dump）
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, version } = container
  const database = options.database || container.database || 'test'
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
    Engine.FerretDB,
    getDefaultUsername(Engine.FerretDB),
  )

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, database, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }, container.bindAddress ?? '127.0.0.1'),
        '--db',
        database,
      ]
    : [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--db',
        database,
      ]

  // FerretDB 现在底层使用 MongoDB 兼容的备份格式：
  // - archive：单个压缩文件
  // - bson：目录转储
  const format = options.format ?? 'archive'
  if (format === 'archive') {
    args.push('--archive=' + outputPath, '--gzip')
  } else {
    args.push('--out', outputPath)
  }

  logDebug(`正在运行 mongodump，参数: ${sanitizeMongoArgs(args).join(' ')}`)

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongodump, args, spawnOptions)

    let stderr = ''
    let finished = false

    proc.stdout?.on('data', () => {
      // mongodump 通常将进度信息写入 stderr
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      if (finished) return
      finished = true
      reject(err)
    })

    proc.on('close', (code) => {
      if (finished) return
      finished = true

      if (code === 0) {
        // 获取备份大小
        const getBackupSize = async (): Promise<number> => {
          if (format !== 'bson') {
            return (await stat(outputPath)).size
          }

          const { readdir, stat: fileStat } = await import('fs/promises')
          const sumDirectory = async (dirPath: string): Promise<number> => {
            const entries = await readdir(dirPath, { withFileTypes: true })
            let total = 0
            for (const entry of entries) {
              const entryPath = join(dirPath, entry.name)
              if (entry.isDirectory()) {
                total += await sumDirectory(entryPath)
              } else if (entry.isFile()) {
                total += (await fileStat(entryPath)).size
              }
            }
            return total
          }

          return sumDirectory(outputPath)
        }

        getBackupSize()
          .then((size) => {
            resolve({
              path: outputPath,
              format,
              size,
            })
          })
          .catch(() => {
            // 大小计算失败，使用 0
            resolve({
              path: outputPath,
              format,
              size: 0,
            })
          })
      } else {
        reject(new Error(stderr || `mongodump 以退出码 ${code} 退出`))
      }
    })
  })
}

/**
 * 创建用于克隆目的的备份
 * 默认使用自定义格式，以确保可靠性和更小的体积
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
