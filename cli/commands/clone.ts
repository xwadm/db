import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptContainerName } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, connectionBox } from '../ui/theme'
import { isRemoteContainer } from '../../types'

export const cloneCommand = new Command('clone')
  .description('克隆一个容器及其所有数据')
  .argument('[source]', '源容器名称')
  .argument('[target]', '目标容器名称')
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      source: string | undefined,
      target: string | undefined,
      options: { json?: boolean },
    ) => {
      try {
        let sourceName = source
        let targetName = target

        if (!sourceName) {
          // JSON 模式下要求必须提供源容器名称参数
          if (options.json) {
            console.log(JSON.stringify({ error: '需要提供源容器名称' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const stopped = containers.filter(
            (c) => c.status !== 'running' && c.status !== 'linked',
          )

          if (containers.length === 0) {
            console.log(
              uiWarning('未找到任何容器。使用 spindb create 创建一个。'),
            )
            return
          }

          if (stopped.length === 0) {
            console.log(
              uiWarning('所有容器都在运行中。请先停止一个容器才能克隆它。'),
            )
            console.log(chalk.gray('  克隆操作要求源容器处于停止状态。'))
            return
          }

          const selected = await promptContainerSelect(
            stopped,
            '选择要克隆的容器：',
          )
          if (!selected) return
          sourceName = selected
        }

        const sourceConfig = await containerManager.getConfig(sourceName)
        if (!sourceConfig) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `容器 "${sourceName}" 未找到` }),
            )
          } else {
            console.error(uiError(`容器 "${sourceName}" 未找到`))
          }
          process.exit(1)
        }

        // 远程容器无法克隆
        if (isRemoteContainer(sourceConfig)) {
          const errorMsg = `无法克隆链接的远程容器。请使用 "spindb backup" 导出数据，再使用 "spindb restore" 导入到本地。`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const running = await processManager.isRunning(sourceName, {
          engine: sourceConfig.engine,
        })
        if (running) {
          const errorMsg = `容器 "${sourceName}" 正在运行。请先停止它才能克隆。`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        if (!targetName) {
          // JSON 模式下要求必须提供目标容器名称参数
          if (options.json) {
            console.log(JSON.stringify({ error: '需要提供目标容器名称' }))
            process.exit(1)
          }
          targetName = await promptContainerName(`${sourceName}-copy`)
        }

        // 检查目标容器是否已存在
        if (
          await containerManager.exists(targetName, {
            engine: sourceConfig.engine,
          })
        ) {
          const errorMsg = `容器 "${targetName}" 已存在`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const cloneSpinner = createSpinner(
          `正在将 ${sourceName} 克隆为 ${targetName}...`,
        )
        cloneSpinner.start()

        const newConfig = await containerManager.clone(sourceName, targetName)

        cloneSpinner.succeed(`已将 "${sourceName}" 克隆为 "${targetName}"`)

        const engine = getEngine(newConfig.engine)
        const connectionString = engine.getConnectionString(newConfig)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              source: sourceName,
              target: targetName,
              newPort: newConfig.port,
              connectionString,
            }),
          )
        } else {
          console.log()
          console.log(
            connectionBox(targetName, connectionString, newConfig.port),
          )
          console.log()
          console.log(chalk.gray('  启动克隆后的容器：'))
          console.log(chalk.cyan(`  spindb start ${targetName}`))
          console.log()
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
