import chalk from 'chalk'
import inquirer from 'inquirer'
import { configManager } from '../../../core/config-manager'
import { updateManager } from '../../../core/update-manager'
import { escapeablePrompt } from '../../ui/prompts'
import { header, uiSuccess, uiInfo } from '../../ui/theme'
import {
  setCachedIconMode,
  ENGINE_BRAND_COLORS,
  getPageSize,
} from '../../constants'
import { hasAnyInstalledEngines } from '../../helpers'
import { Engine, type IconMode } from '../../../types'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { handleEngines } from './engine-handlers'
import { handleCheckUpdate, handleDoctor } from './update-handlers'

// 用于图标预览的示例引擎
const PREVIEW_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MongoDB,
  Engine.Redis,
  Engine.DuckDB,
]

/**
 * 生成特定模式下图标外观的预览行。
 */
function generatePreviewLine(mode: IconMode): string {
  if (mode === 'ascii') {
    const ASCII_ICONS: Record<Engine, string> = {
      [Engine.PostgreSQL]: '[PG]',
      [Engine.MySQL]: '[MY]',
      [Engine.MariaDB]: '[MA]',
      [Engine.SQLite]: '[SL]',
      [Engine.DuckDB]: '[DK]',
      [Engine.MongoDB]: '[MG]',
      [Engine.FerretDB]: '[FD]',
      [Engine.Redis]: '[RD]',
      [Engine.Valkey]: '[VK]',
      [Engine.ClickHouse]: '[CH]',
      [Engine.Qdrant]: '[QD]',
      [Engine.Meilisearch]: '[MS]',
      [Engine.CouchDB]: '[CD]',
      [Engine.CockroachDB]: '[CR]',
      [Engine.SurrealDB]: '[SR]',
      [Engine.QuestDB]: '[QS]',
      [Engine.TypeDB]: '[TB]',
      [Engine.InfluxDB]: '[IX]',
      [Engine.Weaviate]: '[WV]',
      [Engine.TigerBeetle]: '[TT]',
      [Engine.LibSQL]: '[LS]',
    }
    const icons = PREVIEW_ENGINES.map((engine) => {
      const icon = ASCII_ICONS[engine] || '[??]'
      const colors = ENGINE_BRAND_COLORS[engine]
      return chalk.bgHex(colors.background).hex(colors.foreground)(icon)
    })
    return icons.join(' ')
  }

  if (mode === 'nerd') {
    const NERD_ICONS: Record<Engine, string> = {
      [Engine.PostgreSQL]: '\ue76e',
      [Engine.MySQL]: '\ue704',
      [Engine.MariaDB]: '\ue828',
      [Engine.SQLite]: '\ue7c4',
      [Engine.DuckDB]: '\ueef7',
      [Engine.MongoDB]: '\ue7a4',
      [Engine.FerretDB]: '\uf06c',
      [Engine.Redis]: '\ue76d',
      [Engine.Valkey]: '\uf29f',
      [Engine.ClickHouse]: '\uf015',
      [Engine.Qdrant]: '\uf14e',
      [Engine.Meilisearch]: '\uf002',
      [Engine.CouchDB]: '\ue7a2',
      [Engine.CockroachDB]: '\ue269',
      [Engine.SurrealDB]: '\uedfe',
      [Engine.QuestDB]: '\ued2f',
      [Engine.TypeDB]: '\ue706',
      [Engine.InfluxDB]: '\udb85\udf95',
      [Engine.Weaviate]: '\uf0e8',
      [Engine.TigerBeetle]: '\uf0d6',
      [Engine.LibSQL]: '\ue7c4',
    }
    const icons = PREVIEW_ENGINES.map((engine) => {
      const icon = NERD_ICONS[engine] || '\ue706'
      const colors = ENGINE_BRAND_COLORS[engine]
      return chalk.hex(colors.background)(icon)
    })
    return icons.join(' ')
  }

  // Emoji 模式
  const EMOJI_ICONS: Record<Engine, string> = {
    [Engine.PostgreSQL]: '\u{1F418}',
    [Engine.MySQL]: '\u{1F42C}',
    [Engine.MariaDB]: '\u{1F9AD}',
    [Engine.SQLite]: '\u{1FAB6}',
    [Engine.DuckDB]: '\u{1F986}',
    [Engine.MongoDB]: '\u{1F343}',
    [Engine.FerretDB]: '\u{1F994}',
    [Engine.Redis]: '\u{1F534}',
    [Engine.Valkey]: '\u{1F537}',
    [Engine.ClickHouse]: '\u{1F3E0}',
    [Engine.Qdrant]: '\u{1F9ED}',
    [Engine.Meilisearch]: '\u{1F50D}',
    [Engine.CouchDB]: '\u{1F6CB}',
    [Engine.CockroachDB]: '\u{1FAB3}',
    [Engine.SurrealDB]: '\u{1F300}',
    [Engine.QuestDB]: '\u23F1',
    [Engine.TypeDB]: '\u{1F916}',
    [Engine.InfluxDB]: '\u{1F4C8}',
    [Engine.Weaviate]: '\u{1F52E}',
    [Engine.TigerBeetle]: '\u{1F42F}',
    [Engine.LibSQL]: '\u{1F4DA}',
  }
  const icons = PREVIEW_ENGINES.map((engine) => EMOJI_ICONS[engine] || '\u25A3')
  return icons.join(' ')
}

