import { Command } from 'commander'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import {
  detectEngineFromPath,
  getRegistryForEngine,
  deriveContainerName,
  formatAllExtensions,
} from '../../engines/file-based-utils'
import { uiSuccess, uiError } from '../ui/theme'
import type { Engine } from '../../types'

export const attachCommand = new Command('attach')
  .description('将现有的基于文件的数据库注册到 SpinDB（支持 SQLite 或 DuckDB）')
  .argument(
    '<path>',
    '数据库文件路径（支持的扩展名：.sqlite、.db、.sqlite3、.duckdb、.ddb）',
  )
  .option('-n, --name <name>', '容器名称（默认使用文件名）')
  .option('--json', '以 JSON 格式输出')
  .action(
    async (
      path: string,
      options: { name?: string; json?: boolean },
    ): Promise<void> => {
      try {
        // 将路径转为绝对路径
        const absolutePath = resolve(path)

        // 根据文件扩展名检测数据库引擎
        const engine = detectEngineFromPath(absolutePath)
        if (!engine) {
          const msg = `无法识别的文件扩展名，支持的扩展名包括：${formatAllExtensions()}`
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: msg }))
          } else {
            console.error(uiError(msg))
          }
          process.exit(1)
        }

        // 获取对应引擎的注册表
        const registry = getRegistryForEngine(engine)

        // 验证文件是否存在
        if (!existsSync(absolutePath)) {
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: '文件未找到' }))
          } else {
            console.error(uiError(`文件未找到：${absolutePath}`))
          }
          process.exit(1)
        }

        // 检查文件是否已被注册
        if (await registry.isPathRegistered(absolutePath)) {
          const entry = await registry.getByPath(absolutePath)
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: '文件已注册',
                existingName: entry?.name,
              }),
            )
          } else {
            console.error(uiError(`该文件已注册为 "${entry?.name}"`))
          }
          process.exit(1)
        }

        // 确定容器名称
        const containerName =
          options.name ||
          deriveContainerName(
            basename(absolutePath),
            engine as Engine.SQLite | Engine.DuckDB,
          )

        // 检查容器名称是否已存在
        if (await containerManager.exists(containerName)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: '容器名已存在',
              }),
            )
          } else {
            console.error(uiError(`容器 "${containerName}" 已存在`))
          }
          process.exit(1)
        }

        // 将文件注册到系统中
        await registry.add({
          name: containerName,
          filePath: absolutePath,
          created: new Date().toISOString(),
        })

        // 输出成功信息
        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              engine,
              name: containerName,
              filePath: absolutePath,
            }),
          )
        } else {
          console.log(
            uiSuccess(
              `已将 "${basename(absolutePath)}" 注册为 "${containerName}" (${engine})`,
            ),
          )
          console.log()
          console.log(chalk.gray('  连接方式：'))
          console.log(chalk.cyan(`    spindb connect ${containerName}`))
        }
      } catch (error) {
        // 统一异常处理
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
