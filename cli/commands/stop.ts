import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { Engine, isRemoteContainer } from '../../types'

export const stopCommand = new Command('stop')
  .description('停止容器')
  .argument('[name]', '容器名称')
  .option('-a, --all', '停止所有运行中的容器')
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      name: string | undefined,
      options: { all?: boolean; json?: boolean },
    ) => {
      try {
        if (options.all) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (options.json) {
              console.log(
                JSON.stringify({ error: '未找到运行中的容器' }),
              )
              process.exit(1)
            }
            console.log(uiWarning('未找到运行中的容器'))
            return
          }

          const stoppedNames: string[] = []
          const failedNames: string[] = []

          for (const container of running) {
            const spinner = options.json
              ? null
              : createSpinner(`正在停止 ${container.name}...`)
            spinner?.start()

            const engine = getEngine(container.engine)

            // 对于 PostgreSQL，检查引擎二进制文件是否已安装
            let usedFallback = false
            let stopFailed = false
            if (container.engine === Engine.PostgreSQL) {
              const isInstalled = await engine.isBinaryInstalled(
                container.version,
              )
              if (!isInstalled) {
                if (spinner) {
                  spinner.text = `正在停止 ${container.name}（引擎缺失，使用备用方案）...`
                }
                const killed = await processManager.killProcess(
                  container.name,
                  {
                    engine: container.engine,
                  },
                )
                if (!killed) {
                  spinner?.fail(`停止 "${container.name}" 失败`)
                  if (!options.json) {
                    console.log(
                      chalk.gray(
                        `  PostgreSQL ${container.version} 引擎未安装。`,
                      ),
                    )
                    console.log(
                      chalk.gray(
                        `  运行 "spindb engines download postgresql ${container.version.split('.')[0]}" 重新安装。`,
                      ),
                    )
                  }
                  failedNames.push(container.name)
                  stopFailed = true
                } else {
                  usedFallback = true
                }
              }
            }

            if (stopFailed) {
              continue
            }

            if (!usedFallback) {
              await engine.stop(container)
            }

            await containerManager.updateConfig(container.name, {
              status: 'stopped',
            })

            spinner?.succeed(`已停止 "${container.name}"`)
            stoppedNames.push(container.name)
          }

          if (options.json) {
            console.log(
              JSON.stringify({
                success: failedNames.length === 0,
                stopped: stoppedNames,
                failed: failedNames,
                count: stoppedNames.length,
              }),
            )
          } else {
            console.log(
              uiSuccess(`已停止 ${stoppedNames.length} 个容器`),
            )
          }
          return
        }

        let containerName = name

        if (!containerName) {
          // JSON 模式需要容器名称参数
          if (options.json) {
            console.log(JSON.stringify({ error: '容器名称是必需的' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            console.log(uiWarning('未找到运行中的容器'))
            return
          }

          const selected = await promptContainerSelect(
            running,
            '选择要停止的容器：',
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

        // 远程容器由外部管理
        if (isRemoteContainer(config)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                name: containerName,
                status: 'linked',
                error: `"${containerName}" 是链接的远程数据库 — 由外部管理。`,
              }),
            )
          } else {
            console.error(
              uiError(
                `"${containerName}" 是链接的远程数据库 — 由外部管理。`,
              ),
            )
          }
          process.exit(1)
        }

        const running = await processManager.isRunning(containerName, {
          engine: config.engine,
        })
        if (!running) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `容器 "${containerName}" 未运行`,
              }),
            )
            process.exit(1)
          }
          console.log(uiWarning(`容器 "${containerName}" 未运行`))
          return
        }

        const engine = getEngine(config.engine)

        const spinner = options.json
          ? null
          : createSpinner(`正在停止 ${containerName}...`)
        spinner?.start()

        // 对于 PostgreSQL，检查引擎二进制文件是否已安装
        // 如果未安装，使用备用进程终止
        let usedFallback = false
        if (config.engine === Engine.PostgreSQL) {
          const isInstalled = await engine.isBinaryInstalled(config.version)
          if (!isInstalled) {
            if (spinner) {
              spinner.text = `正在停止 ${containerName}（引擎缺失，使用备用方案）...`
            }
            const killed = await processManager.killProcess(containerName, {
              engine: config.engine,
            })
            if (!killed) {
              spinner?.fail(`停止 "${containerName}" 失败`)
              console.log(
                chalk.gray(
                  `  PostgreSQL ${config.version} 引擎未安装。`,
                ),
              )
              console.log(
                chalk.gray(
                  `  运行 "spindb engines download postgresql ${config.version.split('.')[0]}" 重新安装。`,
                ),
              )
              process.exit(1)
            }
            usedFallback = true
          }
        }

        if (!usedFallback) {
          await engine.stop(config)
        }

        await containerManager.updateConfig(containerName, {
          status: 'stopped',
        })

        spinner?.succeed(`容器 "${containerName}" 已停止`)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              stopped: [containerName],
              count: 1,
            }),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
