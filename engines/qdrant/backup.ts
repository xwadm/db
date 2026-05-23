/**
 * Qdrant 备份模块
 * 支持通过 Qdrant REST API 进行基于快照的备份
 */

import { mkdir, stat, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { qdrantApiRequest } from './api-client'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

// 备份操作耗时较长，使用更长的超时时间
const BACKUP_TIMEOUT_MS = 600000 // 10 分钟

/**
 * 通过 Qdrant REST API 创建快照备份
 * 这会创建整个 Qdrant 实例的完整快照
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container
  const savedCreds = await loadCredentials(
    name,
    Engine.Qdrant,
    getDefaultUsername(Engine.Qdrant),
  )
  const apiKey = savedCreds?.apiKey

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 通过 REST API 触发快照创建
  logDebug(`通过 REST API 在端口 ${port} 上创建 Qdrant 快照`)

  const response = await qdrantApiRequest(
    port,
    'POST',
    '/snapshots',
    undefined,
    BACKUP_TIMEOUT_MS,
    apiKey,
  )

  if (response.status !== 200) {
    throw new Error(
      `创建 Qdrant 快照失败: ${JSON.stringify(response.data)}`,
    )
  }

  const snapshotData = response.data as { result?: { name?: string } }
  const snapshotName = snapshotData?.result?.name

  if (!snapshotName) {
    throw new Error(
      `Qdrant 快照创建失败: 未返回快照名称`,
    )
  }

  logDebug(`Qdrant 快照已创建: ${snapshotName}`)

  // 快照存储在数据目录的 snapshots 子目录中
  const dataDir = paths.getContainerDataPath(name, { engine: 'qdrant' })
  const snapshotsDir = join(dataDir, 'snapshots')
  const snapshotPath = join(snapshotsDir, snapshotName)

  // 等待快照文件就绪并完全写入
  // Qdrant 异步写入快照，因此需要等待两个条件同时满足：
  // 1. 文件存在
  // 2. 文件大小稳定（不再增长）
  const maxWait = 60000 // 60 秒
  const startTime = Date.now()
  let lastSize = -1

  while (Date.now() - startTime < maxWait) {
    if (existsSync(snapshotPath)) {
      try {
        const currentStats = await stat(snapshotPath)
        if (currentStats.size > 0 && currentStats.size === lastSize) {
          // 大小不再变化，文件很可能已写入完成
          break
        }
        lastSize = currentStats.size
      } catch {
        // 文件可能在 existsSync 和 stat 之间被删除或不可访问
        // 重置 lastSize 并继续轮询
        lastSize = -1
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!existsSync(snapshotPath)) {
    throw new Error(
      `Qdrant 快照文件在超时后未找到，路径: ${snapshotPath}`,
    )
  }

  // 将快照复制到输出路径
  await copyFile(snapshotPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'snapshot',
    size: stats.size,
  }
}

/**
 * 为克隆目的创建备份
 * 使用快照格式以进行可靠的数据传输
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, { database: 'default' })
}

/**
 * 列出容器中可用的快照
 */
export async function listSnapshots(container: ContainerConfig): Promise<
  Array<{
    name: string
    createdAt: string
    size: number
  }>
> {
  const { name } = container
  const dataDir = paths.getContainerDataPath(name, { engine: 'qdrant' })
  const snapshotsDir = join(dataDir, 'snapshots')

  if (!existsSync(snapshotsDir)) {
    return []
  }

  const files = await readdir(snapshotsDir)
  const snapshotFiles = files.filter((file) => file.endsWith('.snapshot'))

  // 并行获取所有快照文件的统计信息以提升性能
  // 过滤掉获取信息失败的文件（例如在遍历过程中被删除）
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