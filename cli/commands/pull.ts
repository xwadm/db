/**
 * Pull 命令
 *
 * 将远程数据库数据拉取到本地容器，可选择备份原始本地数据。
 *
 * 用法：
 *   spindb pull <container> --from <url>                    # 替换模式
 *   spindb pull <container> --from <url> --as <name>        # 克隆模式
 *   spindb pull <container> --from <url> --no-backup -f     # 替换但不备份
 *   spindb pull <container> --from <url> --dry-run          # 预览更改
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { pullManager } from '../../core/pull-manager'
import { containerManager } from '../../core/container-manager'
import { createSpinner } from '../ui/spinner'
import { promptConfirm } from '../ui/prompts'
import { uiError } from '../ui/theme'

export const pullCommand = new Command('pull')
  .description('将远程数据库数据拉取到本地容器')
  .argument('<container>', '容器名称')
  .option('--from <url>', '远程数据库连接字符串')
  .option('--from-env <name>', '从环境变量读取远程 URL')
  .option('-d, --database <name>', '目标数据库（默认：主数据库）')
  .option('--as <name>', '克隆到新数据库而非替换')
  .option('--no-backup', '替换时跳过备份（危险）')
  .option('--post-script <path>', '拉取完成后运行脚本')
  .option('--dry-run', '预览更改而不执行')
  .option('-f, --force', '跳过确认提示')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      container: string,
      options: {
        from?: string
        fromEnv?: string
        database?: string
        as?: string
        backup: boolean // Commander 将 --no-backup 反转为 backup: false
        postScript?: string
        dryRun?: boolean
        force?: boolean
        json?: boolean
      },
    ) => {
      try {
        // 从 --from 或 --from-env 解析远程 URL
        let fromUrl = options.from
        if (options.fromEnv) {
          fromUrl = process.env[options.fromEnv]
          if (!fromUrl) {
            const errorMsg = `环境变量 "${options.fromEnv}" 未设置或为空`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // 必须指定 --from 或 --from-env
        if (!fromUrl) {
          const errorMsg =
            '必须指定 --from <url> 或 --from-env <name>'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
            console.log(
              chalk.dim('  用法：spindb pull <container> --from <url>'),
            )
            console.log(
              chalk.dim(
                '         spindb pull <container> --from-env CLONE_FROM_DATABASE_URL',
              ),
            )
          }
          process.exit(1)
        }

        // 验证容器存在
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `未找到容器 "${container}"` }),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // 验证危险组合
        if (
          !options.backup &&
          !options.force &&
          !options.dryRun &&
          !options.as
        ) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error:
                  '无法在没有 --force 的情况下使用 --no-backup。请使用 --force 确认。',
              }),
            )
            process.exit(1)
          }

          const confirmed = await promptConfirm(
            '这将覆盖您的数据库而不创建备份。是否继续？',
            false,
          )
          if (!confirmed) {
            console.log(chalk.gray('已中止。'))
            process.exit(0)
          }
        }

        const spinner =
          options.json || options.dryRun
            ? null
            : createSpinner('正在拉取远程数据...')

        spinner?.start()

        // 显示进度更新
        const updateSpinner = (message: string) => {
          if (spinner) {
            spinner.text = message
          }
        }

        if (!options.json && !options.dryRun) {
          updateSpinner('正在验证容器...')
        }

        const result = await pullManager.pull(container, {
          database: options.database,
          fromUrl: fromUrl,
          asDatabase: options.as,
          noBackup: !options.backup,
          postScript: options.postScript,
          dryRun: options.dryRun,
          force: options.force,
          json: options.json,
        })

        spinner?.succeed(result.message)

        if (options.json) {
          console.log(JSON.stringify(result))
        } else if (!options.dryRun) {
          console.log('')
          console.log(chalk.green('拉取完成！'))
          console.log('')
          console.log(`  ${chalk.dim('模式：')}      ${result.mode}`)
          console.log(
            `  ${chalk.dim('数据库：')}  ${chalk.cyan(result.database)}`,
          )
          if (result.backupDatabase) {
            console.log(
              `  ${chalk.dim('备份：')}    ${chalk.cyan(result.backupDatabase)}`,
            )
          }
          console.log(
            `  ${chalk.dim('来源：')}    ${chalk.gray(result.source)}`,
          )
          console.log('')

          if (result.mode === 'replace') {
            console.log(chalk.dim('您的连接字符串未更改：'))
            console.log(chalk.white(`  ${result.databaseUrl}`))
          } else {
            console.log(
              chalk.yellow('更新您的 .env 以使用新数据库：'),
            )
            console.log(chalk.white(`  DATABASE_URL=${result.databaseUrl}`))
          }
          console.log('')
          console.log(
            chalk.bgYellow.black(
              ' 重启您的开发服务器以使用新数据。 ',
            ),
          )
          console.log('')
        } else {
          // 试运行输出
          console.log('')
          console.log(chalk.yellow('试运行 - 未进行任何更改'))
          console.log('')
          console.log('将执行：')
          console.log(`  ${chalk.dim('模式：')}      ${result.mode}`)
          console.log(
            `  ${chalk.dim('数据库：')}  ${chalk.cyan(result.database)}`,
          )
          if (result.backupDatabase) {
            console.log(
              `  ${chalk.dim('备份：')}    ${chalk.cyan(result.backupDatabase)}`,
            )
          }
          console.log(
            `  ${chalk.dim('来源：')}    ${chalk.gray(result.source)}`,
          )
          console.log('')
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
