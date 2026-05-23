import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import {
  configManager,
  POSTGRESQL_TOOLS,
  MYSQL_TOOLS,
  ENHANCED_SHELLS,
  ALL_TOOLS,
} from '../../core/config-manager'
import { updateManager } from '../../core/update-manager'
import { uiError, uiSuccess, header, uiInfo } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { createSpinner } from '../ui/spinner'
import { handleSettings } from './menu/settings-handlers'
import type { BinaryTool } from '../../types'

// 辅助函数：显示工具配置
function displayToolConfig(
  tool: BinaryTool,
  binaryConfig: { path: string; version?: string; source: string } | undefined,
): void {
  if (binaryConfig) {
    const sourceLabel =
      binaryConfig.source === 'system'
        ? chalk.blue('系统')
        : binaryConfig.source === 'custom'
          ? chalk.yellow('自定义')
          : chalk.green('内置')
    const versionLabel = binaryConfig.version
      ? chalk.gray(` (v${binaryConfig.version})`)
      : ''
    console.log(
      `    ${chalk.cyan(tool.padEnd(15))} ${binaryConfig.path}${versionLabel} [${sourceLabel}]`,
    )
  } else {
    console.log(
      `    ${chalk.cyan(tool.padEnd(15))} ${chalk.gray('未检测到')}`,
    )
  }
}

