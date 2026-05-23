/**
 * Weaviate 恢复模块
 * 支持使用 Weaviate 文件系统备份 API 进行快照恢复。
 *
 * 恢复流程：
 * 1. 将备份目录复制到目标容器的 BACKUP_FILESYSTEM_PATH/<id>/
 * 2. 启动 Weaviate（由调用方处理）
 * 3. 通过 POST /v1/backups/filesystem/<id>/restore 触发恢复
 */

import { cp, copyFile, open, mkdir, readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * 从文件或目录检测备份格式。
 * Weaviate 备份是包含备份元数据和类数据的目录。
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到：${filePath}`)
  }

  const stats = statSync(filePath)

  // Weaviate 文件系统备份是目录
  if (stats.isDirectory()) {
    // 检查是否包含 backup_config.json（Weaviate 备份标记）
    const configPath = join(filePath, 'backup_config.json')
    if (existsSync(configPath)) {
      return {
        format: 'snapshot',
        description: 'Weaviate 文件系统备份目录',
        restoreCommand:
          '复制到 backups 目录并使用 Weaviate 恢复 API（spindb restore 会自动处理）',
      }
    }

    return {
      format: 'snapshot',
      description: 'Weaviate 备份目录',
      restoreCommand:
        '复制到 backups 目录并使用 Weaviate 恢复 API（spindb restore 会自动处理）',
    }
  }

  // 检查文件扩展名是否为 .snapshot
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Weaviate 快照文件',
      restoreCommand:
        '复制到 backups 目录并使用 Weaviate API（spindb restore 会自动处理）',
    }
  }

  // 检查文件内容是否有 gzip 魔数（快照文件是压缩的）
  try {
    const buffer = Buffer.alloc(4)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 4, 0)
      // Gzip 魔数字节：1f 8b
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return {
          format: 'snapshot',
          description: 'Weaviate 快照文件（通过魔数检测）',
          restoreCommand:
            '复制到 backups 目录并使用 Weaviate API（spindb restore 会自动处理）',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头出错：${error}`)
  }

  // 检查是否为 JSON 备份元数据
  if (filePath.endsWith('.json')) {
    return {
      format: 'snapshot',
      description: 'Weaviate 备份元数据文件',
      restoreCommand: '使用 Weaviate 恢复 API（spindb restore 会自动处理）',
    }
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用 Weaviate 备份目录进行恢复',
  }
}

// Weaviate 恢复选项
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * 从快照备份恢复。
 *
 * 将备份目录复制到目标容器的 backups 路径中。
 * 调用方随后必须启动 Weaviate 并通过 API 触发恢复。
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, dataDir } = options

  if (!existsSync(backupPath)) {
    throw new Error(`备份未找到：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式：${format.format}`)

  if (format.format !== 'snapshot') {
    throw new Error(
      `无效的备份格式：${format.format}。请使用 Weaviate 备份目录进行恢复。`,
    )
  }

  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'weaviate' })
  const backupsDir = join(targetDir, 'backups')

  // 从备份目录内的 backup_config.json 读取真实的备份 ID。
  // Weaviate 会验证目录名称是否与内部备份 ID 匹配。
  let backupId = basename(backupPath)
  const stats = statSync(backupPath)
  if (stats.isDirectory()) {
    const configPath = join(backupPath, 'backup_config.json')
    if (existsSync(configPath)) {
      try {
        const configData = JSON.parse(await readFile(configPath, 'utf-8')) as {
          id?: string
        }
        if (configData.id) {
          backupId = configData.id
          logDebug(`从配置中读取备份 ID：${backupId}`)
        }
      } catch (error) {
        logDebug(`读取 backup_config.json 失败：${error}`)
      }
    }
  }

  const targetPath = join(backupsDir, backupId)

  logDebug(`正在恢复到：${targetPath}`)

  // 确保 backups 目录存在
  if (!existsSync(backupsDir)) {
    await mkdir(backupsDir, { recursive: true })
  }

  if (stats.isDirectory()) {
    // 复制整个备份目录
    await cp(backupPath, targetPath, { recursive: true })
  } else {
    // 单文件 — 创建目录并将文件复制进去
    if (!existsSync(targetPath)) {
      await mkdir(targetPath, { recursive: true })
    }
    await copyFile(backupPath, join(targetPath, basename(backupPath)))
  }

  return {
    format: 'snapshot',
    stdout:
      `已将备份恢复到 ${targetPath}。\n` +
      `启动 Weaviate 后，通过以下方式恢复：POST /v1/backups/filesystem/${backupId}/restore`,
    code: 0,
  }
}

/**
 * 解析 Weaviate 连接字符串
 * 格式：http://host[:port]、https://host[:port]
 *
 * Weaviate 使用类/集合（classes/collections）而非传统数据库
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 Weaviate 连接字符串：期望一个非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 Weaviate 连接字符串："${connectionString}"。` +
        `期望格式：http://host[:port]`,
      { cause: error },
    )
  }

  // 验证协议
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `无效的 Weaviate 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望 "http://" 或 "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 8080

  return {
    host,
    port,
    protocol,
  }
}