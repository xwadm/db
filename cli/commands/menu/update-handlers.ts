import { existsSync } from 'fs'
import chalk from 'chalk'
import { escapeablePrompt } from '../../ui/prompts'
import { updateManager } from '../../../core/update-manager'
import { containerManager } from '../../../core/container-manager'
import { configManager } from '../../../core/config-manager'
import { sqliteRegistry } from '../../../engines/sqlite/registry'
import { paths } from '../../../config/paths'
import { getSupportedEngines } from '../../../config/engine-defaults'
import { checkEngineDependencies } from '../../../core/dependency-manager'
import { createSpinner } from '../../ui/spinner'
import { header, uiSuccess, uiError, uiWarning, uiInfo } from '../../ui/theme'
import { pressEnterToContinue } from './shared'
import { type Engine, isFileBasedEngine } from '../../../types'

export async function handleCheckUpdate(): Promise<void> {
  console.clear()
  console.log(header('检查更新'))
  console.log()

  const spinner = createSpinner('正在检查更新...')
  spinner.start()

  const result = await updateManager.checkForUpdate(true)

  if (!result) {
    spinner.fail('无法连接到 npm 仓库')
    console.log()
    console.log(uiInfo('请检查网络连接后重试。'))
    const pm = await updateManager.detectPackageManager()
    const installCmd = updateManager.getInstallCommand(pm)
    console.log(chalk.gray(`  手动更新：${installCmd}`))
    console.log()
    await pressEnterToContinue()
    return
  }

  if (result.updateAvailable) {
    spinner.succeed('发现可用更新')
    console.log()
    console.log(chalk.gray(`  当前版本：${result.currentVersion}`))
    console.log(chalk.gray(`  最新版本：${chalk.green(result.latestVersion)}`))
    console.log()

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: '您想执行什么操作？',
        choices: [
          { name: '立即更新', value: 'update' },
          { name: '稍后提醒', value: 'later' },
          { name: '启动时不检查更新', value: 'disable' },
        ],
      },
    ])

    if (action === 'update') {
      console.log()
      const updateSpinner = createSpinner('正在更新 spindb...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('更新完成')
        console.log()
        console.log(
          uiSuccess(
            `已从 ${updateResult.previousVersion} 更新至 ${updateResult.newVersion}`,
          ),
        )
        console.log()
        if (updateResult.previousVersion !== updateResult.newVersion) {
          console.log(uiWarning('请重启 spindb 以使用新版本。'))
          console.log()
        }
      } else {
        updateSpinner.fail('更新失败')
        console.log()
        console.log(uiError(updateResult.error || '未知错误'))
        console.log()
        const failPm = await updateManager.detectPackageManager()
        const failCmd = updateManager.getInstallCommand(failPm)
        console.log(uiInfo(`手动更新命令：${failCmd}`))
      }
      await pressEnterToContinue()
    } else if (action === 'disable') {
      await updateManager.setAutoCheckEnabled(false)
      console.log()
      console.log(uiInfo('启动时将不再检查更新。'))
      console.log(chalk.gray('  重新启用：spindb config update-check on'))
      console.log()
      await pressEnterToContinue()
    }
    // '稍后提醒' 仅返回菜单
  } else {
    spinner.succeed('您已是最新版本')
    console.log()
    console.log(chalk.gray(`  版本：${result.currentVersion}`))
    console.log()
    await pressEnterToContinue()
  }
}

type HealthCheckResult = {
  name: string
  status: 'ok' | 'warning' | 'error'
  message: string
  details?: string[]
  action?: {
    label: string
    handler: () => Promise<void>
  }
}

async function checkConfiguration(): Promise<HealthCheckResult> {
  const configPath = paths.config

  if (!existsSync(configPath)) {
    return {
      name: '配置',
      status: 'ok',
      message: '暂无配置文件（首次使用时将创建）',
    }
  }

  try {
    const config = await configManager.load()
    const binaryCount = Object.keys(config.binaries || {}).length
    const isStale = await configManager.isStale()

    if (isStale) {
      return {
        name: '配置',
        status: 'warning',
        message: '二进制缓存已过期（超过 7 天）',
        details: [`已缓存的二进制工具数量：${binaryCount}`],
        action: {
          label: '刷新二进制缓存',
          handler: async () => {
            await configManager.refreshAllBinaries()
            console.log(uiSuccess('二进制缓存已刷新'))
          },
        },
      }
    }

    return {
      name: '配置',
      status: 'ok',
      message: '配置有效',
      details: [`已缓存的二进制工具数量：${binaryCount}`],
    }
  } catch (error) {
    return {
      name: '配置',
      status: 'error',
      message: '配置文件已损坏',
      details: [(error as Error).message],
    }
  }
}