export const configCommand = new Command('config')
  .alias('configure')
  .description('管理 SpinDB 配置')
  .action(async () => {
    // 如果在 TTY 模式下作为裸命令运行，打开交互式设置
    // 注意：图标模式偏好设置在 cli/index.ts 中任何命令运行之前全局加载
    if (process.stdin.isTTY) {
      await handleSettings()
    } else {
      // 非交互式：显示帮助
      console.log(configCommand.helpInformation())
    }
  })
  .addCommand(
    new Command('show')
      .description('显示当前配置')
      .option('--json', '以 JSON 格式输出')
      .action(async (options: { json?: boolean }) => {
        try {
          const config = await configManager.getConfig()

          if (options.json) {
            console.log(JSON.stringify(config, null, 2))
            return
          }

          console.log()
          console.log(header('SpinDB 配置'))
          console.log()

          // PostgreSQL 工具
          console.log(
            chalk.bold(`  ${getEngineIcon('postgresql')}PostgreSQL 工具：`),
          )
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of POSTGRESQL_TOOLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          // MySQL 工具
          console.log(chalk.bold(`  ${getEngineIcon('mysql')}MySQL 工具：`))
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of MYSQL_TOOLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          // 增强型 Shell
          console.log(chalk.bold('  ✨ 增强型 Shell（可选）：'))
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of ENHANCED_SHELLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          if (config.updatedAt) {
            const isStale = await configManager.isStale()
            const staleWarning = isStale
              ? chalk.yellow('（已过期 - 运行 config detect 刷新）')
              : ''
            console.log(
              chalk.gray(
                `  最后更新：${new Date(config.updatedAt).toLocaleString()}${staleWarning}`,
              ),
            )
            console.log()
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('detect')
      .description('自动检测系统上的所有数据库工具')
      .action(async () => {
        try {
          console.log()
          console.log(header('检测数据库工具'))
          console.log()

          const spinner = createSpinner('正在搜索数据库工具...')
          spinner.start()

          // 清除现有配置以强制重新检测
          await configManager.clearAllBinaries()

          const result = await configManager.initialize()

          spinner.succeed('检测完成')
          console.log()

          // 辅助函数：显示类别结果
          async function displayCategory(
            title: string,
            icon: string,
            found: BinaryTool[],
            missing: BinaryTool[],
          ): Promise<void> {
            console.log(chalk.bold(`  ${icon} ${title}：`))

            if (found.length > 0) {
              for (const tool of found) {
                const config = await configManager.getBinaryConfig(tool)
                if (config) {
                  const versionLabel = config.version
                    ? chalk.gray(` (v${config.version})`)
                    : ''
                  console.log(
                    `    ${chalk.green('✓')} ${chalk.cyan(tool.padEnd(15))} ${config.path}${versionLabel}`,
                  )
                }
              }
            }

            if (missing.length > 0) {
              for (const tool of missing) {
                console.log(
                  `    ${chalk.gray('○')} ${chalk.gray(tool.padEnd(15))} 未找到`,
                )
              }
            }

            console.log()
          }

          await displayCategory(
            'PostgreSQL 工具',
            getEngineIcon('postgresql'),
            result.postgresql.found,
            result.postgresql.missing,
          )
          await displayCategory(
            'MySQL 工具',
            getEngineIcon('mysql'),
            result.mysql.found,
            result.mysql.missing,
          )
          await displayCategory(
            '增强型 Shell（可选）',
            '✨',
            result.enhanced.found,
            result.enhanced.missing,
          )

          // 显示缺失的必需工具的安装提示
          if (
            result.postgresql.missing.length > 0 ||
            result.mysql.missing.length > 0
          ) {
            console.log(chalk.gray('  安装缺失的工具：'))
            if (result.postgresql.missing.length > 0) {
              console.log(
                chalk.gray('    PostgreSQL: brew install postgresql@17'),
              )
            }
            if (result.mysql.missing.length > 0) {
              console.log(chalk.gray('    MySQL:      brew install mysql'))
            }
            console.log()
          }

          // 显示增强型 Shell 提示
          if (result.enhanced.missing.length > 0) {
            console.log(chalk.gray('  可选的增强型 Shell：'))
            if (result.enhanced.missing.includes('pgcli')) {
              console.log(chalk.gray('    pgcli: brew install pgcli'))
            }
            if (result.enhanced.missing.includes('mycli')) {
              console.log(chalk.gray('    mycli: brew install mycli'))
            }
            if (result.enhanced.missing.includes('usql')) {
              console.log(
                chalk.gray('    usql:  brew tap xo/xo && brew install usql'),
              )
            }
            console.log()
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('set')
      .description('设置自定义二进制路径')
      .argument('<tool>', '工具名称（psql, mysql, pgcli 等）')
      .argument('<path>', '二进制文件路径')
      .action(async (tool: string, path: string) => {
        try {
          // 验证工具名称
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`无效的工具：${tool}`))
            console.log(chalk.gray(`  有效工具：${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          // 验证路径是否存在
          if (!existsSync(path)) {
            console.error(uiError(`文件未找到：${path}`))
            process.exit(1)
          }

          await configManager.setBinaryPath(tool as BinaryTool, path, 'custom')

          const config = await configManager.getBinaryConfig(tool as BinaryTool)
          const versionLabel = config?.version ? ` (v${config.version})` : ''

          console.log(uiSuccess(`已将 ${tool} 设置为：${path}${versionLabel}`))
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('unset')
      .description('移除自定义二进制路径')
      .argument('<tool>', '工具名称（psql, mysql, pgcli 等）')
      .action(async (tool: string) => {
        try {
          // 验证工具名称
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`无效的工具：${tool}`))
            console.log(chalk.gray(`  有效工具：${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          await configManager.clearBinaryPath(tool as BinaryTool)
          console.log(uiSuccess(`已移除 ${tool} 配置`))
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('path')
      .description('显示特定工具的路径')
      .argument('<tool>', '工具名称（psql, mysql, pgcli 等）')
      .action(async (tool: string) => {
        try {
          // 验证工具名称
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`无效的工具：${tool}`))
            console.log(chalk.gray(`  有效工具：${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          const path = await configManager.getBinaryPath(tool as BinaryTool)
          if (path) {
            console.log(path)
          } else {
            console.error(uiError(`未找到 ${tool}`))
            console.log(
              chalk.gray(`  运行 'spindb config detect' 自动检测工具`),
            )
            process.exit(1)
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('update-check')
      .description('启用或禁用启动时的自动更新检查')
      .argument('[state]', 'on 或 off（省略则显示当前状态）')
      .action(async (state?: string) => {
        try {
          const cached = await updateManager.getCachedUpdateInfo()

          if (!state) {
            // 显示当前状态
            const status = cached.autoCheckEnabled
              ? chalk.green('已启用')
              : chalk.yellow('已禁用')
            console.log()
            console.log(`  启动时更新检查：${status}`)
            console.log()
            console.log(chalk.gray('  用法：'))
            console.log(
              chalk.gray('    spindb config update-check on   # 启用'),
            )
            console.log(
              chalk.gray('    spindb config update-check off  # 禁用'),
            )
            console.log()
            return
          }

          if (state !== 'on' && state !== 'off') {
            console.error(uiError('无效的状态。请使用 "on" 或 "off"'))
            process.exit(1)
          }

          const enabled = state === 'on'
          await updateManager.setAutoCheckEnabled(enabled)

          if (enabled) {
            console.log(uiSuccess('已启用启动时的更新检查'))
          } else {
            console.log(uiInfo('已禁用启动时的更新检查'))
            console.log(
              chalk.gray(
                '  您仍可以使用以下命令手动检查：spindb version --check',
              ),
            )
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