/**
 * 获取图标模式的显示名称，并包含当前选中指示器。
 */
function getIconModeDisplayName(
  mode: IconMode,
  currentMode: IconMode | undefined,
): string {
  const names: Record<IconMode, string> = {
    ascii: 'ASCII（彩色徽章）',
    nerd: 'Nerd Fonts',
    emoji: 'Emoji',
  }
  const name = names[mode]
  const isCurrent = mode === currentMode
  return isCurrent ? `${name} ${chalk.green('（当前）')}` : name
}

/**
 * 处理图标模式设置子菜单。
 */
async function handleIconModeSettings(): Promise<void> {
  const config = await configManager.getConfig()
  const currentMode = config.preferences?.iconMode

  console.clear()
  console.log()
  console.log(chalk.cyan('  ┌────────────────────────────┐'))
  console.log(chalk.cyan('  │     图标模式设置         │'))
  console.log(chalk.cyan('  └────────────────────────────┘'))
  console.log()
  console.log(chalk.gray('  选择数据库引擎图标在命令行中的显示方式。'))
  console.log()

  // 显示预览和指导
  console.log(chalk.bold('  预览：'))
  console.log()
  console.log(
    `    Nerd Fonts：${generatePreviewLine('nerd')} ${chalk.gray('（如果显示正确，推荐此项）')}`,
  )
  console.log(
    `    ASCII：     ${generatePreviewLine('ascii')} ${chalk.gray('（如果 Nerd Fonts 无法正常渲染，推荐此项）')}`,
  )
  console.log(
    `    Emoji：     ${generatePreviewLine('emoji')} ${chalk.gray('（不推荐 — 宽度不一致）')}`,
  )
  console.log()

  if (currentMode) {
    console.log(chalk.gray(`  当前模式：${currentMode}`))
    console.log()
  }

  const choices: MenuChoice[] = [
    {
      name: getIconModeDisplayName('nerd', currentMode),
      value: 'nerd',
    },
    {
      name: getIconModeDisplayName('ascii', currentMode),
      value: 'ascii',
    },
    {
      name: getIconModeDisplayName('emoji', currentMode),
      value: 'emoji',
    },
    new inquirer.Separator(),
    {
      name: `${chalk.blue('\u2190')} 返回`,
      value: 'back',
    },
  ]

  const { iconMode } = await escapeablePrompt<{ iconMode: string }>([
    {
      type: 'list',
      name: 'iconMode',
      message: '选择图标模式：',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (iconMode === 'back') {
    return
  }

  // 保存新模式
  if (!config.preferences) {
    config.preferences = {}
  }
  config.preferences.iconMode = iconMode as IconMode
  await configManager.save()
  setCachedIconMode(iconMode as IconMode)

  console.log()
  console.log(uiSuccess(`图标模式已设置为：${iconMode}`))
  console.log()
  await pressEnterToContinue()
}

/**
 * 处理更新检查设置子菜单。
 */
async function handleUpdateCheckSettings(): Promise<void> {
  const cached = await updateManager.getCachedUpdateInfo()
  const isEnabled = cached.autoCheckEnabled !== false // 默认为开启

  console.clear()
  console.log(header('更新检查设置'))
  console.log()
  console.log(chalk.gray('  控制 SpinDB 启动时是否检查更新。'))
  console.log()
  console.log(
    `  当前状态：${isEnabled ? chalk.green('已启用') : chalk.yellow('已禁用')}`,
  )
  console.log()

  const choices: MenuChoice[] = [
    {
      name: isEnabled ? `启用检查 ${chalk.green('（当前）')}` : '启用检查',
      value: 'enable',
    },
    {
      name: !isEnabled ? `禁用检查 ${chalk.green('（当前）')}` : '禁用检查',
      value: 'disable',
    },
    new inquirer.Separator(),
    {
      name: `${chalk.blue('\u2190')} 返回`,
      value: 'back',
    },
  ]

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '更新检查设置：',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (action === 'back') {
    return
  }

  const newEnabled = action === 'enable'
  await updateManager.setAutoCheckEnabled(newEnabled)

  console.log()
  if (newEnabled) {
    console.log(uiSuccess('启动时将检查更新'))
  } else {
    console.log(uiInfo('启动时将不再检查更新'))
    console.log(chalk.gray('  您仍可手动检查：spindb version --check'))
  }
  console.log()
  await pressEnterToContinue()
}

/**
 * 处理主设置菜单。
 * 可从主菜单或通过 `spindb config` / `spindb configure` 访问。
 */
export async function handleSettings(): Promise<void> {
  while (true) {
    const [config, hasEngines, cached] = await Promise.all([
      configManager.getConfig(),
      hasAnyInstalledEngines(),
      updateManager.getCachedUpdateInfo(),
    ])
    const currentIconMode = config.preferences?.iconMode || 'ascii'
    const updateCheckEnabled = cached.autoCheckEnabled !== false

    console.clear()
    console.log(header('设置'))
    console.log()

    const choices: MenuChoice[] = [
      {
        name: hasEngines
          ? `${chalk.magenta('⬢')} 管理引擎`
          : chalk.gray('⬢ 管理引擎'),
        value: 'engines',
        disabled: hasEngines ? false : '未安装任何引擎',
      },
      { name: `${chalk.red.bold('+')} 健康检查`, value: 'doctor' },
      { name: `${chalk.cyan('↑')} 检查更新`, value: 'check-update' },
      new inquirer.Separator(),
      {
        name: `图标模式：${chalk.cyan(currentIconMode)}`,
        value: 'icon-mode',
      },
      {
        name: `更新检查：${updateCheckEnabled ? chalk.green('已启用') : chalk.yellow('已禁用')}`,
        value: 'update-check',
      },
      new inquirer.Separator(),
      {
        name: `${chalk.blue('←')} 返回`,
        value: 'back',
      },
    ]

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: '您想配置什么？',
        choices,
        pageSize: getPageSize(),
      },
    ])

    switch (action) {
      case 'engines':
        await handleEngines()
        break
      case 'doctor':
        await handleDoctor()
        break
      case 'check-update':
        await handleCheckUpdate()
        break
      case 'icon-mode':
        await handleIconModeSettings()
        break
      case 'update-check':
        await handleUpdateCheckSettings()
        break
      case 'back':
        return
    }
  }
}
