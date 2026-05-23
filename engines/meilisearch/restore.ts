/**
 * Meilisearch 恢复模块
 * 支持使用 Meilisearch 快照文件进行基于快照的恢复
 */

import { copyFile, open, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * 从文件中检测备份格式
 * Meilisearch 使用压缩归档格式的快照文件
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`未找到备份文件: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '发现目录 — Meilisearch 使用单个快照文件',
      restoreCommand:
        'Meilisearch 需要单个 .snapshot 文件来进行恢复',
    }
  }

  // 检查文件扩展名是否为 .snapshot
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Meilisearch 快照文件',
      restoreCommand:
        '复制到 snapshots 目录并重启 Meilisearch（spindb restore 会处理此操作）',
    }
  }

  // 检查文件内容的 gzip 魔术字节（快照文件是压缩的）
  try {
    const buffer = Buffer.alloc(4)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 4, 0)
      // Gzip 魔术字节: 1f 8b
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return {
          format: 'snapshot',
          description: 'Meilisearch 快照文件（通过魔术字节检测）',
          restoreCommand:
            '复制到 snapshots 目录并重启 Meilisearch（spindb restore 会处理此操作）',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头时出错: ${error}`)
  }

  return {
    format: 'unknown',
    description: '未知的备份格式',
    restoreCommand: '请使用 .snapshot 文件进行恢复',
  }
}

// Meilisearch 的恢复选项
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * 从快照备份恢复
 *
 * 重要: 在执行快照恢复前，Meilisearch 必须处于停止状态。
 * 快照文件会被复制到 snapshots 目录，并创建一个标记文件，
 * 以便下一次 start() 调用时使用 --import-snapshot 标志。
 */
async function restoreSnapshotBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir ||
    paths.getContainerDataPath(containerName, { engine: 'meilisearch' })
  // 快照目录必须与 data 平级，不能放在 data 内部
  // 重要: 若 --snapshot-dir 位于 --db-path 内部，Meilisearch 会失败
  const containerDir = paths.getContainerPath(containerName, {
    engine: 'meilisearch',
  })
  const snapshotsDir = join(containerDir, 'snapshots')
  const snapshotName = basename(backupPath)
  const targetPath = join(snapshotsDir, snapshotName)

  logDebug(`正在将快照恢复到: ${targetPath}`)

  // 确保 snapshots 目录存在
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true })
  }

  // 首先将备份复制到 snapshots 目录，确保复制成功
  // 之后才移除已有数据（防止复制失败导致数据丢失）
  await copyFile(backupPath, targetPath)

  // 复制成功后，移除已有索引以进行干净恢复
  const indexesDir = join(targetDir, 'indexes')
  if (existsSync(indexesDir)) {
    logDebug('正在移除已有索引以进行干净恢复')
    await rm(indexesDir, { recursive: true, force: true })
  }

  // 同时移除 tasks 数据库
  const tasksDir = join(targetDir, 'tasks')
  if (existsSync(tasksDir)) {
    logDebug('正在移除已有 tasks 以进行干净恢复')
    await rm(tasksDir, { recursive: true, force: true })
  }

  // 写入标记文件，以便 start() 知道需使用 --import-snapshot
  // 标记文件包含要导入的快照的路径
  const markerPath = join(containerDir, 'pending-snapshot-import')
  await writeFile(markerPath, targetPath, 'utf-8')
  logDebug(`已创建待导入标记: ${markerPath}`)

  return {
    format: 'snapshot',
    stdout: `已将快照恢复到 ${targetPath}。下次启动时将自动导入该快照。`,
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
    throw new Error(`未找到备份文件: ${backupPath}`)
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
 * 解析 Meilisearch 连接字符串
 * 格式: http://host[:port]、https://host[:port] 或 meilisearch://host[:port]
 *
 * meilisearch:// 协议是 http:// 的别名
 * Meilisearch 使用 indexes 而非传统数据库
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 Meilisearch 连接字符串: 期望一个非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 Meilisearch 连接字符串: "${connectionString}"。` +
        `期望格式: http://host[:port] 或 meilisearch://host[:port]`,
      { cause: error },
    )
  }

  // 校验协议（meilisearch:// 是 http:// 的别名）
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:' || url.protocol === 'meilisearch:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `无效的 Meilisearch 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "http://"、"https://" 或 "meilisearch://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 7700

  return {
    host,
    port,
    protocol,
  }
}