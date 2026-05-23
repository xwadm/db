import { Command } from 'commander'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import {
  promptContainerSelect,
  promptDatabaseName,
  promptInstallDependencies,
  promptConfirm,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { TransactionManager } from '../../core/transaction-manager'
import { isFileBasedEngine, isRemoteContainer } from '../../types'
import { logDebug } from '../../core/error-handler'
import { getEngineMetadata } from '../helpers'

export const restoreCommand = new Command('restore')
  .description('将备份恢复到容器')
  .argument('[name]', '容器名称')
  .argument(
    '[backup]',
    '备份文件路径（使用 --from-url 时不需要）',
  )
  .option('-d, --database <name>', '目标数据库名称')
  .option(
    '--from-url <url>',
    '从远程数据库连接字符串拉取数据',
  )
  .option('-f, --force', '覆盖现有数据库而无需确认')
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      name: string | undefined,
      backup: string | undefined,
      options: {
        database?: string
        fromUrl?: string
        force?: boolean
        json?: boolean
      },
    ) => {
      let tempDumpPath: string | null = null

      try {
        let containerName = name
        let backupPath = backup

        if (!containerName) {
          // JSON 模式需要容器名称参数
          if (options.json) {
            console.log(JSON.stringify({ error: '容器名称是必需的' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  '未找到容器。请使用以下命令创建：spindb create',
                ),
              )
            } else {
              console.log(
                uiWarning(
                  '没有运行中的容器。请先启动：spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            running,
            '选择要恢复的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `未找到容器 "${containerName}"`,
              }),
            )
          } else {
            console.error(uiError(`未找到容器 "${containerName}"`))
          }
          process.exit(1)
        }

        // 阻止远程容器的恢复操作（对生产数据库有危险）
        if (isRemoteContainer(config)) {
          const errorMsg = `链接的远程容器不支持恢复操作。这是为了防止远程数据库意外数据丢失。`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const { engine: engineName } = config
        const engine = getEngine(engineName)

        // 检查容器是否需要处于运行状态才能恢复
        // - 基于文件的引擎（SQLite, DuckDB）不需要运行
        // - Redis/Valkey RDB 恢复需要容器处于停止状态（文本格式需要运行）
        // - Qdrant 快照恢复需要容器处于停止状态
        // - 所有其他引擎需要容器处于运行状态
        // 对于 Redis/Valkey，我们延迟运行检查直到格式检测之后
        const isRedisLike = engineName === 'redis' || engineName === 'valkey'
        const isQdrant = engineName === 'qdrant'

        if (isQdrant) {
          // Qdrant 快照恢复需要容器处于停止状态
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (running) {
            const errorMsg =
              `容器 "${containerName}" 必须处于停止状态才能进行 Qdrant 快照恢复。\n` +
              `请运行：spindb stop ${containerName}\n\n` +
              `注意：恢复 Qdrant 快照将替换所有现有的集合。`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        } else if (!isFileBasedEngine(engineName) && !isRedisLike) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            const errorMsg = `容器 "${containerName}" 未运行。请先启动。`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const depsSpinner = createSpinner('正在检查必需工具...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(config.engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
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
                `仍然缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ 所有必需工具现已可用'))
          console.log()
        } else {
          depsSpinner.succeed('必需工具可用')
        }

        if (options.fromUrl) {
          const isPgUrl =
            options.fromUrl.startsWith('postgresql://') ||
            options.fromUrl.startsWith('postgres://')
          const isMysqlUrl = options.fromUrl.startsWith('mysql://')

          if (engineName === 'postgresql' && !isPgUrl) {
            console.error(
              uiError(
                'PostgreSQL 容器的连接字符串必须以 postgresql:// 或 postgres:// 开头',
              ),
            )
            process.exit(1)
          }

          if (engineName === 'mysql' && !isMysqlUrl) {
            console.error(
              uiError(
                'MySQL 容器的连接字符串必须以 mysql:// 开头',
              ),
            )
            process.exit(1)
          }

          if (!isPgUrl && !isMysqlUrl) {
            console.error(
              uiError(
                '连接字符串必须以 postgresql://、postgres:// 或 mysql:// 开头',
              ),
            )
            process.exit(1)
          }

          const timestamp = Date.now()
          tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

          let dumpSuccess = false
          let attempts = 0
          const maxAttempts = 2

          while (!dumpSuccess && attempts < maxAttempts) {
            attempts++
            const dumpSpinner = createSpinner(
              '正在从远程数据库创建转储...',
            )
            dumpSpinner.start()

            try {
              const dumpResult = await engine.dumpFromConnectionString(
                options.fromUrl,
                tempDumpPath,
              )
              dumpSpinner.succeed('已从远程数据库创建转储')
              if (dumpResult.warnings?.length) {
                for (const warning of dumpResult.warnings) {
                  console.log(chalk.yellow(`  ${warning}`))
                }
              }
              backupPath = tempDumpPath
              dumpSuccess = true
            } catch (error) {
              const e = error as Error
              dumpSpinner.fail('创建转储失败')

              const dumpTool = engineName === 'mysql' ? 'mysqldump' : 'pg_dump'
              if (
                e.message.includes(`${dumpTool} not found`) ||
                e.message.includes('ENOENT')
              ) {
                const installed = await promptInstallDependencies(
                  dumpTool,
                  engineName,
                )
                if (!installed) {
                  process.exit(1)
                }
                continue
              }

              console.log()
              console.error(uiError(`${dumpTool} 错误：`))
              console.log(chalk.gray(`  ${e.message}`))
              process.exit(1)
            }
          }

          if (!dumpSuccess) {
            console.error(uiError('重试后仍无法创建转储'))
            process.exit(1)
          }
        } else {
          if (!backupPath) {
            console.error(uiError('备份文件路径是必需的'))
            console.log(
              chalk.gray('  用法：spindb restore <container> <backup-file>'),
            )
            console.log(
              chalk.gray(
                '     或：spindb restore <container> --from-url <connection-string>',
              ),
            )
            process.exit(1)
          }

          if (!existsSync(backupPath)) {
            console.error(uiError(`备份文件未找到：${backupPath}`))
            process.exit(1)
          }
        }

        let databaseName = options.database
        if (!databaseName) {
          // 基于文件的引擎（SQLite, DuckDB）没有独立的数据库
          // 文件本身就是数据库，所以使用容器名称
          if (isFileBasedEngine(engineName)) {
            databaseName = containerName
          } else {
            databaseName = await promptDatabaseName(containerName, engineName)
          }
        }

        if (!backupPath) {
          console.error(uiError('未指定备份路径'))
          process.exit(1)
        }

        const detectSpinner = createSpinner('正在检测备份格式...')
        detectSpinner.start()

        const format = await engine.detectBackupFormat(backupPath)
        detectSpinner.succeed(`检测到：${format.description}`)

        // 对于 Redis/Valkey，根据格式检查运行状态
        // - 文本格式（.redis/.valkey）需要容器处于运行状态
        // - RDB 格式需要容器处于停止状态
        if (isRedisLike) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          const isRdbFormat = format.format === 'rdb'

          if (isRdbFormat && running) {
            console.error(
              uiError(
                `容器 "${containerName}" 必须处于停止状态才能进行 RDB 恢复。请运行：spindb stop ${containerName}`,
              ),
            )
            process.exit(1)
          }

          if (!isRdbFormat && !running) {
            console.error(
              uiError(
                `容器 "${containerName}" 未运行。文本格式恢复需要先启动容器。`,
              ),
            )
            process.exit(1)
          }
        }

        // 检查数据库是否已存在
        const databaseExists =
          config.databases && config.databases.includes(databaseName)

        if (databaseExists) {
          if (!options.force) {
            // JSON 模式下直接报错 - 无交互式提示
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `数据库 "${databaseName}" 已存在。使用 --force 覆盖。`,
                }),
              )
              process.exit(1)
            }

            // 交互模式 - 提示确认
            console.log()
            console.log(
              chalk.yellow(
                `  警告：数据库 "${databaseName}" 已存在。`,
              ),
            )
            console.log(
              chalk.gray(
                '  此操作将删除并重建数据库。',
              ),
            )
            console.log()

            const confirmed = await promptConfirm(
              '您要覆盖现有数据库吗？',
              false,
            )

            if (!confirmed) {
              console.log(chalk.gray('\n  恢复已取消\n'))
              return
            }
          }

          // 删除现有数据库（跟踪条目保留 - 我们正在重建同名数据库）
          const dropSpinner = createSpinner(
            `正在删除现有数据库 "${databaseName}"...`,
          )
          dropSpinner.start()

          try {
            await engine.dropDatabase(config, databaseName)
            // 不从跟踪中移除 - 数据库名称保持不变
            // addDatabase() 是幂等的，所以跟踪保持有效
            dropSpinner.succeed(`已删除数据库 "${databaseName}"`)
          } catch (dropErr) {
            dropSpinner.fail('删除数据库失败')
            throw dropErr
          }
        }

        // 使用 TransactionManager 确保恢复失败时清理数据库
        const tx = new TransactionManager()
        let databaseCreated = false

        const dbSpinner = createSpinner(
          `正在创建数据库 "${databaseName}"...`,
        )
        dbSpinner.start()

        try {
          await engine.createDatabase(config, databaseName)
          databaseCreated = true
          dbSpinner.succeed(`数据库 "${databaseName}" 就绪`)

          // 基于文件的引擎（SQLite, DuckDB）不需要数据库跟踪
          // 它们使用注册表，文件本身就是数据库
          if (!isFileBasedEngine(engineName)) {
            // 注册回滚操作，如果恢复失败则删除数据库
            tx.addRollback({
              description: `删除数据库 "${databaseName}"`,
              execute: async () => {
                try {
                  await engine.dropDatabase(config, databaseName)
                  logDebug(`已回滚：删除数据库 "${databaseName}"`)
                } catch (dropErr) {
                  logDebug(
                    `回滚时删除数据库失败：${dropErr instanceof Error ? dropErr.message : String(dropErr)}`,
                  )
                }
              },
            })

            await containerManager.addDatabase(containerName, databaseName)

            // 注册回滚操作，从容器跟踪中移除数据库
            tx.addRollback({
              description: `从容器跟踪中移除 "${databaseName}"`,
              execute: async () => {
                try {
                  await containerManager.removeDatabase(
                    containerName,
                    databaseName,
                  )
                  logDebug(
                    `已回滚：从容器跟踪中移除 "${databaseName}"`,
                  )
                } catch (removeErr) {
                  logDebug(
                    `回滚时从跟踪中移除数据库失败：${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
                  )
                }
              },
            })
          }

          const restoreSpinner = createSpinner('正在恢复备份...')
          restoreSpinner.start()

          const result = await engine.restore(config, backupPath, {
            database: databaseName,
            createDatabase: false,
          })

          // 检查恢复是否完全失败（返回码非零且未恢复任何数据）
          if (result.code !== 0 && result.stderr?.includes('FATAL')) {
            restoreSpinner.fail('恢复失败')
            throw new Error(result.stderr || '恢复失败，出现致命错误')
          }

          if (result.code === 0) {
            restoreSpinner.succeed('备份恢复成功')
          } else {
            // pg_restore 即使成功也经常返回警告
            restoreSpinner.warn('恢复完成但有警告')
            if (result.stderr) {
              console.log(chalk.yellow('\n  警告：'))
              const lines = result.stderr.split('\n').slice(0, 5)
              lines.forEach((line) => {
                if (line.trim()) {
                  console.log(chalk.gray(`    ${line}`))
                }
              })
              if (result.stderr.split('\n').length > 5) {
                console.log(chalk.gray('    ...'))
              }
            }
          }

          // 恢复成功 - 提交事务（清除回滚操作）
          tx.commit()
        } catch (restoreErr) {
          // 恢复失败 - 执行回滚以清理创建的数据库
          if (databaseCreated) {
            console.log(chalk.yellow('\n  恢复失败后正在清理...'))
            await tx.rollback()
          }
          throw restoreErr
        }

        const connectionString = engine.getConnectionString(
          config,
          databaseName,
        )

        if (options.json) {
          const metadata = await getEngineMetadata(engineName)
          console.log(
            JSON.stringify({
              success: true,
              database: databaseName,
              container: containerName,
              engine: engineName,
              format: format.description,
              sourceType: options.fromUrl ? 'remote' : 'file',
              connectionString,
              overwritten: databaseExists,
              ...metadata,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess(`数据库 "${databaseName}" 已恢复`))
          console.log()
          console.log(chalk.gray('  连接字符串：'))
          console.log(chalk.cyan(`  ${connectionString}`))

          const copied = await platformService.copyToClipboard(connectionString)
          if (copied) {
            console.log(chalk.gray('  连接字符串已复制到剪贴板'))
          } else {
            console.log(chalk.gray('  （无法复制到剪贴板）'))
          }

          console.log()
          console.log(chalk.gray('  使用以下命令连接：'))
          console.log(
            chalk.cyan(`  spindb connect ${containerName} -d ${databaseName}`),
          )
          console.log()
        }
      } catch (error) {
        const e = error as Error

        const missingToolPatterns = [
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
          'mysql not found',
          'mysqldump not found',
        ]

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
            console.log(
              chalk.yellow('  请重新运行命令以继续。'),
            )
          }
          process.exit(1)
        }

        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      } finally {
        if (tempDumpPath) {
          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // 忽略清理错误
          }
        }
      }
    },
  )
