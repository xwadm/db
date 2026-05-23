import { Command } from 'commander'
import { join } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import {
  promptContainerSelect,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptInstallDependencies,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning, formatBytes } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import { isFileBasedEngine, isRemoteContainer } from '../../types'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  getDefaultFormat,
  isValidFormat,
  getValidFormats,
} from '../../config/backup-formats'
import type { BackupFormatType } from '../../types'

// 生成时间戳，用于默认备份文件名
function generateTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

// 生成默认备份文件名
function generateDefaultFilename(
  containerName: string,
  database: string,
): string {
  const timestamp = generateTimestamp()
  return `${containerName}-${database}-backup-${timestamp}`
}

export const backupCommand = new Command('backup')
  .description('创建数据库备份')
  .argument('[container]', '容器名称')
  .option('-d, --database <name>', '要备份的数据库')
  .option('-n, --name <name>', '自定义备份文件名（不含扩展名）')
  .option('-o, --output <path>', '输出目录（默认为当前目录）')
  .option(
    '--format <format>',
    '备份格式（与引擎相关，如 sql、custom、rdb、binary）',
  )
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      containerArg: string | undefined,
      options: {
        database?: string
        name?: string
        output?: string
        format?: string
        json?: boolean
      },
    ) => {
      try {
        let containerName = containerArg

        // 未提供容器名称时的交互式选择
        if (!containerName) {
          // JSON 模式要求必须提供容器名称参数
          if (options.json) {
            console.log(JSON.stringify({ error: '容器名是必需的' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning('未找到容器，请使用以下命令创建：spindb create'),
              )
            } else {
              console.log(
                uiWarning(
                  '没有正在运行的容器，请先使用以下命令启动：spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            running,
            '选择要备份的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        // 获取容器配置
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `容器 "${containerName}" 未找到`,
              }),
            )
          } else {
            console.error(uiError(`容器 "${containerName}" 未找到`))
          }
          process.exit(1)
        }

        const { engine: engineName } = config

        // 远程链接容器暂不支持备份（引擎方法连接的是 127.0.0.1）
        if (isRemoteContainer(config)) {
          const errorMsg =
            '暂不支持对已链接的远程容器进行备份，请使用数据库服务商提供的备份工具。'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 基于文件的引擎无需检查运行状态
        if (!isFileBasedEngine(engineName)) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            const errorMsg = `容器 "${containerName}" 未运行，请先启动。`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const engine = getEngine(engineName)

        // 检查所需工具
        const depsSpinner = createSpinner('正在检查必需工具...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(config.engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `缺少工具：${missingDeps.map((d) => d.name).join(', ')}`,
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            config.engine,
          )

          if (!installed) {
            process.exit(1)
          }

          missingDeps = await getMissingDependencies(config.engine)
          if (missingDeps.length > 0) {
            console.error(
              uiError(
                `仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ 所有必需工具现已可用'))
          console.log()
        } else {
          depsSpinner.succeed('必需工具可用')
        }

        let databaseName = options.database

        // 选择要备份的数据库
        if (!databaseName) {
          const databases = config.databases || [config.database]

          if (databases.length > 1) {
            databaseName = await promptDatabaseSelect(
              databases,
              '选择要备份的数据库：',
            )
          } else {
            databaseName = databases[0]
          }
        }

        // 确定备份格式
        let format: BackupFormatType = getDefaultFormat(engineName)

        if (options.format) {
          if (!isValidFormat(engineName, options.format)) {
            const validFormats = getValidFormats(engineName)
            const errorMsg = `无效的格式 "${options.format}"，引擎 ${engineName} 支持的有效格式：${validFormats.join(', ')}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
          // 安全转换：isValidFormat 已保证格式有效
          format = options.format as BackupFormatType
        } else if (!containerArg) {
          const selectedFormat = await promptBackupFormat(engineName)
          if (selectedFormat) {
            format = selectedFormat
          }
        }

        const defaultFilename = generateDefaultFilename(
          containerName,
          databaseName,
        )
        let filename = options.name || defaultFilename

        if (!containerArg && !options.name) {
          filename = await promptBackupFilename(defaultFilename)
        }

        const extension = getBackupExtension(engineName, format)
        const outputDir = options.output || process.cwd()
        const outputPath = join(outputDir, `${filename}${extension}`)

        const spinnerLabel = getBackupSpinnerLabel(engineName, format)
        const backupSpinner = createSpinner(
          `正在创建 ${databaseName} 的 ${spinnerLabel} 备份...`,
        )
        backupSpinner.start()

        const result = await engine.backup(config, outputPath, {
          database: databaseName,
          format,
        })

        backupSpinner.succeed('备份创建成功')

        // 输出备份结果
        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              path: result.path,
              size: result.size,
              format: result.format,
              database: databaseName,
              container: containerName,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess('备份完成'))
          console.log()
          console.log(chalk.gray('  保存至：'), chalk.cyan(result.path))
          console.log(
            chalk.gray('  大小：'),
            chalk.white(formatBytes(result.size)),
          )
          console.log(chalk.gray('  格式：'), chalk.white(result.format))
          console.log()
        }
      } catch (error) {
        const e = error as Error

        // 匹配常见的工具缺失提示，触发自动安装
        const missingToolPatterns = ['pg_dump not found', 'mysqldump not found']

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.includes(p),
        )

        if (matchingPattern) {
          if (options.json) {
            console.log(JSON.stringify({ error: e.message }))
            process.exit(1)
          }
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(chalk.yellow('  请重新运行你的命令以继续。'))
          }
          process.exit(1)
        }

        // 其他错误：保留原始错误消息（可能来自底层库）
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
