import inquirer from 'inquirer'
import inquirerAutocomplete from 'inquirer-autocomplete-prompt'
import chalk from 'chalk'

// 注册自动补全提示类型
inquirer.registerPrompt('autocomplete', inquirerAutocomplete)
import ora from 'ora'
import { existsSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { listEngines, getEngine } from '../../engines'
import {
  getDeprecatedVersions,
  getAvailableVersions,
} from '../../core/hostdb-metadata'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { portManager } from '../../core/port-manager'
import { containerManager } from '../../core/container-manager'
import { getEngineDependencies } from '../../config/os-dependencies'
import { getEngineIcon, getPageSize } from '../constants'
import {
  BACKUP_FORMATS,
  supportsFormatChoice,
  getDefaultFormat,
} from '../../config/backup-formats'
import {
  type ContainerConfig,
  type Engine,
  type BackupFormatType,
} from '../../types'

// 用于菜单导航的哨兵值
export const BACK_VALUE = '__back__'
export const MAIN_MENU_VALUE = '__main__'
export const ESCAPE_VALUE = '__escape__'
export const TOGGLE_PREFIX = '__toggle__:'

// 全局退出键处理状态
let globalEscapeEnabled = false
let escapeTriggered = false
let escapeReject: ((error: Error) => void) | null = null
// 存储原始 UI 对象，以便动态访问 activePrompt
// （由于异步初始化，activePrompt 在捕获时可能尚未设置）
let currentPromptUi: Record<string, unknown> | null = null

// 切换处理状态（Shift+Tab 切换容器的启动/停止）
let toggleEnabled = false
// 作为有效切换目标的值的集合（容器名称）
let toggleValidTargets: Set<string> = new Set()

// 退出键自定义错误类
export class EscapeError extends Error {
  constructor() {
    super('按下退出键')
    this.name = 'EscapeError'
  }
}

// 切换（Shift+Tab）自定义错误类
export class ToggleError extends Error {
  targetValue: string
  constructor(targetValue: string) {
    super('按下切换键')
    this.name = 'ToggleError'
    this.targetValue = targetValue
  }
}

// 模块作用域的 stdin 数据处理函数，用于检测退出键和特殊按键
// 在模块作用域定义，以便 disableGlobalEscape() 可以移除它
function onEscapeData(data: Buffer): void {
  // Ctrl+C 为字节 3 — 处理优雅退出
  if (data.length === 1 && data[0] === 3) {
    console.log(chalk.gray('\n  再见！\n'))
    process.exit(0)
  }

  // 处理多字节退出序列（方向键、Shift+Tab）
  // 以 ESC (27) 开头，后跟 '[' (91) 和一个字母
  if (data.length === 3 && data[0] === 27 && data[1] === 91) {
    const keyCode = data[2]

    // Shift+Tab: \x1b[Z (27, 91, 90)
    // 访问 inquirer 内部状态以获取当前高亮的值
    if (keyCode === 90 && toggleEnabled && currentPromptUi) {
      try {
        // 动态访问 activePrompt（捕获时可能尚未设置）
        // inquirer-autocomplete-prompt 使用 'selected' 作为光标索引
        // 并使用 currentChoices.getChoice(index) 获取选项对象
        const activePrompt = currentPromptUi.activePrompt as
          | {
              selected?: number
              currentChoices?: {
                getChoice?: (
                  index: number,
                ) => { value?: string; type?: string } | undefined
              }
            }
          | undefined

        if (
          activePrompt?.currentChoices?.getChoice &&
          activePrompt.selected !== undefined
        ) {
          const currentChoice = activePrompt.currentChoices.getChoice(
            activePrompt.selected,
          )

          // 检查高亮项是否为有效的切换目标（容器）
          // 跳过分隔符（type === 'separator'）和非容器项
          if (
            currentChoice &&
            currentChoice.value &&
            currentChoice.type !== 'separator' &&
            toggleValidTargets.has(currentChoice.value)
          ) {
            // 通过 reject 中断当前提示，并传递容器值以进行切换
            if (escapeReject) {
              const reject = escapeReject
              escapeReject = null
              reject(new ToggleError(currentChoice.value))
            }

            // 关闭提示 UI
            if (typeof currentPromptUi.close === 'function') {
              try {
                currentPromptUi.close()
              } catch {
                // 吞掉来自 inquirer 内部的错误
              }
              currentPromptUi = null
            }
          }
        }
      } catch {
        // 忽略访问 inquirer 内部状态时的错误 — 在过滤或其他操作期间，提示状态可能不一致
      }
      return
    }

    return // 不将其他转义序列作为独立的退出键处理
  }

  // 单独的退出键是字节 27 (0x1b)
  // 方向键和其他序列以 27 开头，但包含更多字节
  if (data.length === 1 && data[0] === 27) {
    escapeTriggered = true
    // 首先 reject 退出 Promise 以中断提示
    if (escapeReject) {
      const reject = escapeReject
      escapeReject = null
      reject(new EscapeError())
    }
    // 然后关闭提示 UI，阻止其继续渲染
    // 在 reject 之后执行，以便错误首先传播
    // 使用 try/catch 包裹，因为 inquirer 内部 API 可能随版本变化
    if (currentPromptUi && typeof currentPromptUi.close === 'function') {
      try {
        currentPromptUi.close()
      } catch {
        // 吞掉来自 inquirer 内部的错误 — close() 的行为可能变化
      }
      currentPromptUi = null
    }
    // 清屏
    console.clear()
  }
}

/**
 * 为交互式菜单启用全局退出键处理。
 * 按下退出键时，当前提示被关闭，escapeTriggered 标志被设置。
 * 在交互式菜单会话开始时调用一次。
 */
export function enableGlobalEscape(): void {
  if (globalEscapeEnabled) return
  globalEscapeEnabled = true
  process.stdin.on('data', onEscapeData)
}

/**
 * 禁用全局退出键处理并清理状态。
 * 退出交互模式时或在测试中移除此 stdin 监听器时调用。
 */
export function disableGlobalEscape(): void {
  if (!globalEscapeEnabled) return
  process.stdin.off('data', onEscapeData)
  globalEscapeEnabled = false
  escapeTriggered = false
  escapeReject = null
  currentPromptUi = null
}

/**
 * 检查退出键是否被触发并重置标志。
 * 在主菜单开始时调用，以便从任何位置处理退出。
 */
export function checkAndResetEscape(): boolean {
  const wasTriggered = escapeTriggered
  escapeTriggered = false
  return wasTriggered
}

/**
 * 为容器列表启用切换跟踪。
 * @param validTargets - 作为有效切换目标（容器名称）的值的集合
 */
export function enableToggleTracking(validTargets: Set<string>): void {
  toggleEnabled = true
  toggleValidTargets = validTargets
}

/**
 * 禁用切换跟踪并清理状态。
 */
export function disableToggleTracking(): void {
  toggleEnabled = false
  toggleValidTargets = new Set()
}

/**
 * 对 inquirer.prompt 的包装，向全局退出处理器注册/取消注册。
 * 需要退出键支持时，请使用此函数，而不是直接调用 inquirer.prompt()。
 *
 * 自动检测非交互模式（管道输入、脚本、CI），并抛出清晰的错误，
 * 而不是在永远无法获得的用户输入上挂起。
 */
export async function escapeablePrompt<T extends Record<string, unknown>>(
  questions: Parameters<typeof inquirer.prompt>[0],
): Promise<T> {
  // 检测非交互模式（管道输入、脚本、CI 环境）
  if (!process.stdin.isTTY) {
    throw new Error(
      '无法在非交互模式下进行提示。请使用适当的标志（--force、--yes、--json）或提供必需的参数。',
    )
  }

  // 创建一个在按下退出键时 reject 的 Promise
  const escapePromise = new Promise<never>((_, reject) => {
    escapeReject = reject
  })

  try {
    const p = inquirer.prompt(questions)
    // 注册提示 UI，以便在退出时关闭
    // 使用运行时守卫安全地访问 inquirer 内部的 ui 属性，
    // 该属性可能会随版本变化。
    // 针对 inquirer@9.3.7 验证 — 提示对象暴露一个 .ui 属性，
    // 该属性包含一个 .close() 方法用于程序化终止提示。
    const promptWithUi = p as unknown as Record<string, unknown>
    if (
      promptWithUi.ui &&
      typeof promptWithUi.ui === 'object' &&
      promptWithUi.ui !== null &&
      typeof (promptWithUi.ui as Record<string, unknown>).close === 'function'
    ) {
      currentPromptUi = promptWithUi.ui as Record<string, unknown>
    } else {
      currentPromptUi = null
    }

    // 让提示与退出 Promise 竞速
    const result = (await Promise.race([p, escapePromise])) as T
    return result
  } finally {
    escapeReject = null
    currentPromptUi = null
  }
}

/**
 * 自动补全选项的类型 — 必须包含 name 和 value
 */
export type FilterableChoice = {
  name: string
  value: string
  short?: string
}

/**
 * 使用 inquirer-autocomplete-prompt 的可过滤列表提示。
 * 允许输入以过滤项目，同时仍可使用方向键导航。
 *
 * @param choices - 选项数组（可过滤的项目 + 导航项）
 * @param message - 提示消息
 * @param options.filterableCount - 开头可被过滤的项目数量
 *                                  （其余项目，如返回/分隔符，始终显示）
 * @param options.pageSize - 一次显示的项目数量
 * @param options.emptyText - 过滤无匹配时显示的文本
 * @param options.enableToggle - 启用 Shift+Tab 切换项目（返回 TOGGLE_PREFIX + 值）
 */
export async function filterableListPrompt(
  choices: (FilterableChoice | inquirer.Separator)[],
  message: string,
  options: {
    filterableCount: number
    pageSize?: number
    emptyText?: string
    enableToggle?: boolean
    defaultValue?: string // 预选此值（光标从此处开始）
    headerItems?: (FilterableChoice | inquirer.Separator)[] // 显示在可过滤项上方
  },
): Promise<string> {
  // 将选项拆分为可过滤项和静态页脚（分隔符、返回按钮等）
  const filterableItems = choices.slice(
    0,
    options.filterableCount,
  ) as FilterableChoice[]
  const footerItems = choices.slice(options.filterableCount)

  // 如有需要，启用切换跟踪
  // 构建有效切换目标的集合（来自可过滤项的容器值）
  if (options.enableToggle) {
    const validTargets = new Set(filterableItems.map((item) => item.value))
    enableToggleTracking(validTargets)
  }

  // 自动补全的源函数 — 根据输入过滤项目
  const header = options.headerItems || []
  async function source(
    _answers: Record<string, unknown>,
    input: string | undefined,
  ): Promise<(FilterableChoice | inquirer.Separator)[]> {
    const searchTerm = (input || '').toLowerCase().trim()

    let result: (FilterableChoice | inquirer.Separator)[]

    if (!searchTerm) {
      // 无过滤 — 显示所有项目
      result = [...header, ...filterableItems, ...footerItems]
    } else {
      // 通过将搜索词与显示名称进行匹配来过滤项目
      // 去除 ANSI 代码以进行匹配，但保留它们以用于显示
      // eslint-disable-next-line no-control-regex
      const ansiPattern = /\x1b\[[0-9;]*m/g
      const filtered = filterableItems.filter((item) => {
        // 去除 ANSI 转义码以进行匹配
        const plainName = item.name.replace(ansiPattern, '')
        return plainName.toLowerCase().includes(searchTerm)
      })

      if (filtered.length === 0) {
        // 无匹配 — 显示空消息和页脚
        result = [
          new inquirer.Separator(
            chalk.gray(options.emptyText || `没有与 "${input}" 匹配的项`),
          ),
          ...footerItems,
        ]
      } else {
        result = [...header, ...filtered, ...footerItems]
      }
    }

    return result
  }

  // 为退出键处理创建退出 Promise
  const escapePromise = new Promise<never>((_, reject) => {
    escapeReject = reject
  })

  try {
    const p = inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'selection',
        message,
        source,
        pageSize: options.pageSize || getPageSize(),
        emptyText: options.emptyText || '没有匹配项',
        suggestOnly: false,
        // 抑制默认的 "（使用方向键或键入以搜索）" 后缀，
        // 因为我们在消息中包含了自定义说明
        suffix: '',
        // 预选一个值（光标从此项开始）
        default: options.defaultValue,
      },
    ])

    // 注册提示 UI 以用于退出和切换处理
    // 存储原始 UI 对象，以便动态访问 activePrompt
    // （activePrompt 包含高亮项的 selected 和 currentChoices）
    const promptWithUi = p as unknown as Record<string, unknown>
    if (
      promptWithUi.ui &&
      typeof promptWithUi.ui === 'object' &&
      promptWithUi.ui !== null &&
      typeof (promptWithUi.ui as Record<string, unknown>).close === 'function'
    ) {
      currentPromptUi = promptWithUi.ui as Record<string, unknown>
    } else {
      currentPromptUi = null
    }

    const result = (await Promise.race([p, escapePromise])) as {
      selection: string
    }
    return result.selection
  } catch (error) {
    // 处理切换（Shift+Tab）— 返回特殊值以便调用者处理
    if (error instanceof ToggleError) {
      return TOGGLE_PREFIX + error.targetValue
    }
    throw error
  } finally {
    escapeReject = null
    currentPromptUi = null
    if (options.enableToggle) {
      disableToggleTracking()
    }
  }
}