async function checkContainers(): Promise<HealthCheckResult> {
  try {
    const containers = await containerManager.list()

    if (containers.length === 0) {
      return {
        name: '容器',
        status: 'ok',
        message: '暂无容器（使用 spindb create 创建）',
      }
    }

    const byEngine: Record<string, { running: number; stopped: number }> = {}

    for (const c of containers) {
      const engineName = c.engine
      if (!byEngine[engineName]) {
        byEngine[engineName] = { running: 0, stopped: 0 }
      }
      if (c.status === 'running') {
        byEngine[engineName].running++
      } else {
        byEngine[engineName].stopped++
      }
    }

    const details = Object.entries(byEngine).map(([engine, counts]) => {
      if (isFileBasedEngine(engine as Engine)) {
        return `${engine}：${counts.running} 存在，${counts.stopped} 缺失`
      }
      return `${engine}：${counts.running} 运行中，${counts.stopped} 已停止`
    })

    return {
      name: '容器',
      status: 'ok',
      message: `${containers.length} 个容器`,
      details,
    }
  } catch (error) {
    return {
      name: '容器',
      status: 'error',
      message: '无法列出容器',
      details: [(error as Error).message],
    }
  }
}

async function checkSqliteRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await sqliteRegistry.list()

    if (entries.length === 0) {
      return {
        name: 'SQLite 注册表',
        status: 'ok',
        message: '没有已注册的 SQLite 数据库',
      }
    }

    const orphans = await sqliteRegistry.findOrphans()

    if (orphans.length > 0) {
      return {
        name: 'SQLite 注册表',
        status: 'warning',
        message: `发现 ${orphans.length} 个孤立条目`,
        details: orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        action: {
          label: '从注册表中移除孤立条目',
          handler: async () => {
            const count = await sqliteRegistry.removeOrphans()
            console.log(uiSuccess(`已移除 ${count} 个孤立条目`))
          },
        },
      }
    }

    return {
      name: 'SQLite 注册表',
      status: 'ok',
      message: `已注册 ${entries.length} 个数据库，所有文件均存在`,
    }
  } catch (error) {
    return {
      name: 'SQLite 注册表',
      status: 'warning',
      message: '无法检查注册表',
      details: [(error as Error).message],
    }
  }
}

async function checkBinaries(): Promise<HealthCheckResult> {
  try {
    const engines = getSupportedEngines()
    const results: string[] = []
    let hasWarning = false

    for (const engine of engines) {
      const statuses = await checkEngineDependencies(engine)
      const installed = statuses.filter((s) => s.installed).length
      const total = statuses.length

      if (installed < total) {
        hasWarning = true
        results.push(`${engine}：已安装 ${installed}/${total} 个工具`)
      } else {
        results.push(`${engine}：所有 ${total} 个工具均可用`)
      }
    }

    return {
      name: '数据库工具',
      status: hasWarning ? 'warning' : 'ok',
      message: hasWarning ? '缺少部分工具' : '所有工具均可用',
      details: results,
    }
  } catch (error) {
    return {
      name: '数据库工具',
      status: 'error',
      message: '无法检查工具状态',
      details: [(error as Error).message],
    }
  }
}

function displayResult(result: HealthCheckResult): void {
  const icon =
    result.status === 'ok'
      ? chalk.green('✓')
      : result.status === 'warning'
        ? chalk.yellow('⚠')
        : chalk.red('✕')

  console.log(`${icon} ${chalk.bold(result.name)}`)
  console.log(`  └─ ${result.message}`)

  if (result.details) {
    for (const detail of result.details) {
      console.log(chalk.gray(`     ${detail}`))
    }
  }
  console.log()
}

export async function handleDoctor(): Promise<void> {
  console.clear()
  console.log(header('SpinDB 健康检查'))
  console.log()

  const checks = [
    await checkConfiguration(),
    await checkContainers(),
    await checkSqliteRegistry(),
    await checkBinaries(),
  ]

  // 显示结果
  for (const check of checks) {
    displayResult(check)
  }

  // 收集可执行的警告操作
  const actionsAvailable = checks.filter((c) => c.action)

  if (actionsAvailable.length > 0) {
    type ActionChoice = {
      name: string
      value: string
    }

    const choices: ActionChoice[] = [
      ...actionsAvailable.map((c) => ({
        name: c.action!.label,
        value: c.name,
      })),
      { name: chalk.gray('跳过（不执行任何操作）'), value: 'skip' },
    ]

    const { selectedAction } = await escapeablePrompt<{
      selectedAction: string
    }>([
      {
        type: 'list',
        name: 'selectedAction',
        message: '您想执行什么操作？',
        choices,
      },
    ])

    if (selectedAction !== 'skip') {
      const check = checks.find((c) => c.name === selectedAction)
      if (check?.action) {
        console.log()
        await check.action.handler()
      }
    }
  } else {
    const hasIssues = checks.some((c) => c.status !== 'ok')
    if (!hasIssues) {
      console.log(chalk.green('所有系统正常！✓'))
    }
  }

  console.log()
  await pressEnterToContinue()
}
