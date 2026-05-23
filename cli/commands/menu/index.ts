import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../../core/container-manager'
import {
  updateManager,
  type UpdateCheckResult,
} from '../../../core/update-manager'
import {
  promptInstallDependencies,
  enableGlobalEscape,
  checkAndResetEscape,
  escapeablePrompt,
  EscapeError,
} from '../../ui/prompts'
import { header, uiError, uiSuccess, uiWarning } from '../../ui/theme'
import { MissingToolError } from '../../../core/error-handler'
import {
  handleCreate,
  handleList,
  handleLinkRemote,
  showContainerSubmenu,
} from './container-handlers'
import { handleSettings } from './settings-handlers'
import { configManager } from '../../../core/config-manager'
import { createSpinner } from '../../ui/spinner'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { getPageSize, getEngineIcon } from '../../constants'
import { getContainerPorts } from '../ports'

// 跟踪本次会话的更新检查状态（仅在首次加载菜单时检查一次）
let updateCheckPromise: Promise<UpdateCheckResult | null> | null = null
let cachedUpdateResult: UpdateCheckResult | null = null

async function showMainMenu(): Promise<void> {
  console.clear()
  console.log(header('SpinDB - 本地数据库管理器'))
  console.log()

  // 并行获取容器列表和配置，以加快启动速度
  const [containers, config] = await Promise.all([
    containerManager.list(),
    configManager.getConfig(),
  ])

  // 仅在首次加载菜单时检查更新（若启用了自动检查）
  // 检查在后台运行，完成后会更新 cachedUpdateResult
  const autoCheckEnabled = config.update?.autoCheckEnabled !== false
  if (autoCheckEnabled && !updateCheckPromise) {
    // 后台启动更新检查 - 完成后将填充 cachedUpdateResult
    updateCheckPromise = updateManager
      .checkForUpdate()
      .then((result) => {
        cachedUpdateResult = result
        return result
      })
      .catch(() => null)
  }

  // 检查是否已设置图标模式偏好
  const iconModeSet = config.preferences?.iconMode !== undefined

  const running = containers.filter((c) => c.status === 'running').length
  const linked = containers.filter((c) => c.status === 'linked').length
  const stopped = containers.filter(
    (c) => c.status !== 'running' && c.status !== 'linked',
  ).length

  const summaryParts = [`${running} 运行中`, `${stopped} 已停止`]
  if (linked > 0) summaryParts.push(`${linked} 已链接`)
  console.log(
    chalk.gray(`  ${containers.length} 个容器：${summaryParts.join(', ')}`),
  )
  console.log()

  // 如果存在容器，则先显示“容器”，否则先显示“创建”
  const hasContainers = containers.length > 0

  const choices: MenuChoice[] = [
    ...(hasContainers
      ? [
          { name: `${chalk.cyan('◉')} 容器`, value: 'list' },
          { name: `${chalk.green('+')} 创建容器`, value: 'create' },
        ]
      : [
          { name: `${chalk.green('+')} 创建容器`, value: 'create' },
          { name: `${chalk.cyan('◉')} 容器`, value: 'list' },
        ]),
    { name: `${chalk.magenta('↔')} 链接远程数据库`, value: 'link' },
    ...(hasContainers
      ? [{ name: `${chalk.magenta('⊞')} 端口`, value: 'ports' }]
      : []),
    new inquirer.Separator(),
    { name: `${chalk.yellow('⚙')} 设置`, value: 'settings' },
    // 仅当有新版本且自动检查已启用时显示更新选项
    ...(cachedUpdateResult?.updateAvailable
      ? [
          {
            name: `${chalk.green('↑')} 更新至 v${cachedUpdateResult.latestVersion}`,
            value: 'update',
          },
        ]
      : []),
    { name: `${chalk.gray('⎋')} 退出`, value: 'exit' },
    new inquirer.Separator(),
  ]

  // 若未设置图标模式（或设置了 PERSISTENT_HINT 环境变量），则在菜单下方显示持续提示
  const showHint = process.env.PERSISTENT_HINT === 'true' || !iconModeSet
  const hintText =
    process.env.PERSISTENT_HINT_TEXT || '提示：在“设置”中选择图标样式'

  // 使用 BottomBar 在提示下方显示提示（包括滚动指示器下方）
  const bottomBar = showHint ? new inquirer.ui.BottomBar() : null
  if (bottomBar) {
    bottomBar.updateBottomBar(chalk.gray(`  ${hintText}\n`))
  }

  let action: string
  try {
    const result = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: '您想执行什么操作？',
        choices,
        pageSize: getPageSize(),
      },
    ])
    action = result.action
  } finally {
    // 清理底部栏
    if (bottomBar) {
      bottomBar.updateBottomBar('')
    }
  }

  switch (action) {
    case 'create': {
      const result = await handleCreate()
      // 如果返回了容器名称，则导航到其子菜单
      if (result && result !== 'main') {
        await showContainerSubmenu(result, showMainMenu)
      }
      break
    }
    case 'list':
      await handleList(showMainMenu)
      break
    case 'link':
      await handleLink()
      break
    case 'ports':
      await handlePorts()
      break
    case 'settings':
      await handleSettings()
      break
    case 'update':
      await handleUpdate()
      break
    case 'exit':
      console.log(chalk.gray('\n  再见！\n'))
      process.exit(0)
  }
}

