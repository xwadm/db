import { Command } from 'commander'
import { execSync } from 'child_process'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { updateManager } from '../../core/update-manager'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiInfo, header } from '../ui/theme'

export const selfUpdateCommand = new Command('self-update')
  .alias('update')
  .description('将 SpinDB 更新到最新版本')
  .option('-f, --force', '即使已是最新版本也强制更新')
  .option('-y, --yes', '跳过确认提示')
  .action(
    async (options: { force?: boolean; yes?: boolean }): Promise<void> => {
      console.log()
      console.log(header('SpinDB 自我更新'))
      console.log()

      const checkSpinner = createSpinner('正在检查更新...')
      checkSpinner.start()

      const result = await updateManager.checkForUpdate(true)

      if (!result) {
        checkSpinner.fail('无法连接到 npm 注册表')
        console.log()
        console.log(uiInfo('请检查您的网络连接后重试。'))
        const pm = await updateManager.detectPackageManager()
        const manualCmd = updateManager.getInstallCommand(pm)
        console.log(chalk.gray(`  手动更新：${manualCmd}`))
        process.exit(1)
      }

      if (!result.updateAvailable && !options.force) {
        checkSpinner.succeed('已是最新版本')
        console.log()
        console.log(chalk.gray(`  当前版本：${result.currentVersion}`))
        console.log(chalk.gray(`  最新版本：${result.latestVersion}`))
        console.log()
        return
      }

      if (result.updateAvailable) {
        checkSpinner.succeed('发现可用更新')
      } else {
        checkSpinner.succeed('版本检查完成')
      }

      console.log()
      console.log(chalk.gray(`  当前版本：${result.currentVersion}`))
      console.log(
        chalk.gray(
          `  最新版本：${result.updateAvailable ? chalk.green(result.latestVersion) : result.latestVersion}`,
        ),
      )
      console.log()

      // 除非使用 --yes，否则需要确认
      if (!options.yes) {
        const message = result.updateAvailable
          ? `将 SpinDB 从 ${result.currentVersion} 更新到 ${result.latestVersion}？`
          : `重新安装 SpinDB ${result.currentVersion}？`

        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
          {
            type: 'confirm',
            name: 'confirm',
            message,
            default: true,
          },
        ])

        if (!confirm) {
          console.log(chalk.yellow('更新已取消'))
          return
        }
      }

      console.log()
      const updateSpinner = createSpinner('正在更新 SpinDB...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('更新完成')
        console.log()
        console.log(
          uiSuccess(
            `已从 ${updateResult.previousVersion} 更新到 ${updateResult.newVersion}`,
          ),
        )
        console.log()

        // 通过在新进程中运行 spindb --version 来验证新版本
        // （新进程加载更新的代码）
        if (updateResult.previousVersion !== updateResult.newVersion) {
          try {
            const versionOutput = execSync('spindb --version', {
              encoding: 'utf-8',
              cwd: '/',
            }).trim()
            console.log(chalk.gray(`  已验证：${versionOutput}`))
            console.log()
          } catch {
            // 验证失败，但更新成功
            console.log(
              chalk.gray('  运行 "spindb --version" 验证更新。'),
            )
            console.log()
          }
        }
      } else {
        updateSpinner.fail('更新失败')
        console.log()
        console.log(uiError(updateResult.error || '未知错误'))
        process.exit(1)
      }
    },
  )
