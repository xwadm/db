/**
 * TigerBeetle 恢复模块
 * 支持从停机复制备份恢复。
 *
 * TigerBeetle 将所有数据存储在单个文件中（例如 0_0.tigerbeetle）。
 * 恢复需要先停止服务器，然后替换数据文件。
 */

import { copyFile, mkdir } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * 从文件内容检测备份格式。
 * TigerBeetle 备份是原始二进制数据文件。
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`未找到备份文件：${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: 'TigerBeetle 恢复需要单个数据文件，不支持目录',
      restoreCommand: '将备份文件复制到数据目录',
    }
  }

  // TigerBeetle 数据文件很大（约 1GB），包含二进制数据
  // 通过检查文件大小来识别（应该 > 100MB）
  if (stats.size > 100 * 1024 * 1024) {
    return {
      format: 'binary',
      description: 'TigerBeetle 二进制数据文件',
      restoreCommand: '将备份文件复制到数据目录',
    }
  }

  // 未知格式 - 可能是损坏或不完整的备份
  return {
    format: 'unknown',
    description: `TigerBeetle 备份文件通常 >100MB（当前：${Math.round(stats.size / 1024 / 1024)}MB）`,
    restoreCommand: '将备份文件复制到数据目录',
  }
}

export type RestoreOptions = {
  containerName: string
  dataDir: string
}

/**
 * 从备份恢复 TigerBeetle 数据文件。
 * 调用此函数前必须先停止服务器。
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { dataDir } = options
  const dataFile = join(dataDir, '0_0.tigerbeetle')

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式：${format.format}`)

  if (format.format !== 'binary') {
    throw new Error(
      `无效的备份格式：${format.format}。TigerBeetle 需要二进制数据文件。`,
    )
  }

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  // 如果存在现有数据文件，先删除
  if (existsSync(dataFile)) {
    logDebug(`正在移除现有数据文件：${dataFile}`)
    // 使用 Node 的 fs 模块删除文件
    const { unlink } = await import('fs/promises')
    await unlink(dataFile)
  }

  // 复制备份文件
  logDebug(`正在将备份复制到 ${dataFile}`)
  await copyFile(backupPath, dataFile)

  return {
    format: 'binary',
    stdout: `TigerBeetle 数据文件已恢复到 ${dataFile}`,
    code: 0,
  }
}
