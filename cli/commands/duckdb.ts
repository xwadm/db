import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import {
  scanForUnregisteredDuckDBFiles,
  deriveContainerName,
} from '../../engines/duckdb/scanner'
import {
  isValidExtensionForEngine,
  formatExtensionsForEngine,
} from '../../engines/file-based-utils'
import { containerManager } from '../../core/container-manager'
import { uiSuccess, uiError, uiInfo } from '../ui/theme'
import { Engine } from '../../types'
import { detachCommand } from './detach'

export const duckdbCommand = new Command('duckdb').description(
  'DuckDB 特定操作',
)

// duckdb scan - 扫描未注册的 DuckDB 文件
duckdbCommand
  .command('scan')
  .description('扫描文件夹中未注册的 DuckDB 文件')
  .option('-p, --path <dir>', '要扫描的目录（默认：当前目录）')
  .option('--json', '以 JSON 格式输出')
  .action(async (options: { path?: string; json?: boolean }): Promise<void> => {
    const dir = options.path ? resolve(options.path) : process.cwd()

    if (!existsSync(dir)) {
      if (options.json) {
        console.log(
          JSON.stringify({ error: '目录未找到', directory: dir }),
        )
      } else {
        console.error(uiError(`目录未找到：${dir}`))
      }
      process.exit(1)
    }

    const unregistered = await scanForUnregisteredDuckDBFiles(dir)

    if (options.json) {
      console.log(JSON.stringify({ directory: dir, files: unregistered }))
      return
    }

    if (unregistered.length === 0) {
      console.log(uiInfo(`在 ${dir} 中未找到未注册的 DuckDB 文件`))
      return
    }

    console.log(
      chalk.cyan(`找到 ${unregistered.length} 个未注册的 DuckDB 文件：`),
    )
    for (const file of unregistered) {
      console.log(chalk.gray(`  ${file.fileName}`))
    }
    console.log()
    console.log(chalk.gray('  使用以下命令注册：spindb attach <path>'))
  })

// duckdb ignore - 将文件夹添加到忽略列表
duckdbCommand
  .command('ignore')
  .description('将文件夹添加到当前工作目录扫描的忽略列表')
  .argument('[folder]', '要忽略的文件夹路径（默认：当前目录）')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      folder: string | undefined,
      options: { json?: boolean },
    ): Promise<void> => {
      const absolutePath = resolve(folder || process.cwd())
      await duckdbRegistry.addIgnoreFolder(absolutePath)

      if (options.json) {
        console.log(JSON.stringify({ success: true, folder: absolutePath }))
      } else {
        console.log(uiSuccess(`已添加到忽略列表：${absolutePath}`))
      }
    },
  )

// duckdb unignore - 从忽略列表中移除文件夹
duckdbCommand
  .command('unignore')
  .description('从忽略列表中移除文件夹')
  .argument('[folder]', '要取消忽略的文件夹路径（默认：当前目录）')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      folder: string | undefined,
      options: { json?: boolean },
    ): Promise<void> => {
      const absolutePath = resolve(folder || process.cwd())
      const removed = await duckdbRegistry.removeIgnoreFolder(absolutePath)

      if (options.json) {
        console.log(JSON.stringify({ success: removed, folder: absolutePath }))
      } else {
        if (removed) {
          console.log(uiSuccess(`已从忽略列表中移除：${absolutePath}`))
        } else {
          console.log(uiInfo(`文件夹不在忽略列表中：${absolutePath}`))
        }
      }
    },
  )

// duckdb ignored - 列出被忽略的文件夹
duckdbCommand
  .command('ignored')
  .description('列出被忽略的文件夹')
  .option('--json', '以 JSON 格式输出')
  .action(async (options: { json?: boolean }): Promise<void> => {
    const folders = await duckdbRegistry.listIgnoredFolders()

    if (options.json) {
      console.log(JSON.stringify({ folders }))
      return
    }

    if (folders.length === 0) {
      console.log(uiInfo('没有被忽略的文件夹'))
      return
    }

    console.log(chalk.cyan('被忽略的文件夹：'))
    for (const folder of folders) {
      console.log(chalk.gray(`  ${folder}`))
    }
  })

// duckdb attach - 注册现有的 DuckDB 数据库（attach 命令的别名）
duckdbCommand
  .command('attach')
  .description(
    '注册现有的 DuckDB 数据库（"spindb attach" 的别名）',
  )
  .argument('<path>', 'DuckDB 数据库文件路径')
  .option('-n, --name <name>', '容器名称')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      path: string,
      options: { name?: string; json?: boolean },
    ): Promise<void> => {
      try {
        const absolutePath = resolve(path)

        // 验证扩展名是否匹配 DuckDB
        if (!isValidExtensionForEngine(absolutePath, Engine.DuckDB)) {
          const msg = `文件扩展名必须是以下之一：${formatExtensionsForEngine(Engine.DuckDB)}`
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: msg }))
          } else {
            console.error(uiError(msg))
            console.log(
              chalk.gray(
                '  对于 SQLite 文件，请使用：spindb sqlite attach <path>',
              ),
            )
          }
          process.exit(1)
        }

        if (!existsSync(absolutePath)) {
          if (options.json) {
            console.log(
              JSON.stringify({ success: false, error: '文件未找到' }),
            )
          } else {
            console.error(uiError(`文件未找到：${absolutePath}`))
          }
          process.exit(1)
        }

        if (await duckdbRegistry.isPathRegistered(absolutePath)) {
          const entry = await duckdbRegistry.getByPath(absolutePath)
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: '已注册',
                existingName: entry?.name,
              }),
            )
          } else {
            console.error(
              uiError(`文件已注册为 "${entry?.name}"`),
            )
          }
          process.exit(1)
        }

        const containerName =
          options.name || deriveContainerName(basename(absolutePath))

        if (await containerManager.exists(containerName)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: '容器名称已存在',
              }),
            )
          } else {
            console.error(
              uiError(`容器 "${containerName}" 已存在`),
            )
          }
          process.exit(1)
        }

        await duckdbRegistry.add({
          name: containerName,
          filePath: absolutePath,
          created: new Date().toISOString(),
        })

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              name: containerName,
              filePath: absolutePath,
            }),
          )
        } else {
          console.log(
            uiSuccess(
              `已将 "${basename(absolutePath)}" 注册为 "${containerName}"`,
            ),
          )
          console.log()
          console.log(chalk.gray('  使用以下命令连接：'))
          console.log(chalk.cyan(`    spindb connect ${containerName}`))
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

// duckdb detach - 注销 DuckDB 数据库（detach 命令的别名）
duckdbCommand
  .command('detach')
  .description('注销 DuckDB 数据库（"spindb detach" 的别名）')
  .argument('<name>', '容器名称')
  .option('-f, --force', '跳过确认')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      name: string,
      options: { force?: boolean; json?: boolean },
    ): Promise<void> => {
      // 构建参数数组
      const args = ['node', 'detach', name]
      if (options.force) args.push('-f')
      if (options.json) args.push('--json')

      await detachCommand.parseAsync(args, { from: 'node' })
    },
  )