/**
 * 检查提示结果是否表示按下了退出键
 */
export function wasEscapePressed(result: unknown): boolean {
  if (typeof result === 'string') return result === ESCAPE_VALUE
  if (typeof result === 'object' && result !== null) {
    return Object.values(result).some((v) => v === ESCAPE_VALUE)
  }
  return false
}

/**
 * 提示输入容器名称
 * @param defaultName - 容器名称的默认值
 * @param options.allowBack - 允许空输入以返回（返回 null）
 */
export function promptContainerName(
  defaultName?: string,
  options?: { allowBack?: false },
): Promise<string>
export function promptContainerName(
  defaultName: string | undefined,
  options: { allowBack: true },
): Promise<string | null>
export async function promptContainerName(
  defaultName?: string,
  options?: { allowBack?: boolean },
): Promise<string | null> {
  const { name } = await escapeablePrompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: '容器名称：',
      default: options?.allowBack ? undefined : defaultName,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // 允许空值以返回
        if (!input) return '名称为必填项'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return '名称必须以字母开头，且只能包含字母、数字、连字符和下划线'
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !name) return null
  return name
}

/**
 * 提示选择数据库引擎
 * @param options.includeBack - 包含返回/主菜单导航选项
 * @returns 引擎名称，或用于导航的 BACK_VALUE/MAIN_MENU_VALUE
 */
