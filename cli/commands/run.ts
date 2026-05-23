import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptInstallDependencies } from '../ui/prompts'
import { uiError, uiWarning } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'

export const runCommand = new Command('run')
  .description('对容器运行脚本文件或命令')
  .argument('<name>', '容器名称')
  .argument(
    '[file]',
    '脚本文件路径（关系型数据库为 SQL，Redis 命令等）',
  )
  .option('-d, --database <name>', '目标数据库（默认为主数据库）')
  .option('-c, --command <cmd>', '要执行的命令（替代文件）')
  .option('--sql <statement>', '--command 的别名（已弃用）')
  .action(
    async (
      name: string,
      file: string | undefined,
      options: { database?: string; command?: string; sql?: string },
    ) => {
      // --sql 选项的弃用警告
      if (options.sql) {
        console.warn(
          uiWarning(
            '--sql 选项已弃用。请使用 -c/--command 替代。',
          ),
        )
      }

      // 同时支持 --command 和 --sql（已弃用的别名）
      // 优先使用明确的 --command 而非已弃用的 --sql
      const command = options.command || options.sql

      try {
        const containerName = name

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`未找到容器 "${containerName}"`))
          process.exit(1)
        }

        const { engine: engineName } = config

        // 远程容器：暂不支持 run（引擎方法连接到 127.0.0.1）
        if (isRemoteContainer(config)) {
          console.error(
            uiError(
              '链接的远程容器暂不支持 run 命令。请使用 "spindb connect" 打开客户端 Shell。',
            ),
          )
          process.exit(1)
        }

        // 基于文件的数据库：检查文件是否存在而非运行状态
        if (isFileBasedEngine(engineName)) {
          if (!existsSync(config.database)) {
            console.error(
              uiError(`数据库文件未找到：${config.database}`),
            )
            process.exit(1)
          }
        } else {
          // 服务器数据库需要处于运行状态
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            console.error(
              uiError(
                `容器 "${containerName}" 未运行。请先启动：spindb start ${containerName}`,
              ),
            )
            process.exit(1)
          }
        }

        if (file && command) {
          console.error(
            uiError(
              '不能同时指定文件和 --command 选项。请选择其一。',
            ),
          )
          process.exit(1)
        }

        if (!file && !command) {
          console.error(
            uiError('必须提供脚本文件或 --command 选项'),
          )
          console.log(chalk.gray('  用法：spindb run <container> <file>'))
          console.log(
            chalk.gray('     或：spindb run <container> -c "command"'),
          )
          process.exit(1)
        }

        if (file && !existsSync(file)) {
          console.error(uiError(`脚本文件未找到：${file}`))
          process.exit(1)
        }

        const engine = getEngine(engineName)

        let missingDeps = await getMissingDependencies(engineName)
        if (missingDeps.length > 0) {
          console.log(
            uiWarning(
              `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
            ),
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            engineName,
          )

          if (!installed) {
            process.exit(1)
          }

          missingDeps = await getMissingDependencies(engineName)
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
        }

        const database = options.database || config.database

        await engine.runScript(config, {
          file,
          sql: command,
          database,
        })
      } catch (error) {
        const e = error as Error

        // 工具模式到引擎的映射
        const toolPatternToEngine: Record<string, Engine> = {
          'psql not found': Engine.PostgreSQL,
          'mysql not found': Engine.MySQL,
          'mysql client not found': Engine.MySQL,
          'redis-cli not found': Engine.Redis,
          'mongosh not found': Engine.MongoDB,
          'sqlite3 not found': Engine.SQLite,
        }

        const matchingPattern = Object.keys(toolPatternToEngine).find((p) =>
          e.message.toLowerCase().includes(p.toLowerCase()),
        )

        if (matchingPattern) {
          const missingTool = matchingPattern
            .replace(' not found', '')
            .replace(' client', '')
          const toolEngine = toolPatternToEngine[matchingPattern]
          const installed = await promptInstallDependencies(
            missingTool,
            toolEngine,
          )
          if (installed) {
            console.log(
              chalk.yellow('  请重新运行命令以继续。'),
            )
          }
          process.exit(1)
        }

        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
