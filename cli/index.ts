import { program } from 'commander'
import chalk from 'chalk'
import { VERSION } from '../config/version'
import { createCommand } from './commands/create'
import { listCommand } from './commands/list'
import { portsCommand } from './commands/ports'
import { startCommand } from './commands/start'
import { stopCommand } from './commands/stop'
import { deleteCommand } from './commands/delete'
import { restoreCommand } from './commands/restore'
import { backupCommand } from './commands/backup'
import { backupsCommand } from './commands/backups'
import { connectCommand } from './commands/connect'
import { cloneCommand } from './commands/clone'
import { menuCommand } from './commands/menu'
import { configCommand } from './commands/config'
import { depsCommand } from './commands/deps'
import { enginesCommand } from './commands/engines'
import { editCommand } from './commands/edit'
import { urlCommand } from './commands/url'
import { infoCommand } from './commands/info'
import { selfUpdateCommand } from './commands/self-update'
import { versionCommand } from './commands/version'
import { runCommand } from './commands/run'
import { logsCommand } from './commands/logs'
import { doctorCommand } from './commands/doctor'
import { attachCommand } from './commands/attach'
import { detachCommand } from './commands/detach'
import { sqliteCommand } from './commands/sqlite'
import { duckdbCommand } from './commands/duckdb'
import { databasesCommand } from './commands/databases'
import { pullCommand } from './commands/pull'
import { whichCommand } from './commands/which'
import { exportCommand } from './commands/export'
import { queryCommand } from './commands/query'
import { usersCommand } from './commands/users'
import { linkCommand } from './commands/link'
import { binPathCommand } from './commands/bin-path'
import { updateManager } from '../core/update-manager'
import { configManager } from '../core/config-manager'
import { setCachedIconMode } from './constants'

/**
 * 从用户配置中加载偏好设置（图标模式等）。
 * 此操作在任何命令执行前运行，以确保 CLI 和 TUI 之间行为一致。
 */
async function loadUserPreferences(): Promise<void> {
  try {
    const config = await configManager.getConfig()
    if (config.preferences?.iconMode) {
      setCachedIconMode(config.preferences.iconMode)
    }
  } catch {
    // 静默忽略 — 偏好设置并非 CLI 功能的关键部分
  }
}

/**
 * 如果存在可用更新（来自缓存数据），则显示更新通知横幅。
 * 每次运行时都会显示，直到用户更新或禁用检查。
 */
async function showUpdateNotificationIfAvailable(): Promise<void> {
  try {
    const cached = await updateManager.getCachedUpdateInfo()

    // 如果自动检查已禁用或没有缓存版本，则跳过
    if (!cached.autoCheckEnabled || !cached.latestVersion) return

    const currentVersion = updateManager.getCurrentVersion()
    const latestVersion = cached.latestVersion

    // 如果没有可用更新，则跳过
    if (updateManager.compareVersions(latestVersion, currentVersion) <= 0)
      return

    // 显示通知横幅
    console.log()
    console.log(chalk.cyan('─'.repeat(50)))
    console.log(
      chalk.yellow('  发现新版本！ ') +
        chalk.gray(`${currentVersion} -> `) +
        chalk.green(latestVersion),
    )
    console.log(chalk.gray('  运行：') + chalk.cyan('spindb self-update'))
    console.log(
      chalk.gray('  禁用通知：') + chalk.gray('spindb config update-check off'),
    )
    console.log(chalk.cyan('─'.repeat(50)))
    console.log()
  } catch {
    // 静默忽略错误 — 更新通知并非关键功能
  }
}

/**
 * 触发后台更新检查（发射并忘记）。
 * 此操作为下一次运行的通知更新缓存。
 */
function triggerBackgroundUpdateCheck(): void {
  updateManager.checkForUpdate(false).catch(() => {
    // 静默忽略 — 后台检查是尽力而为的
  })
}

export async function run(): Promise<void> {
  // 在任何命令运行之前加载用户偏好设置（图标模式等）
  await loadUserPreferences()

  // 触发后台更新检查（非阻塞，为下一次运行更新缓存）
  triggerBackgroundUpdateCheck()

  program
    .name('spindb')
    .description('无需 Docker 即可快速启动本地数据库容器')
    .version(VERSION, '-v, --version', '输出版本号')
    .enablePositionalOptions()

  program.addCommand(createCommand)
  program.addCommand(listCommand)
  program.addCommand(portsCommand)
  program.addCommand(startCommand)
  program.addCommand(stopCommand)
  program.addCommand(deleteCommand)
  program.addCommand(restoreCommand)
  program.addCommand(backupCommand)
  program.addCommand(backupsCommand)
  program.addCommand(connectCommand)
  program.addCommand(cloneCommand)
  program.addCommand(menuCommand)
  program.addCommand(configCommand)
  program.addCommand(depsCommand)
  program.addCommand(enginesCommand)
  program.addCommand(editCommand)
  program.addCommand(urlCommand)
  program.addCommand(infoCommand)
  program.addCommand(selfUpdateCommand)
  program.addCommand(versionCommand)
  program.addCommand(runCommand)
  program.addCommand(logsCommand)
  program.addCommand(doctorCommand)
  program.addCommand(attachCommand)
  program.addCommand(detachCommand)
  program.addCommand(sqliteCommand)
  program.addCommand(duckdbCommand)
  program.addCommand(databasesCommand)
  program.addCommand(pullCommand)
  program.addCommand(whichCommand)
  program.addCommand(exportCommand)
  program.addCommand(queryCommand)
  program.addCommand(usersCommand)
  program.addCommand(linkCommand)
  program.addCommand(binPathCommand)

  if (process.argv.length <= 2) {
    // 仅在交互式菜单模式启动时显示一次更新通知
    await showUpdateNotificationIfAvailable()
    await menuCommand.parseAsync([])
    return
  }

  await program.parseAsync()
}
