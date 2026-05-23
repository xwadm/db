/**
 * TigerBeetle 备份模块
 * 支持对单个数据文件进行停机复制备份。
 *
 * TigerBeetle 将所有数据存储在单个文件中（例如 0_0.tigerbeetle）。
 * 备份需要先停止服务器，因为运行中的进程会独占锁定数据文件。
 */

import { copyFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { logDebug } from '../../core/error-handler'
import type { BackupOptions, BackupResult } from '../../types'

/**
 * 通过复制 TigerBeetle 数据文件创建备份。
 * 调用此函数前必须先停止服务器。
 */
export async function createBackup(
  dataDir: string,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const dataFile = join(dataDir, '0_0.tigerbeetle')

  if (!existsSync(dataFile)) {
    throw new Error(
      `在 ${dataFile} 未找到 TigerBeetle 数据文件。数据库是否已初始化？`,
    )
  }

  // 确保输出父目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  logDebug(`正在复制 TigerBeetle 数据文件到 ${outputPath}`)
  await copyFile(dataFile, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'binary',
    size: stats.size,
  }
}
