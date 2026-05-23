/**
 * Weaviate 备份模块
 * 支持使用 Weaviate 文件系统备份 API 进行快照备份。
 *
 * Weaviate 的文件系统备份会在 BACKUP_FILESYSTEM_PATH/<id>/ 下创建目录，
 * 其中包含备份元数据和类数据。我们将整个目录复制出来
 * 作为备份/恢复的"快照"。
 */

import { mkdir, stat, cp, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { weaviateApiRequest } from './api-client'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

/**
 * 使用 Weaviate REST API 创建快照备份。
 * 触发文件系统备份，轮询等待完成，然后将备份目录复制到输出路径。
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container
  const savedCreds = await loadCredentials(
    name,
    Engine.Weaviate,
    getDefaultUsername(Engine.Weaviate),
  )
  const apiKey = savedCreds?.apiKey

  // 确保输出的父目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 生成唯一备份 ID
  const backupId = `spindb-backup-${Date.now()}`

  // 通过 REST API 触发备份创建
  logDebug(
    `正在通过 REST API 在端口 ${port} 上创建 Weaviate 备份 '${backupId}'`,
  )

  const response = await weaviateApiRequest(
    port,
    'POST',
    '/v1/backups/filesystem',
    { id: backupId },
    600000, // 10 分钟超时
    apiKey,
  )

  if (response.status !== 200) {
    throw new Error(
      `创建 Weaviate 备份失败：${JSON.stringify(response.data)}`,
    )
  }

  logDebug(`Weaviate 备份已启动：${backupId}`)

  // 轮询等待备份完成
  const maxWait = 300000 // 5 分钟
  const startTime = Date.now()

  let backupCompleted = false

  while (Date.now() - startTime < maxWait) {
    const statusResponse = await weaviateApiRequest(
      port,
      'GET',
      `/v1/backups/filesystem/${backupId}`,
      undefined,
      30000,
      apiKey,
    )

    if (statusResponse.status === 200) {
      const statusData = statusResponse.data as {
        status?: string
        path?: string
      }

      if (statusData.status === 'SUCCESS') {
        logDebug(`Weaviate 备份已完成：${backupId}`)
        backupCompleted = true
        break
      }

      if (statusData.status === 'FAILED') {
        throw new Error(`Weaviate 备份失败：${JSON.stringify(statusData)}`)
      }

      logDebug(`备份状态：${statusData.status}，等待中...`)
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  if (!backupCompleted) {
    throw new Error(
      `Weaviate 备份 '${backupId}' 在 ${maxWait / 1000} 秒后超时未完成`,
    )
  }

  // Weaviate 将备份存储在 BACKUP_FILESYSTEM_PATH/<backupId>/
  // BACKUP_FILESYSTEM_PATH 在 start() 中设置为 <dataDir>/backups
  const dataDir = paths.getContainerDataPath(name, { engine: 'weaviate' })
  const backupDir = join(dataDir, 'backups', backupId)

  if (!existsSync(backupDir)) {
    throw new Error(
      `Weaviate 备份目录未找到，路径：${backupDir}（备份已完成但目录不存在）`,
    )
  }

  // 将整个备份目录复制到输出路径
  await cp(backupDir, outputPath, { recursive: true })

  // 获取备份目录总大小
  const files = await readdir(backupDir, { recursive: true })
  let totalSize = 0
  for (const file of files) {
    try {
      const filePath = join(backupDir, String(file))
      const stats = await stat(filePath)
      if (stats.isFile()) {
        totalSize += stats.size
      }
    } catch {
      // 跳过无法访问的文件
    }
  }

  return {
    path: outputPath,
    format: 'snapshot',
    size: totalSize,
  }
}

/**
 * 为克隆目的创建备份
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, { database: 'default' })
}