export async function promptEngine(options?: {
  includeBack?: boolean
}): Promise<string> {
  const engines = listEngines()

  // 获取每个引擎的可用版本和已弃用版本（单次 databases.json 获取，已缓存）
  const nonDeprecatedMajors = new Map<string, string[]>()
  await Promise.all(
    engines.map(async (e) => {
      try {
        const [available, deprecated] = await Promise.all([
          getAvailableVersions(e.name),
          getDeprecatedVersions(e.name),
        ])
        if (!available || deprecated.size === 0) return
        // 按主版本对可用版本进行分组，保留至少有一个非弃用版本的主版本
        const kept = e.supportedVersions.filter((major) => {
          const versionsUnderMajor = available.filter((v) =>
            v.startsWith(`${major}.`),
          )
          return versionsUnderMajor.some((v) => !deprecated.has(v))
        })
        if (kept.length < e.supportedVersions.length) {
          nonDeprecatedMajors.set(e.name, kept)
        }
      } catch {
        // 静默忽略 — 如果获取失败，显示所有版本
      }
    }),
  )

  const engineChoices: FilterableChoice[] = engines.map((e) => {
    const displayVersions =
      nonDeprecatedMajors.get(e.name) ?? e.supportedVersions
    return {
      name: `${getEngineIcon(e.name)} ${e.displayName} ${chalk.gray(`（版本：${displayVersions.join(', ')}）`)}`,
      value: e.name,
      short: e.displayName,
    }
  })

  const footerChoices: (FilterableChoice | inquirer.Separator)[] = [
    new inquirer.Separator(),
    new inquirer.Separator(
      chalk.gray(`  ${engines.length} 个引擎 — 输入以过滤`),
    ),
  ]

  if (options?.includeBack) {
    footerChoices.push(new inquirer.Separator())
    footerChoices.push({
      name: `${chalk.blue('←')} 返回`,
      value: BACK_VALUE,
    })
    footerChoices.push({
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: MAIN_MENU_VALUE,
    })
  }

  footerChoices.push(new inquirer.Separator())

  const allChoices = [...engineChoices, ...footerChoices]

  const engine = await filterableListPrompt(allChoices, '选择数据库引擎：', {
    filterableCount: engineChoices.length,
    pageSize: getPageSize(),
    emptyText: '没有匹配过滤条件的引擎',
  })

  return engine
}

