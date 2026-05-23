/**
 * TypeDB 备份模块
 *
 * TypeDB 将数据库导出为两个文件：schema（.typeql）和数据（.typeql）。
 * 我们使用控制台的 `database export` 命令来创建这两个文件。
 */

import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { stat } from 'fs/promises'
import { dirname } from 'path'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { requireTypeDBConsolePath, getConsoleBaseArgs } from './cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

/**
 * 使用 typedb 控制台导出功能创建 TypeQL 备份
 *
 * TypeDB 导出会根据 outputPath 创建两个文件：
 * - {base}-schema.typeql（schema 定义）
 * - {base}-data.typeql（数据插入语句）
 *
 * 返回的 BackupResult.path 是原始 outputPath（基础路径），
 * 而非单个备份文件。调用方（如 restore）必须使用相同的
 * `-schema.typeql` / `-data.typeql` 命名约定来推导实际文件路径。
 * 另请参阅：restore.ts 中的 restoreTypeQLBackup()，其推导逻辑与此对称。
 */
async function createTypeQLBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const consolePath = await requireTypeDBConsolePath(container.version)
  const { port } = container

  // 确保输出目录存在
  await mkdir(dirname(outputPath), { recursive: true })

  // 从输出路径推导 schema 和 data 文件路径
  const schemaPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-schema.typeql')
    : outputPath + '-schema.typeql'
  const dataPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-data.typeql')
    : outputPath + '-data.typeql'
  const savedCreds = await loadCredentials(
    container.name,
    Engine.TypeDB,
    getDefaultUsername(Engine.TypeDB),
  )

  const args = [
    ...getConsoleBaseArgs(
      port,
      '127.0.0.1',
      true,
      savedCreds
        ? {
            username: savedCreds.username,
            password: savedCreds.password,
          }
        : undefined,
    ),
    '--command',
    `database export ${database} ${schemaPath} ${dataPath}`,
  ]

  const sanitizedArgs = args.map((a, i) =>
    args[i - 1] === '--password' ? '***' : a,
  )
  logDebug(`Running: typedb_console_bin ${sanitizedArgs.join(' ')}`)

  return new Promise<BackupResult>((resolve, reject) => {
    const proc = spawn(consolePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          // 计算两个文件（schema + data）的总大小
          let schemaSize: number | null = null
          let dataSize: number | null = null
          const errors: string[] = []
          try {
            const schemaStats = await stat(schemaPath)
            schemaSize = schemaStats.size
          } catch (err) {
            errors.push(`schema(${schemaPath}): ${err}`)
          }
          try {
            const dataStats = await stat(dataPath)
            dataSize = dataStats.size
          } catch (err) {
            errors.push(`data(${dataPath}): ${err}`)
          }

          if (
            errors.length > 0 ||
            schemaSize === null ||
            dataSize === null ||
            schemaSize === 0 ||
            dataSize === 0
          ) {
            reject(
              new Error(
                `备份产生空文件或缺失文件: schema=${schemaPath}, data=${dataPath}` +
                  (errors.length > 0
                    ? `。stat 错误: ${errors.join('; ')}`
                    : ''),
              ),
            )
            return
          }

          // path 为基础 outputPath；实际文件为 schemaPath 和 dataPath
          resolve({
            path: outputPath,
            format: 'typeql',
            size: schemaSize + dataSize,
          })
        } catch (error) {
          reject(new Error(`备份文件未创建: ${error}`))
        }
      } else if (code === null) {
        const detail = stderr || stdout
        reject(
          new Error(
            `typedb 控制台导出被信号终止${detail ? `: ${detail}` : ''}`,
          ),
        )
      } else {
        const detail = stderr || stdout
        reject(
          new Error(
            `typedb 控制台导出退出，返回码 ${code}${detail ? `: ${detail}` : ''}`,
          ),
        )
      }
    })
  })
}

/**
 * 创建备份
 *
 * @param container - 容器配置
 * @param outputPath - 备份文件写入路径
 * @param options - 备份选项
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database

  return createTypeQLBackup(container, outputPath, database)
}

/**
 * 为克隆目的创建备份
 * 使用 TypeQL 格式以确保可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createTypeQLBackup(container, outputPath, container.database)
}
