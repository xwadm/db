import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { getRegistryForEngine } from '../../engines/file-based-utils'
import { promptConfirm } from '../ui/prompts'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { isFileBasedEngine } from '../../types'

export const detachCommand = new Command('detach')
  .description(
    '从 SpinDB 注销基于文件的数据库（保留磁盘上的文件）',
  )
  .argument('<name>', '容器名称')
  .option('-f, --force', '跳过确认提示')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      name: string,
      options: { force?: boolean; json?: boolean },
    ): Promise<void> => {
      try {
        // 获取容器配置
        const config = await containerManager.getConfig(name)

        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({ success: false, error: '未找到容器' }),
            )
          } else {
            console.error(uiError(`未找到容器 "${name}"`))
          }
          process.exit(1)
        }

        // 验证是否为基于文件的容器
        if (!isFileBasedEngine(config.engine)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error:
                  '不是基于文件的容器。对于服务器数据库，请使用 "spindb delete"。',
              }),
            )
          } else {
            console.error(
              uiError(
                `"${name}" 不是基于文件的容器（SQLite/DuckDB）`,
              ),
            )
            console.log(
              chalk.gray(
                '  对于服务器数据库（PostgreSQL, MySQL），请使用 "spindb delete"',
              ),
            )
          }
          process.exit(1)
        }

        // 除非使用 --force，否则需要确认
        if (!options.force && !options.json) {
          const confirmed = await promptConfirm(
            `从 SpinDB 注销 "${name}"？（文件将保留在磁盘上）`,
            true,
          )
          if (!confirmed) {
            console.log(uiWarning('已取消'))
            return
          }
        }

        const registry = getRegistryForEngine(config.engine)
        const entry = await registry.get(name)
        const filePath = entry?.filePath

        // 仅从注册表中移除（不删除文件）
        await registry.remove(name)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              name,
              filePath,
            }),
          )
        } else {
          console.log(uiSuccess(`已从 SpinDB 注销 "${name}"`))
          if (filePath) {
            console.log(chalk.gray(`  文件保留在：${filePath}`))
          }
          console.log()
          console.log(chalk.gray('  使用以下命令重新附加：'))
          console.log(chalk.cyan(`    spindb attach ${filePath || '<path>'}`))
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