/**
 * 提示输入数据库版本
 * 两步选择：首先选择主版本，然后选择特定的次要版本（如果可用）
 * @param options.includeBack - 包含返回/主菜单导航选项
 * @returns 版本字符串，或用于导航的 BACK_VALUE/MAIN_MENU_VALUE
 */
export async function promptVersion(
  engineName: string,
  options?: { includeBack?: boolean; showDeprecated?: boolean },
): Promise<string> {
  const engine = getEngine(engineName)
  const majorVersions = engine.supportedVersions

  // 带加载指示器获取可用版本和弃用信息
  const spinner = ora({
    text: '正在获取可用版本...',
    color: 'cyan',
  }).start()

  let availableVersions: Record<string, string[]>
  let deprecatedVersions: Set<string> = new Set()
  try {
    const [versions, deprecated] = await Promise.all([
      engine.fetchAvailableVersions(),
      getDeprecatedVersions(engineName),
    ])
    availableVersions = versions
    deprecatedVersions = deprecated
    spinner.stop()
  } catch {
    spinner.stop()
    // 回退到仅主版本
    availableVersions = {}
    for (const v of majorVersions) {
      availableVersions[v] = []
    }
  }

  // 第 1 步：选择主版本
  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  const majorChoices: Choice[] = []
  // supportedVersions 中的第一个条目是引擎自身格式的最新主版本
  // （PG 为 1 部分，MySQL/MongoDB 等为 2 部分）。来自
  // hostdb 驱动包装器，因此它会自动保持最新。
  const latestMajor = majorVersions[0]
  let hiddenDeprecatedCount = 0

  for (let i = 0; i < majorVersions.length; i++) {
    const major = majorVersions[i]
    const fullVersions = availableVersions[major] || []
    const versionCount = fullVersions.length
    const isLatestMajor = major === latestMajor
    const allDeprecated =
      fullVersions.length > 0 &&
      fullVersions.every((v) => deprecatedVersions.has(v))

    // 隐藏所有版本均已弃用的主版本，除非设置了 --show-deprecated
    // TODO：如果引擎的所有主版本均已弃用，majorChoices 将为空。
    // 添加回退以重新包含弃用版本，以便选择器不为空。
    // 仅影响交互式向导 — CLI `spindb create --version` 会绕过此限制。
    if (allDeprecated && !options?.showDeprecated) {
      hiddenDeprecatedCount++
      continue
    }

    const countLabel =
      versionCount > 0 ? chalk.gray(`（${versionCount} 个版本）`) : ''
    const deprecatedLabel = allDeprecated ? chalk.yellow(' [已弃用]') : ''
    const label = isLatestMajor
      ? `${engine.displayName} ${major} ${countLabel} ${chalk.green('← 最新')}`
      : `${engine.displayName} ${major} ${countLabel}${deprecatedLabel}`

    majorChoices.push({
      name: label,
      value: major,
      short: `${engine.displayName} ${major}`,
    })
  }

  // 显示关于隐藏弃用版本的提示
  if (hiddenDeprecatedCount > 0) {
    majorChoices.push(new inquirer.Separator())
    majorChoices.push(
      new inquirer.Separator(
        chalk.gray(`  已隐藏 ${hiddenDeprecatedCount} 个弃用版本`),
      ),
    )
  }

  if (options?.includeBack) {
    majorChoices.push(new inquirer.Separator())
    majorChoices.push({ name: `${chalk.blue('←')} 返回`, value: BACK_VALUE })
    majorChoices.push({
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: MAIN_MENU_VALUE,
    })
  }

  const { majorVersion } = await escapeablePrompt<{ majorVersion: string }>([
    {
      type: 'list',
      name: 'majorVersion',
      message: '选择主版本：',
      choices: majorChoices,
      default: latestMajor, // 默认为最新主版本
    },
  ])

  // 处理导航（包括退出键）
  if (
    majorVersion === ESCAPE_VALUE ||
    majorVersion === BACK_VALUE ||
    majorVersion === MAIN_MENU_VALUE
  ) {
    return majorVersion === ESCAPE_VALUE ? MAIN_MENU_VALUE : majorVersion
  }

  // 第 2 步：在主版本中选择特定版本
  const minorVersions = availableVersions[majorVersion] || []

  if (minorVersions.length === 0) {
    // 未获取到版本，返回主版本（将使用回退）
    return majorVersion
  }

  const minorChoices: Choice[] = minorVersions.map((v, i) => {
    const isDeprecated = deprecatedVersions.has(v)
    const deprecatedTag = isDeprecated ? chalk.yellow(' [已弃用]') : ''
    const latestTag = i === 0 ? ` ${chalk.green('← 最新')}` : ''
    return {
      name: `${v}${latestTag}${deprecatedTag}`,
      value: v,
      short: v,
    }
  })

  if (options?.includeBack) {
    minorChoices.push(new inquirer.Separator())
    minorChoices.push({
      name: `${chalk.blue('←')} 返回主版本列表`,
      value: BACK_VALUE,
    })
    minorChoices.push({
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: MAIN_MENU_VALUE,
    })
  }

  const { version } = await escapeablePrompt<{ version: string }>([
    {
      type: 'list',
      name: 'version',
      message: `选择 ${engine.displayName} ${majorVersion} 版本：`,
      choices: minorChoices,
      default: minorVersions[0], // 默认为最新
    },
  ])

  // 处理次要版本选择中的导航（包括退出键）
  if (version === ESCAPE_VALUE) {
    return MAIN_MENU_VALUE
  }
  if (version === BACK_VALUE) {
    // 返回主版本选择（递归调用）
    return promptVersion(engineName, options)
  }
  if (version === MAIN_MENU_VALUE) {
    return MAIN_MENU_VALUE
  }

  return version
}

