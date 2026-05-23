import { Command } from 'commander'
import chalk from 'chalk'
import { updateManager } from '../../core/update-manager'
import { createSpinner } from '../ui/spinner'

export const versionCommand = new Command('version')
  .description('显示版本信息并检查更新')
  .option('-c, --check', '检查可用更新')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (options: { check?: boolean; json?: boolean }): Promise<void> => {
      const currentVersion = updateManager.getCurrentVersion()

      if (options.check) {
        const spinner = createSpinner('正在检查更新...')
        if (!options.json) spinner.start()

        const result = await updateManager.checkForUpdate(true)

        if (!options.json) spinner.stop()

        if (options.json) {
          console.log(
            JSON.stringify({
              current: currentVersion,
              latest: result?.latestVersion || null,
              updateAvailable: result?.updateAvailable || false,
            }),
          )
        } else {
          console.log()
          console.log(`SpinDB v${currentVersion}`)
          if (result) {
            if (result.updateAvailable) {
              console.log(
                chalk.yellow(`发现可用更新：v${result.latestVersion}`),
              )
              console.log(chalk.gray("运行 'spindb self-update' 进行更新。"))
            } else {
              console.log(chalk.green('您已是最新版本。'))
            }
          } else {
            console.log(chalk.gray('无法检查更新（离线？）'))
          }
          console.log()
        }
      } else {
        if (options.json) {
          console.log(JSON.stringify({ current: currentVersion }))
        } else {
          console.log(`SpinDB v${currentVersion}`)
        }
      }
    },
  )
