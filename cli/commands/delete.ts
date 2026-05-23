import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { exitWithError, isInteractiveMode } from '../../core/error-handler'
import { isRemoteContainer } from '../../types'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiWarning } from '../ui/theme'
import { getEngineMetadata } from '../helpers'

export const deleteCommand = new Command('delete')
  .alias('rm')
  .description('删除容器')
  .argument('[name]', '容器名称')
  .option('-f, --force', '强制删除（如运行中则先停止）')
  .option('-y, --yes', '跳过确认')
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      name: string | undefined,
      options: { force?: boolean; yes?: boolean; json?: boolean },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          // JSON 模式需要容器名称参数
          if (options.json) {
            return exitWithError({
              message: '容器名称是必需的',
              json: true,
            })
          }

          // 非交互模式需要容器名称参数
          if (!isInteractiveMode()) {
            return exitWithError({
              message:
                '非交互模式下需要容器名称。用法：spindb delete <name> --force',
            })
          }

          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('未找到容器'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            '选择要删除的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          return exitWithError({
            message: `未找到容器 "${containerName}"`,
            json: options.json,
          })
        }

        if (!options.yes && !options.force && !options.json) {
          // 检测非交互模式（管道输入、脚本、CI）
          if (!isInteractiveMode()) {
            return exitWithError({
              message:
                '无法在非交互模式下提示确认。使用 --force 或 --yes 跳过确认',
            })
          }

          const confirmed = await promptConfirm(
            `确定要删除 "${containerName}" 吗？此操作不可撤销。`,
            false,
          )
          if (!confirmed) {
            console.log(uiWarning('删除已取消'))
            return
          }
        }

        // 远程容器：跳过进程检查，仅移除本地元数据
        if (isRemoteContainer(config)) {
          const deleteSpinner = options.json
            ? null
            : createSpinner(`正在移除链接容器 "${containerName}"...`)
          deleteSpinner?.start()

          await containerManager.delete(containerName, { force: true })

          deleteSpinner?.succeed(`链接容器 "${containerName}" 已移除`)

          if (options.json) {
            const metadata = await getEngineMetadata(config.engine)
            console.log(
              JSON.stringify({
                success: true,
                deleted: containerName,
                container: containerName,
                engine: config.engine,
                remote: true,
                message:
                  '本地元数据已移除。远程数据库不受影响。',
                ...metadata,
              }),
            )
          } else {
            console.log(chalk.gray('  远程数据库不受影响。'))
          }
          return
        }

        const running = await processManager.isRunning(containerName, {
          engine: config.engine,
        })
        if (running) {
          if (options.force) {
            const stopSpinner = options.json
              ? null
              : createSpinner(`正在停止 ${containerName}...`)
            stopSpinner?.start()

            const engine = getEngine(config.engine)
            await engine.stop(config)

            stopSpinner?.succeed(`已停止 "${containerName}"`)
          } else {
            return exitWithError({
              message: `容器 "${containerName}" 正在运行。请先停止或使用 --force`,
              json: options.json,
            })
          }
        }

        const deleteSpinner = options.json
          ? null
          : createSpinner(`正在删除 ${containerName}...`)
        deleteSpinner?.start()

        await containerManager.delete(containerName, { force: true })

        deleteSpinner?.succeed(`容器 "${containerName}" 已删除`)

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(
            JSON.stringify({
              success: true,
              deleted: containerName,
              container: containerName,
              engine: config.engine,
              ...metadata,
            }),
          )
        }
      } catch (error) {
        const e = error as Error
        return exitWithError({ message: e.message, json: options.json })
      }
    },
  )