/**
 * 带冲突检测的端口提示
 * @param defaultPort - 默认端口号
 * @param engine - 用于查找端口范围的引擎名称
 */
export async function promptPort(
  defaultPort: number = defaults.port,
  engine?: string,
): Promise<number> {
  // 获取引擎特定的端口范围
  const portRange = engine
    ? getEngineDefaults(engine).portRange
    : defaults.portRange

  // 获取运行中容器的端口以进行冲突检测
  // 已停止的容器不会阻止端口 — 用户可以自行管理冲突
  const existingContainers = await containerManager.list()
  const containerPorts = new Map<number, string>()
  for (const c of existingContainers) {
    if (c.port > 0 && c.status === 'running') {
      containerPorts.set(c.port, c.name)
    }
  }

  // 检查默认端口是否存在冲突，并找到更好的默认值
  let suggestedPort = defaultPort
  const defaultPortContainer = containerPorts.get(defaultPort)
  const defaultPortInUse =
    !defaultPortContainer && !(await portManager.isPortAvailable(defaultPort))

  if (defaultPortContainer || defaultPortInUse) {
    // 在引擎的端口范围内查找下一个可用端口
    try {
      const result = await portManager.findAvailablePortExcludingContainers({
        preferredPort: defaultPort,
        portRange,
      })
      suggestedPort = result.port
    } catch {
      // 如果没有可用端口，回退到默认值
      suggestedPort = defaultPort
    }
  }

  const { port } = await escapeablePrompt<{ port: number }>([
    {
      type: 'input',
      name: 'port',
      message: '端口：',
      default: String(suggestedPort),
      validate: (input: string) => {
        const num = parseInt(input, 10)
        if (isNaN(num) || num < 1 || num > 65535) {
          return '端口必须是 1 到 65535 之间的数字'
        }
        return true
      },
      filter: (input: string) => parseInt(input, 10),
    },
  ])

  // 选择后检查冲突
  const conflictContainer = containerPorts.get(port)
  if (conflictContainer) {
    console.log()
    console.log(
      chalk.yellow(
        `  ⚠ 警告：端口 ${port} 已分配给容器 "${conflictContainer}"`,
      ),
    )
    console.log(chalk.gray('    一次只能有一个容器在此端口上运行。'))
    console.log()

    const { proceed } = await escapeablePrompt<{ proceed: string }>([
      {
        type: 'list',
        name: 'proceed',
        message: '你想做什么？',
        choices: [
          { name: `仍然使用端口 ${port}`, value: 'continue' },
          { name: '选择其他端口', value: 'retry' },
        ],
      },
    ])

    if (proceed === 'retry') {
      return promptPort(defaultPort, engine)
    }
  } else {
    // 检查端口是否被其他程序占用
    const portAvailable = await portManager.isPortAvailable(port)
    if (!portAvailable) {
      console.log()
      console.log(chalk.yellow(`  ⚠ 警告：端口 ${port} 当前正在使用中`))
      console.log(
        chalk.gray('    容器将被创建，但可能无法启动，直到该端口被释放。'),
      )
      console.log()

      const { proceed } = await escapeablePrompt<{ proceed: string }>([
        {
          type: 'list',
          name: 'proceed',
          message: '你想做什么？',
          choices: [
            { name: `仍然使用端口 ${port}`, value: 'continue' },
            { name: '选择其他端口', value: 'retry' },
          ],
        },
      ])

      if (proceed === 'retry') {
        return promptPort(defaultPort, engine)
      }
    }
  }

  return port
}

// 使用箭头键选择的确认提示
export async function promptConfirm(
  message: string,
  defaultValue: boolean = true,
): Promise<boolean> {
  const { confirmed } = await escapeablePrompt<{ confirmed: string }>([
    {
      type: 'list',
      name: 'confirmed',
      message,
      choices: [
        { name: '是', value: 'yes' },
        { name: '否', value: 'no' },
      ],
      default: defaultValue ? 'yes' : 'no',
    },
  ])

  return confirmed === 'yes'
}