async function handleLink(): Promise<void> {
  const result = await handleLinkRemote()
  if (result) {
    await showContainerSubmenu(result, showMainMenu)
  }
}

async function handlePorts(): Promise<void> {
  console.clear()
  console.log(header('端口'))
  console.log()

  const containers = await containerManager.list()

  if (containers.length === 0) {
    console.log(chalk.gray('  未找到容器。'))
    console.log()
    await pressEnterToContinue()
    return
  }

  const results = await Promise.all(
    containers.map(async (config) => {
      const { status, ports } = await getContainerPorts(config)
      return { config, status, ports }
    }),
  )

  // 仅显示有端口的容器（跳过基于文件的数据库）
  const withPorts = results.filter((r) => r.ports.length > 0)

  if (withPorts.length === 0) {
    console.log(chalk.gray('  未找到基于端口的容器。'))
    console.log()
    await pressEnterToContinue()
    return
  }

  console.log(
    chalk.gray('  ') +
      chalk.bold.white('名称'.padEnd(22)) +
      chalk.bold.white('引擎'.padEnd(18)) +
      chalk.bold.white('端口'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(66)))

  for (const { config, status, ports } of withPorts) {
    const engineIcon = getEngineIcon(config.engine)
    const engineName = config.engine.padEnd(13)

    const parts = ports.map((p, i) =>
      i === 0 ? String(p.port) : `${p.port} ${chalk.gray(`(${p.label})`)}`,
    )
    const portDisplay = parts.join(chalk.gray(', '))

    const statusIndicator =
      status === 'running' ? chalk.green('●') : chalk.gray('○')

    console.log(
      chalk.gray('  ') +
        statusIndicator +
        ' ' +
        chalk.cyan(config.name.padEnd(20)) +
        engineIcon +
        chalk.white(engineName) +
        portDisplay,
    )
  }

  console.log()
  await pressEnterToContinue()
}

async function handleUpdate(): Promise<void> {
  console.clear()
  console.log(header('更新 SpinDB'))
  console.log()

  if (!cachedUpdateResult) {
    console.log(uiError('暂无更新信息'))
    await pressEnterToContinue()
    return
  }

  console.log(chalk.gray(`  当前版本：${cachedUpdateResult.currentVersion}`))
  console.log(
    chalk.gray(`  最新版本：${chalk.green(cachedUpdateResult.latestVersion)}`),
  )
  console.log()

  const spinner = createSpinner('正在更新 spindb...')
  spinner.start()

  const result = await updateManager.performUpdate()

  if (result.success) {
    spinner.succeed('更新完成')
    console.log()
    console.log(
      uiSuccess(`已从 ${result.previousVersion} 更新至 ${result.newVersion}`),
    )
    console.log()
    if (result.previousVersion !== result.newVersion) {
      console.log(uiWarning('请重启 spindb 以使用新版本。'))
      console.log()
    }
    // 清除缓存结果，使更新选项消失
    cachedUpdateResult = null
    updateCheckPromise = null
  } else {
    spinner.fail('更新失败')
    console.log()
    console.log(uiError(result.error || '未知错误'))
    console.log()
    const pm = await updateManager.detectPackageManager()
    console.log(
      chalk.gray(`  手动更新命令：${updateManager.getInstallCommand(pm)}`),
    )
  }

  await pressEnterToContinue()
}

export const menuCommand = new Command('menu')
  .description('管理容器的交互式菜单')
  .action(async () => {
    // 启用全局退出键处理 - 在任何地方按下退出键将返回主菜单
    // 同时处理 Ctrl+C 以优雅退出并显示告别信息
    enableGlobalEscape()

    // 循环运行菜单，以便退出后可以重新启动
    while (true) {
      try {
        await showMainMenu()
      } catch (error) {
        const e = error as Error

        // 如果按下了退出键，只需重新启动菜单
        if (
          error instanceof EscapeError ||
          checkAndResetEscape() ||
          e.message?.includes('prompt was closed')
        ) {
          continue
        }

        // 检查是否为缺失工具错误（优先使用类型化错误，回退到字符串匹配）
        let missingTool: string | null = null

        if (error instanceof MissingToolError) {
          missingTool = error.tool
        } else if (e.message) {
          // 对于可能抛出普通 Error 的旧调用方，使用正则提取工具名
          const toolMatch = e.message.match(/(\w+(?:-\w+)*)\s+not found/i)
          if (toolMatch) {
            missingTool = toolMatch[1]
          }
        }

        if (missingTool) {
          try {
            const installed = await promptInstallDependencies(missingTool)
            if (installed) {
              // 安装成功，继续菜单循环以便用户重试
              continue
            }
            // 安装失败或被拒绝
            process.exit(1)
          } catch (installError) {
            // 用户在安装提示期间按了退出键 - 视为拒绝
            if (
              installError instanceof EscapeError ||
              (installError as Error).message?.includes('prompt was closed')
            ) {
              continue
            }
            throw installError
          }
        }

        console.error(uiError(e.message))
        process.exit(1)
      }
    }
  })
