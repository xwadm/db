/**
 * 核心备份与恢复功能
 *
 * 此模块提供共享的备份/恢复逻辑，供以下模块使用：
 * - CLI 命令（backup.ts、restore.ts）
 * - 交互式菜单处理程序（backup-handlers.ts）
 *
 * 通过集中管理这些逻辑，避免重复并确保一致性。
 */

import chalk from 'chalk'
import { existsSync, statSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { containerManager } from './container-manager'
import { getMissingDependencies } from './dependency-manager'
import { platformService } from './platform-service'
import { getEngine } from '../engines'
import { createSpinner } from '../cli/ui/spinner'
import { uiSuccess, uiError, formatBytes } from '../cli/ui/theme'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  LARGE_BACKUP_THRESHOLD,
  VERY_LARGE_BACKUP_THRESHOLD,
} from '../config/backup-formats'
import type { ContainerConfig, BackupFormatType } from '../types'

// 为备份文件名生成时间戳字符串
export function generateBackupTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

// 生成默认的备份文件名
export function generateBackupFilename(
  containerName: string,
  databaseName: string,
): string {
  const timestamp = generateBackupTimestamp()
  return `${containerName}-${databaseName}-backup-${timestamp}`
}

/**
 * 检查引擎所需的工具是否已安装
 * @returns 返回缺失的依赖项数组，如果全部可用则返回空数组
 */
export async function checkBackupDependencies(
  engine: string,
): Promise<{ name: string; binary: string }[]> {
  return getMissingDependencies(engine)
}

// 估算要备份的数据库的大小
export async function estimateBackupSize(
  config: ContainerConfig,
): Promise<number | null> {
  try {
    const engine = getEngine(config.engine)
    return await engine.getDatabaseSize(config)
  } catch {
    return null
  }
}

// 执行备份操作的选项
export type BackupOptions = {
  containerName: string
  databaseName: string
  format: BackupFormatType
  outputDir: string
  filename: string
  // 是否显示加载动画和控制台输出
  interactive?: boolean
  // 用于进度更新的回调函数
  onProgress?: (message: string) => void
}

// 备份操作的结果
export type BackupResult = {
  success: boolean
  path?: string
  size?: number
  format?: string
  error?: string
}

// 执行备份操作
export async function performBackup(
  options: BackupOptions,
): Promise<BackupResult> {
  const {
    containerName,
    databaseName,
    format,
    outputDir,
    filename,
    interactive = true,
    onProgress,
  } = options

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    return { success: false, error: `容器 "${containerName}" 未找到` }
  }

  const engine = getEngine(config.engine)
  const extension = getBackupExtension(config.engine, format)
  const outputPath = join(outputDir, `${filename}${extension}`)

  // 确保输出目录存在
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const spinnerLabel = getBackupSpinnerLabel(config.engine, format)
  const spinner = interactive
    ? createSpinner(`正在创建 ${databaseName} 的 ${spinnerLabel} 备份...`)
    : null

  spinner?.start()
  onProgress?.(`正在创建 ${spinnerLabel} 备份...`)

  try {
    const result = await engine.backup(config, outputPath, {
      database: databaseName,
      format,
    })

    spinner?.succeed('备份创建成功')

    if (interactive) {
      console.log()
      console.log(uiSuccess('备份完成'))
      console.log()
      console.log(chalk.gray('  保存至：'), chalk.cyan(result.path))
      console.log(chalk.gray('  大小：'), chalk.white(formatBytes(result.size)))
      console.log(chalk.gray('  格式：'), chalk.white(result.format))
      console.log()
    }

    return {
      success: true,
      path: result.path,
      size: result.size,
      format: result.format,
    }
  } catch (error) {
    const e = error as Error
    spinner?.fail('备份失败')

    if (interactive) {
      console.log()
      console.log(uiError(e.message))
      console.log()
    }

    return { success: false, error: e.message }
  }
}