/**
 * 从列表中提示选择容器，支持键入过滤
 * @param containers - 可供选择的容器列表
 * @param message - 提示消息
 * @param options - 可选设置
 * @param options.includeBack - 包含返回/主菜单导航选项（选中时返回 null）
 */
export async function promptContainerSelect(
  containers: ContainerConfig[],
  message: string = '选择容器：',
  options: { includeBack?: boolean } = {},
): Promise<string | null> {
  if (containers.length === 0) {
    return null
  }

  // 构建可过滤的容器选项
  const containerChoices: FilterableChoice[] = containers.map((c) => ({
    name: `${c.name} ${chalk.gray(`（${getEngineIcon(c.engine)}${c.engine} ${c.version}，端口 ${c.port}）`)} ${
      c.status === 'running' ? chalk.green('● 运行中') : chalk.gray('○ 已停止')
    }`,
    value: c.name,
    short: c.name,
  }))

  // 构建带导航选项的页脚
  const footerChoices: (FilterableChoice | inquirer.Separator)[] = []
  if (options.includeBack) {
    footerChoices.push(new inquirer.Separator())
    footerChoices.push({ name: `${chalk.blue('←')} 返回`, value: BACK_VALUE })
    footerChoices.push({
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: MAIN_MENU_VALUE,
    })
    footerChoices.push(new inquirer.Separator())
  }

  const allChoices = [...containerChoices, ...footerChoices]

  const container = await filterableListPrompt(allChoices, message, {
    filterableCount: containerChoices.length,
    pageSize: getPageSize(),
    emptyText: '没有匹配过滤条件的容器',
  })

  // 处理导航（包括退出键）
  if (
    container === ESCAPE_VALUE ||
    container === BACK_VALUE ||
    container === MAIN_MENU_VALUE
  ) {
    return null
  }

  return container
}

/**
 * 将字符串清理为有效的数据库名称
 * 将无效字符替换为下划线
 */
function sanitizeDatabaseName(name: string): string {
  // 将无效字符替换为下划线
  // 注意：连字符被排除，因为它们在 SQL 中需要引号
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_')
  // 确保以字母或下划线开头
  if (sanitized && !/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = '_' + sanitized
  }
  // 合并多个连续的下划线
  sanitized = sanitized.replace(/_+/g, '_')
  // 去除末尾的下划线
  sanitized = sanitized.replace(/_+$/, '')
  // 如果结果为空（例如输入为 "---"），使用回退值
  if (!sanitized) {
    sanitized = 'db'
  }
  return sanitized
}

/**
 * 提示输入数据库名称
 * @param defaultName - 数据库名称的默认值
 * @param engine - 数据库引擎（mysql 显示 "schema" 术语）
 * @param options.allowBack - 允许空输入以返回（返回 null）
 * @param options.existingDatabases - 用于上下文的现有数据库名称列表
 * @param options.disallowExisting - 验证名称不在 existingDatabases 中
 */
