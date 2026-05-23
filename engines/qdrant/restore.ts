/**
 * Qdrant 恢复模块
 * 支持通过 Qdrant 快照文件进行基于快照的恢复
 */

import { copyFile, open, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * 从文件检测备份格式
 * Qdrant 使用快照文件，这些文件是 tar.gz 归档
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '检测到目录 - Qdrant 使用单个快照文件',
      restoreCommand: 'Qdrant 恢复需要单个 .snapshot 文件',
    }
  }

  // 检查文件扩展名是否为 .snapshot
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Qdrant 快照文件',
      restoreCommand:
        '复制到 snapshots 目录并使用 Qdrant API（spindb restore 会自动处理）',
    }
  }

  // 检查文件内容是否存在 gzip 魔术字节（快照文件是压缩的）
  try {
    const buffer = Buffer.alloc(4)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 4, 0)
      // Gzip 魔术字节: 1f 8b
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return {
          format: 'snapshot',
          description: 'Qdrant 快照文件（通过魔术字节检测）',
          restoreCommand:
            '复制到 snapshots 目录并使用 Qdrant API（spindb restore 会自动处理）',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头部时出错: ${error}`)
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用 .snapshot 文件进行恢复',
  }
}

// Qdrant 恢复选项
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * 从快照备份恢复
 *
 * 重要：恢复快照前需要先停止 Qdrant。
 * 快照文件会被复制到 snapshots 目录，之后重新启动 Qdrant。
 * Qdrant 启动时会自动从快照恢复。
 */
async function restoreSnapshotBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const containerDir = paths.getContainerPath(containerName, { engine: 'qdrant' })
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'qdrant' })
  const snapshotsDir = join(targetDir, 'snapshots')
  const snapshotName = basename(backupPath)
  const targetPath = join(snapshotsDir, snapshotName)
  const pendingSnapshotMarker = join(containerDir, 'pending-storage-snapshot')

  logDebug(`正在将快照恢复到: ${targetPath}`)

  // 确保 snapshots 目录存在
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true })
  }

  // 先将备份复制到 snapshots 目录，确保复制成功后再移除现有数据
  // 防止复制失败导致数据丢失
  await copyFile(backupPath, targetPath)

  // 复制成功后移除现有集合，确保干净恢复
  const collectionsDir = join(targetDir, 'collections')
  if (existsSync(collectionsDir)) {
    logDebug('正在移除现有集合以进行干净恢复')
    await rm(collectionsDir, { recursive: true, force: true })
  }

  await writeFile(pendingSnapshotMarker, targetPath, 'utf-8')

  return {
    format: 'snapshot',
    stdout:
      `已将快照恢复到 ${targetPath}。下次启动时将自动加载存储快照。`,
    code: 0,
  }
}

/**
 * 从备份恢复
 * 仅支持快照格式
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, dataDir } = options

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到: ${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式: ${format.format}`)

  if (format.format === 'snapshot') {
    return restoreSnapshotBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `无效的备份格式: ${format.format}。请使用 .snapshot 文件进行恢复。`,
  )
}

/**
 * 解析 Qdrant 连接字符串
 * 格式: http://host[:port]、https://host[:port] 或 grpc://host[:port]
 *
 * Qdrant 使用集合代替传统数据库
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https' | 'grpc'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 Qdrant 连接字符串: 需要非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 Qdrant 连接字符串: "${connectionString}"。` +
        `期望格式: http://host[:port] 或 grpc://host[:port]`,
      { cause: error },
    )
  }

  // 验证协议
  let protocol: 'http' | 'https' | 'grpc'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else if (url.protocol === 'grpc:') {
    protocol = 'grpc'
  } else {
    throw new Error(
      `无效的 Qdrant 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "http://"、"https://" 或 "grpc://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const defaultPort = protocol === 'grpc' ? 6334 : 6333
  const port = parseInt(url.port, 10) || defaultPort

  return {
    host,
    port,
    protocol,
  }
}