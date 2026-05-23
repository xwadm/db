/**
 * Meilisearch 备份模块
 * 支持通过 Meilisearch 的 REST API 创建基于快照的备份
 */

import { mkdir, stat, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { meilisearchApiRequest } from './api-client'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

// 备份操作可能超过默认超时时间
const BACKUP_TIMEOUT_MS = 600000 // 10 分钟

/**
 * 通过 Meilisearch REST API 创建快照备份
 * 这将创建整个 Meilisearch 实例的完整快照
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container
  const savedCreds = await loadCredentials(
    name,
    Engine.Meilisearch,
    getDefaultUsername(Engine.Meilisearch),
  )
  const apiKey = savedCreds?.apiKey

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 通过 REST API 触发快照创建
  logDebug(`通过 REST API 在端口 ${port} 创建 Meilisearch 快照`)

  const response = await meilisearchApiRequest(
    port,
    'POST',
    '/snapshots',
    undefined,
    BACKUP_TIMEOUT_MS,
    apiKey,
  )

  // Meilisearch 对快照创建返回 202 Accepted
  if (response.status !== 202 && response.status !== 200) {
    throw new Error(
      `无法创建 Meilisearch 快照: ${JSON.stringify(response.data)}`,
    )
  }

  // Meilisearch 异步创建快照并返回一个任务
  // 需要等待任务完成
  const taskData = response.data as { taskUid?: number }
  const taskUid = taskData?.taskUid

  if (taskUid !== undefined) {
    logDebug(`Meilisearch 快照任务已创建: ${taskUid}`)
    // 等待任务完成
    await waitForTask(port, taskUid, BACKUP_TIMEOUT_MS, apiKey)
  }

  // 快照存储在 snapshots 文件夹中（与 data 平级，不在 data 内部）
  // 重要：若 --snapshot-dir 位于 --db-path 内部，Meilisearch 会失败
  const containerDir = paths.getContainerPath(name, { engine: 'meilisearch' })
  const snapshotsDir = join(containerDir, 'snapshots')

  // 等待快照文件出现
  const maxWait = 60000 // 60 秒
  const startTime = Date.now()
  let snapshotPath: string | null = null

  while (Date.now() - startTime < maxWait) {
    if (existsSync(snapshotsDir)) {
      const files = await readdir(snapshotsDir)
      const snapshotFiles = files.filter((f) => f.endsWith('.snapshot'))
      if (snapshotFiles.length > 0) {
        // 按修改时间获取最新快照（而非按字典序排序）
        let newestFile: string | null = null
        let newestMtime = 0
        for (const file of snapshotFiles) {
          const filePath = join(snapshotsDir, file)
          try {
            const fileStat = await stat(filePath)
            if (fileStat.mtimeMs > newestMtime) {
              newestMtime = fileStat.mtimeMs
              newestFile = file
            }
          } catch {
            // 跳过无法获取 stat 的文件（可能在迭代期间被删除）
          }
        }
        if (newestFile) {
          snapshotPath = join(snapshotsDir, newestFile)
          break
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!snapshotPath || !existsSync(snapshotPath)) {
    throw new Error(
      `在超时后未在 ${snapshotsDir} 中找到 Meilisearch 快照文件`,
    )
  }

  // 等待文件完全写入（体积稳定）
  let lastSize = -1
  let stabilized = false
  const writeWaitStart = Date.now()
  while (Date.now() - writeWaitStart < 30000) {
    const currentStats = await stat(snapshotPath)
    if (currentStats.size > 0 && currentStats.size === lastSize) {
      stabilized = true
      break
    }
    lastSize = currentStats.size
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!stabilized) {
    throw new Error(
      `Meilisearch 快照在 30 秒内未稳定。` +
        `文件可能仍在写入中: ${snapshotPath}`,
    )
  }

  // 将快照拷贝到输出路径
  await copyFile(snapshotPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'snapshot',
    size: stats.size,
  }
}

/**
 * 等待 Meilisearch 任务完成
 */
async function waitForTask(
  port: number,
  taskUid: number,
  timeoutMs: number,
  apiKey?: string,
): Promise<void> {
  const startTime = Date.now()
  const checkInterval = 500

  while (Date.now() - startTime < timeoutMs) {
    const response = await meilisearchApiRequest(
      port,
      'GET',
      `/tasks/${taskUid}`,
      undefined,
      30000,
      apiKey,
    )

    if (response.status === 200) {
      const task = response.data as { status?: string }
      if (task.status === 'succeeded') {
        logDebug(`Meilisearch 任务 ${taskUid} 已成功`)
        return
      }
      if (task.status === 'failed') {
        throw new Error(
          `Meilisearch 任务 ${taskUid} 失败: ${JSON.stringify(task)}`,
        )
      }
    }

    await new Promise((r) => setTimeout(r, checkInterval))
  }

  throw new Error(`Meilisearch 任务 ${taskUid} 在超时内未完成`)
}

/**
 * 为克隆目的创建备份
 * 使用快照格式以确保数据传输的可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, { database: 'default' })
}

/**
 * 列出容器的可用快照
 */
export async function listSnapshots(container: ContainerConfig): Promise<
  Array<{
    name: string
    createdAt: string
    size: number
  }>
> {
  const { name } = container
  // 快照目录与 data 平级，不在 data 内部
  const containerDir = paths.getContainerPath(name, { engine: 'meilisearch' })
  const snapshotsDir = join(containerDir, 'snapshots')

  if (!existsSync(snapshotsDir)) {
    return []
  }

  const files = await readdir(snapshotsDir)
  const snapshotFiles = files.filter((file) => file.endsWith('.snapshot'))

  // 并行获取所有快照文件的 stat，提升性能
  // 过滤掉无法获取 stat 的文件（如迭代期间被删除）
  const statsResults = await Promise.all(
    snapshotFiles.map(async (file) => {
      const filePath = join(snapshotsDir, file)
      try {
        const stats = await stat(filePath)
        return {
          name: file,
          createdAt: stats.mtime.toISOString(),
          size: stats.size,
        }
      } catch {
        // 文件可能在 readdir 和 stat 之间被删除
        return null
      }
    }),
  )

  return statsResults.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}