export function promptDatabaseName(
  defaultName?: string,
  engine?: string,
  options?: {
    allowBack?: false
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string>
export function promptDatabaseName(
  defaultName: string | undefined,
  engine: string | undefined,
  options: {
    allowBack: true
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string | null>
export async function promptDatabaseName(
  defaultName?: string,
  engine?: string,
  options?: {
    allowBack?: boolean
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string | null> {
  // MySQL 使用 "schema" 术语（数据库和 schema 同义）
  const baseLabel = engine === 'mysql' ? '数据库（schema）名称' : '数据库名称'

  // 清理默认名称以确保其有效
  const sanitizedDefault = defaultName
    ? sanitizeDatabaseName(defaultName)
    : undefined

  // 当 allowBack 为 true 时，在消息中显示默认值（因为无法使用 inquirer 的 default）
  const label =
    options?.allowBack && sanitizedDefault
      ? `${baseLabel} [${sanitizedDefault}]：`
      : `${baseLabel}：`

  const { database } = await escapeablePrompt<{ database: string }>([
    {
      type: 'input',
      name: 'database',
      message: label,
      default: options?.allowBack ? undefined : sanitizedDefault,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // 允许空值以返回
        if (!input) return '数据库名称为必填项'
        // PostgreSQL 数据库命名规则（也适用于 MySQL）
        // 排除连字符以避免在 SQL 中需要带引号的标识符
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input)) {
          return '数据库名称必须以字母或下划线开头，且只能包含字母、数字和下划线'
        }
        if (input.length > 63) {
          return '数据库名称不得超过 63 个字符'
        }
        if (
          options?.disallowExisting &&
          options.existingDatabases?.includes(input)
        ) {
          return `数据库 "${input}" 已存在。请选择其他名称。`
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !database) return null
  return database
}

/**
 * 提示从容器的数据库列表中选择一个数据库
 * @param options.includeBack - 包含返回选项（选中时返回 null）
 */
export function promptDatabaseSelect(
  databases: string[],
  message?: string,
  options?: { includeBack?: false },
): Promise<string>
export function promptDatabaseSelect(
  databases: string[],
  message: string | undefined,
  options: { includeBack: true },
): Promise<string | null>
export async function promptDatabaseSelect(
  databases: string[],
  message: string = '选择数据库：',
  options?: { includeBack?: boolean },
): Promise<string | null> {
  if (databases.length === 0) {
    throw new Error('没有可选择的数据库')
  }

  if (databases.length === 1 && !options?.includeBack) {
    return databases[0]
  }

  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  const choices: Choice[] = databases.map((db, index) => ({
    name: index === 0 ? `${db} ${chalk.gray('（主库）')}` : db,
    value: db,
    short: db,
  }))

  if (options?.includeBack) {
    choices.push(new inquirer.Separator())
    choices.push({ name: `${chalk.blue('←')} 返回`, value: BACK_VALUE })
  }

  const { database } = await escapeablePrompt<{ database: string }>([
    {
      type: 'list',
      name: 'database',
      message,
      choices,
    },
  ])

  if (database === BACK_VALUE) return null
  return database
}

/**
 * 提示选择备份格式
 * 使用来自 config/backup-formats.ts 的集中式格式配置
 * 根据引擎特定的格式定义动态构建选项
 * @param options.includeBack - 包含返回选项（选中时返回 null）
 */
export function promptBackupFormat(
  engine: Engine,
  options?: { includeBack?: false },
): Promise<BackupFormatType>
export function promptBackupFormat(
  engine: Engine,
  options: { includeBack: true },
): Promise<BackupFormatType | null>
export async function promptBackupFormat(
  engine: Engine,
  options?: { includeBack?: boolean },
): Promise<BackupFormatType | null> {
  // 如果引擎不支持格式选择（例如 ClickHouse），返回默认值
  if (!supportsFormatChoice(engine)) {
    return getDefaultFormat(engine)
  }

  const engineFormats = BACKUP_FORMATS[engine]

  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  // 根据引擎的格式定义动态构建选项
  const choices: Choice[] = Object.entries(engineFormats.formats).map(
    ([key, info]) => ({
      name: `${info.label} ${chalk.gray(`- ${info.description}`)}`,
      value: key,
    }),
  )

  if (options?.includeBack) {
    choices.push(new inquirer.Separator())
    choices.push({ name: `${chalk.blue('←')} 返回`, value: BACK_VALUE })
  }

  const { format } = await escapeablePrompt<{ format: string }>([
    {
      type: 'list',
      name: 'format',
      message: '选择备份格式：',
      choices,
      default: engineFormats.defaultFormat,
    },
  ])

  if (format === BACK_VALUE) return null
  return format as BackupFormatType
}

/**
 * 提示选择备份输出目录
 * @returns 目录路径，如果取消则返回 null
 */
export async function promptBackupDirectory(): Promise<string | null> {
  const cwd = process.cwd()

  const { choice } = await escapeablePrompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message: '将备份保存在哪里？',
      choices: [
        {
          name: `${chalk.cyan('.')} 当前目录 ${chalk.gray(`（${cwd}）`)}`,
          value: 'cwd',
        },
        {
          name: `${chalk.yellow('...')} 选择其他目录`,
          value: 'custom',
        },
        new inquirer.Separator(),
        { name: `${chalk.blue('←')} 返回`, value: BACK_VALUE },
      ],
    },
  ])

  if (choice === BACK_VALUE) return null
  if (choice === 'cwd') return cwd

  const { customPath } = await escapeablePrompt<{ customPath: string }>([
    {
      type: 'input',
      name: 'customPath',
      message: '输入目录路径：',
      default: cwd,
      validate: (input: string) => {
        if (!input.trim()) return '目录路径为必填项'
        const resolved = resolve(input.replace(/^~/, process.env.HOME || ''))
        if (existsSync(resolved)) {
          if (!statSync(resolved).isDirectory()) {
            return '路径不是一个目录'
          }
        }
        // 如果目录不存在，将会被创建
        return true
      },
    },
  ])

  return resolve(customPath.replace(/^~/, process.env.HOME || ''))
}

/**
 * 提示输入备份文件名
 * @param options.allowBack - 允许空输入以返回（返回 null）
 */
export function promptBackupFilename(
  defaultName: string,
  options?: { allowBack?: false },
): Promise<string>
export function promptBackupFilename(
  defaultName: string,
  options: { allowBack: true },
): Promise<string | null>
export async function promptBackupFilename(
  defaultName: string,
  options?: { allowBack?: boolean },
): Promise<string | null> {
  // 当 allowBack 为 true 时，在消息中显示默认值
  const message = options?.allowBack
    ? `备份文件名 [${defaultName}]：`
    : '备份文件名：'

  const { filename } = await escapeablePrompt<{ filename: string }>([
    {
      type: 'input',
      name: 'filename',
      message,
      default: options?.allowBack ? undefined : defaultName,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // 允许空值以返回
        if (!input) return '文件名为必填项'
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return '文件名只能包含字母、数字、下划线和连字符'
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !filename) return null
  return filename
}

export type CreateOptions = {
  name: string
  engine: string
  version: string
  port: number
  database: string
  path?: string // SQLite 文件路径
}

/**
 * 提示基于文件的数据库（SQLite/DuckDB）的文件位置
 * 类似于 container-handlers.ts 中的 relocate 逻辑
 */
export async function promptFileDatabasePath(
  containerName: string,
  extension: string = '.sqlite',
): Promise<string | undefined> {
  const defaultPath = `./${containerName}${extension}`
  const dbType = extension === '.duckdb' ? 'DuckDB' : 'SQLite'

  console.log(chalk.gray(`  ${dbType} 数据库以文件形式存储在项目目录中。`))
  console.log(chalk.gray(`  默认路径：${defaultPath}`))
  console.log()

  const { useDefault } = await escapeablePrompt<{ useDefault: string }>([
    {
      type: 'list',
      name: 'useDefault',
      message: '应将数据库文件创建在哪里？',
      choices: [
        { name: `使用默认位置（${defaultPath}）`, value: 'default' },
        { name: '指定自定义路径', value: 'custom' },
      ],
    },
  ])

  if (useDefault === 'default') {
    return undefined // 使用默认值
  }

  const { inputPath } = await escapeablePrompt<{ inputPath: string }>([
    {
      type: 'input',
      name: 'inputPath',
      message: '文件路径：',
      default: defaultPath,
      validate: (input: string) => {
        if (!input) return '路径为必填项'
        return true
      },
    },
  ])

  // 将 ~ 展开为主目录
  let expandedPath = inputPath
  if (inputPath === '~') {
    expandedPath = homedir()
  } else if (inputPath.startsWith('~/')) {
    expandedPath = join(homedir(), inputPath.slice(2))
  }

  // 将相对路径转换为绝对路径
  if (!expandedPath.startsWith('/')) {
    expandedPath = resolve(process.cwd(), expandedPath)
  }

  // 检查路径看起来像文件（具有数据库扩展名）还是目录
  const hasDbExtension = /\.(sqlite3?|db|duckdb|ddb)$/i.test(expandedPath)

  // 视为目录的条件：
  // - 以 / 结尾
  // - 存在且是目录
  // - 没有数据库文件扩展名（假定是目录路径）
  const isDirectory =
    expandedPath.endsWith('/') ||
    (existsSync(expandedPath) && statSync(expandedPath).isDirectory()) ||
    !hasDbExtension

  let finalPath: string
  if (isDirectory) {
    // 如果存在尾部斜杠，则去除它，然后附加文件名
    const dirPath = expandedPath.endsWith('/')
      ? expandedPath.slice(0, -1)
      : expandedPath
    finalPath = join(dirPath, `${containerName}${extension}`)
  } else {
    finalPath = expandedPath
  }

  // 检查文件是否已存在
  if (existsSync(finalPath)) {
    console.log(chalk.yellow(`  警告：文件已存在：${finalPath}`))
    const { overwrite } = await escapeablePrompt<{ overwrite: string }>([
      {
        type: 'list',
        name: 'overwrite',
        message: '此位置已存在文件。你想做什么？',
        choices: [
          { name: '选择其他路径', value: 'different' },
          { name: '取消', value: 'cancel' },
        ],
      },
    ])

    if (overwrite === 'cancel') {
      throw new Error('创建已取消')
    }

    // 递归再次提示
    return promptFileDatabasePath(containerName, extension)
  }

  return finalPath
}

// 完整的交互式创建流程
export async function promptCreateOptions(promptOptions?: {
  showDeprecated?: boolean
}): Promise<CreateOptions> {
  console.log(chalk.cyan('\n  ▣  创建新数据库容器\n'))

  const engine = await promptEngine()
  const version = await promptVersion(engine, {
    showDeprecated: promptOptions?.showDeprecated,
  })
  const name = await promptContainerName()
  // Redis、Valkey 和 TigerBeetle 使用数字标识符 — 跳过提示
  const database =
    engine === 'redis' || engine === 'valkey' || engine === 'tigerbeetle'
      ? '0'
      : await promptDatabaseName(name, engine) // 默认为容器名称

  // 基于文件的数据库（SQLite/DuckDB）不需要端口，但需要路径
  let port = 0
  let path: string | undefined
  if (engine === 'sqlite') {
    path = await promptFileDatabasePath(name, '.sqlite')
  } else if (engine === 'duckdb') {
    path = await promptFileDatabasePath(name, '.duckdb')
  } else {
    const engineDefaults = getEngineDefaults(engine)
    port = await promptPort(engineDefaults.defaultPort, engine)
  }

  return { name, engine, version, port, database, path }
}

/**
 * 提示用户安装缺失的数据库客户端工具
 *
 * 所有引擎二进制文件（包括客户端工具）都与 hostdb 下载捆绑在一起。
 * 此函数引导用户使用 `spindb engines download <engine>` 而不是
 * 尝试通过系统包管理器安装。
 *
 * @param missingTool - 缺失工具的名称（例如 'psql', 'pg_dump', 'redis-cli'）
 * @param engine - 数据库引擎（默认为 'postgresql'）
 * @returns 始终返回 false（工具必须通过 `spindb engines download` 下载）
 */
export async function promptInstallDependencies(
  missingTool: string,
  engine: string = 'postgresql',
): Promise<boolean> {
  const engineDeps = getEngineDependencies(engine)
  const engineName = engineDeps?.displayName || engine

  console.log()
  console.log(chalk.yellow(`  数据库客户端工具 "${missingTool}" 未安装。`))
  console.log()
  console.log(
    chalk.cyan(
      `  ${engineName} 工具与来自 hostdb 的引擎二进制文件捆绑在一起。`,
    ),
  )
  console.log(
    chalk.cyan(`  使用以下命令下载：spindb engines download ${engine}`),
  )
  console.log()
  return false
}