// 执行恢复操作的选项
export type RestoreOptions = {
  containerName: string
  databaseName: string
  backupPath: string
  // 如果数据库不存在则创建新数据库
  createDatabase?: boolean
  // 强制覆盖现有数据库
  force?: boolean
  // 是否显示加载动画和控制台输出
  interactive?: boolean
  // 用于进度更新的回调函数
  onProgress?: (message: string) => void
}

// 恢复操作的结果
export type RestoreResult = {
  success: boolean
  databaseName?: string
  connectionString?: string
  warnings?: string[]
  error?: string
}

// 检查备份文件大小并返回警告级别
export function checkBackupSize(backupPath: string): {
  size: number
  level: 'normal' | 'large' | 'very_large'
} {
  try {
    const stats = statSync(backupPath)
    const size = stats.size

    if (size >= VERY_LARGE_BACKUP_THRESHOLD) {
      return { size, level: 'very_large' }
    }
    if (size >= LARGE_BACKUP_THRESHOLD) {
      return { size, level: 'large' }
    }
    return { size, level: 'normal' }
  } catch {
    return { size: 0, level: 'normal' }
  }
}

// 执行恢复操作
export async function performRestore(
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    containerName,
    databaseName,
    backupPath,
    createDatabase = true,
    interactive = true,
    onProgress,
  } = options

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    return { success: false, error: `容器 "${containerName}" 未找到` }
  }

  const engine = getEngine(config.engine)

  // 如果需要则创建数据库
  if (createDatabase) {
    const existingDbs = config.databases || [config.database]
    if (!existingDbs.includes(databaseName)) {
      const spinner = interactive
        ? createSpinner(`正在创建数据库 "${databaseName}"...`)
        : null
      spinner?.start()
      onProgress?.(`正在创建数据库 "${databaseName}"...`)

      try {
        await engine.createDatabase(config, databaseName)
        spinner?.succeed(`数据库 "${databaseName}" 已创建`)

        // 更新容器配置
        await containerManager.updateConfig(containerName, {
          databases: [...existingDbs, databaseName],
        })
      } catch (error) {
        const e = error as Error
        spinner?.fail('数据库创建失败')
        return { success: false, error: e.message }
      }
    }
  }

  // 执行恢复
  const spinner = interactive
    ? createSpinner(`正在还原到 "${databaseName}"...`)
    : null
  spinner?.start()
  onProgress?.(`正在还原到 "${databaseName}"...`)

  try {
    const result = await engine.restore(config, backupPath, {
      database: databaseName,
    })

    const warnings: string[] = []

    if (result.code === 0) {
      spinner?.succeed('还原成功完成')
    } else {
      spinner?.warn('还原已完成，但存在警告')
      if (result.stderr) {
        const lines = result.stderr.split('\n').filter((l) => l.trim())
        warnings.push(...lines.slice(0, 10))
      }
    }

    const connectionString = engine.getConnectionString(config, databaseName)

    if (interactive) {
      console.log()
      console.log(uiSuccess(`数据库 "${databaseName}" 已还原`))
      console.log(chalk.gray('  连接字符串：'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ 连接字符串已复制到剪贴板'))
      }
      console.log()

      if (warnings.length > 0) {
        console.log(chalk.yellow('  警告：'))
        for (const warning of warnings) {
          console.log(chalk.gray(`  ${warning}`))
        }
        console.log()
      }
    }

    return {
      success: true,
      databaseName,
      connectionString,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  } catch (error) {
    const e = error as Error
    spinner?.fail('还原失败')

    if (interactive) {
      console.log()
      console.log(uiError(e.message))
      console.log()
    }

    return { success: false, error: e.message }
  }
}

/**
 * 获取容器的默认/主数据库
 * 如果只有一个数据库，则返回它；否则返回 null
 */
export function getDefaultDatabase(config: ContainerConfig): string | null {
  const databases = config.databases || [config.database]
  if (databases.length === 1) {
    return databases[0]
  }
  return null
}
