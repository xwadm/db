/**
 * Doctor 命令 - 系统健康检查和诊断
 *
 * 检查项：
 * 1. 配置文件有效性
 * 2. 用户偏好设置（图标模式）
 * 3. 所有引擎的容器状态
 * 4. SQLite 注册表孤立条目
 * 5. DuckDB 注册表孤立条目
 * 6. 二进制/工具可用性
 * 7. 版本迁移（过时的容器版本）
 * 8. 孤立测试容器清理
 */

import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { configManager } from '../../core/config-manager'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import { paths } from '../../config/paths'
import { getSupportedEngines } from '../../config/engine-defaults'
import { checkEngineDependencies } from '../../core/dependency-manager'
import { header, uiSuccess } from '../ui/theme'
import { type Engine, isFileBasedEngine } from '../../types'
import {
  findOutdatedContainers,
  migrateContainerVersion,
  deleteOldBinaryIfUnused,
  type OutdatedContainer,
} from '../../core/version-migration'
import {
  findOrphanedTestContainers,
  deleteTestContainer,
} from '../../core/test-cleanup'

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

// 检查配置文件有效性
async function checkConfiguration(): Promise<HealthCheckResult> {
  const configPath = paths.config

  if (!existsSync(configPath)) {
    return {
      name: '配置',
      status: 'ok',
      message: '尚无配置文件（首次使用时将创建）',
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
        details: [`已缓存的二进制工具：${binaryCount}`],
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
      details: [`已缓存的二进制工具：${binaryCount}`],
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

// 检查用户偏好设置（图标模式等）
async function checkPreferences(): Promise<HealthCheckResult> {
  const configPath = paths.config

  if (!existsSync(configPath)) {
    return {
      name: '偏好设置',
      status: 'ok',
      message: '尚无配置文件（偏好设置将使用默认值）',
    }
  }

  try {
    const config = await configManager.load()

    // 检查是否设置了 preferences.iconMode
    if (!config.preferences?.iconMode) {
      return {
        name: '偏好设置',
        status: 'warning',
        message: '图标模式未配置（默认使用 ascii）',
        details: [
          '运行：spindb config 在设置菜单中设置您的偏好',
        ],
        action: {
          label: '将图标模式设置为 ascii（默认）',
          handler: async () => {
            const currentConfig = await configManager.load()
            currentConfig.preferences = {
              ...currentConfig.preferences,
              iconMode: 'ascii',
            }
            await configManager.save()
            console.log(uiSuccess('图标模式已设置为 ascii'))
          },
        },
      }
    }

    return {
      name: '偏好设置',
      status: 'ok',
      message: `图标模式：${config.preferences.iconMode}`,
    }
  } catch (error) {
    return {
      name: '偏好设置',
      status: 'error',
      message: '检查偏好设置失败',
      details: [(error as Error).message],
    }
  }
}

// 检查所有引擎的容器状态
async function checkContainers(): Promise<HealthCheckResult> {
  try {
    const containers = await containerManager.list()

    if (containers.length === 0) {
      return {
        name: '容器',
        status: 'ok',
        message: '无容器（请使用以下命令创建：spindb create）',
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
        return `${engine}：${counts.running} 个存在，${counts.stopped} 个缺失`
      }
      return `${engine}：${counts.running} 个运行中，${counts.stopped} 个已停止`
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
      message: '列出容器失败',
      details: [(error as Error).message],
    }
  }
}

// 检查 SQLite 注册表中的孤立条目
async function checkSqliteRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await sqliteRegistry.list()
    const ignoredFolders = await sqliteRegistry.listIgnoredFolders()

    if (entries.length === 0 && ignoredFolders.length === 0) {
      return {
        name: 'SQLite 注册表',
        status: 'ok',
        message: '未注册 SQLite 数据库',
      }
    }

    const orphans = await sqliteRegistry.findOrphans()

    if (orphans.length > 0) {
      const details = [
        ...orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        ...(ignoredFolders.length > 0
          ? [`${ignoredFolders.length} 个文件夹被忽略`]
          : []),
      ]

      return {
        name: 'SQLite 注册表',
        status: 'warning',
        message: `发现 ${orphans.length} 个孤立条目`,
        details,
        action: {
          label: '从注册表中移除孤立条目',
          handler: async () => {
            const count = await sqliteRegistry.removeOrphans()
            console.log(uiSuccess(`已移除 ${count} 个孤立条目`))
          },
        },
      }
    }

    const details = [
      `${entries.length} 个数据库已注册，所有文件均存在`,
    ]
    if (ignoredFolders.length > 0) {
      details.push(`${ignoredFolders.length} 个文件夹被忽略`)
    }

    return {
      name: 'SQLite 注册表',
      status: 'ok',
      message: `${entries.length} 个数据库已注册，所有文件均存在`,
      details: ignoredFolders.length > 0 ? details : undefined,
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

// 检查 DuckDB 注册表中的孤立条目
async function checkDuckdbRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await duckdbRegistry.list()
    const ignoredFolders = await duckdbRegistry.listIgnoredFolders()

    if (entries.length === 0 && ignoredFolders.length === 0) {
      return {
        name: 'DuckDB 注册表',
        status: 'ok',
        message: '未注册 DuckDB 数据库',
      }
    }

    const orphans = await duckdbRegistry.findOrphans()

    if (orphans.length > 0) {
      const details = [
        ...orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        ...(ignoredFolders.length > 0
          ? [`${ignoredFolders.length} 个文件夹被忽略`]
          : []),
      ]

      return {
        name: 'DuckDB 注册表',
        status: 'warning',
        message: `发现 ${orphans.length} 个孤立条目`,
        details,
        action: {
          label: '从注册表中移除孤立的 DuckDB 条目',
          handler: async () => {
            const count = await duckdbRegistry.removeOrphans()
            console.log(uiSuccess(`已移除 ${count} 个孤立的 DuckDB 条目`))
          },
        },
      }
    }

    const details = [
      `${entries.length} 个数据库已注册，所有文件均存在`,
    ]
    if (ignoredFolders.length > 0) {
      details.push(`${ignoredFolders.length} 个文件夹被忽略`)
    }

    return {
      name: 'DuckDB 注册表',
      status: 'ok',
      message: `${entries.length} 个数据库已注册，所有文件均存在`,
      details: ignoredFolders.length > 0 ? details : undefined,
    }
  } catch (error) {
    return {
      name: 'DuckDB 注册表',
      status: 'warning',
      message: '无法检查注册表',
      details: [(error as Error).message],
    }
  }
}

// 检查所有引擎的二进制/工具可用性
async function checkBinaries(): Promise<HealthCheckResult> {
  try {
    const engines = getSupportedEngines()

    // 并行运行所有引擎检查以提高性能（特别是在 Windows 上）
    const engineChecks = await Promise.all(
      engines.map(async (engine) => {
        const statuses = await checkEngineDependencies(engine)
        const installed = statuses.filter((s) => s.installed).length
        const total = statuses.length
        return { engine, installed, total }
      }),
    )

    const results: string[] = []
    let hasWarning = false

    for (const { engine, installed, total } of engineChecks) {
      if (installed < total) {
        hasWarning = true
        results.push(`${engine}：已安装 ${installed}/${total} 个工具`)
      } else {
        results.push(`${engine}：所有 ${total} 个工具可用`)
      }
    }

    return {
      name: '数据库工具',
      status: hasWarning ? 'warning' : 'ok',
      message: hasWarning ? '部分工具缺失' : '所有工具可用',
      details: results,
    }
  } catch (error) {
    return {
      name: '数据库工具',
      status: 'error',
      message: '检查工具失败',
      details: [(error as Error).message],
    }
  }
}

// 检查版本过时的容器
async function checkVersionMigration(
  dryRun: boolean,
): Promise<HealthCheckResult> {
  try {
    const outdated = await findOutdatedContainers()

    if (outdated.length === 0) {
      return {
        name: '版本迁移',
        status: 'ok',
        message: '所有容器版本都是最新的',
      }
    }

    // 按容器分组以避免 FerretDB 的重复条目（version + backendVersion）
    const containerMigrations = new Map<string, OutdatedContainer[]>()
    for (const item of outdated) {
      const key = item.container.name
      if (!containerMigrations.has(key)) {
        containerMigrations.set(key, [])
      }
      containerMigrations.get(key)!.push(item)
    }

    const details: string[] = dryRun ? ['试运行 - 未进行任何更改'] : []

    for (const [name, migrations] of containerMigrations) {
      for (const m of migrations) {
        const fieldLabel = m.field === 'backendVersion' ? ' (后端)' : ''
        details.push(
          `${name}${fieldLabel}：${m.currentVersion} → ${m.targetVersion}`,
        )
      }
    }

    if (dryRun) {
      return {
        name: '版本迁移',
        status: 'warning',
        message: `${containerMigrations.size} 个容器需要版本迁移`,
        details,
      }
    }

    return {
      name: '版本迁移',
      status: 'warning',
      message: `${containerMigrations.size} 个容器需要版本迁移`,
      details,
      action: {
        label: '迁移容器版本',
        handler: async () => {
          const deletedBinaries: string[] = []

          for (const item of outdated) {
            await migrateContainerVersion(
              item.container.name,
              item.targetVersion,
              item.field,
            )
            const fieldLabel =
              item.field === 'backendVersion' ? ' (后端)' : ''
            console.log(
              uiSuccess(
                `已迁移 ${item.container.name}${fieldLabel}：${item.currentVersion} → ${item.targetVersion}`,
              ),
            )

            // 如果没有其他容器使用，删除旧的二进制文件
            const engine =
              item.field === 'backendVersion'
                ? 'postgresql-documentdb'
                : item.container.engine
            const deleted = await deleteOldBinaryIfUnused(
              engine,
              item.currentVersion,
            )
            if (deleted) {
              deletedBinaries.push(`${engine}-${item.currentVersion}`)
            }
          }

          console.log(uiSuccess(`已迁移 ${outdated.length} 个版本`))
          if (deletedBinaries.length > 0) {
            console.log(
              uiSuccess(
                `已移除 ${deletedBinaries.length} 个未使用的二进制文件：${deletedBinaries.join(', ')}`,
              ),
            )
          }
        },
      },
    }
  } catch (error) {
    return {
      name: '版本迁移',
      status: 'error',
      message: '检查容器版本失败',
      details: [(error as Error).message],
    }
  }
}

// 检查孤立的测试容器（直接扫描文件系统）
async function checkOrphanedTestContainers(
  dryRun: boolean,
): Promise<HealthCheckResult> {
  try {
    const testDirs = await findOrphanedTestContainers()

    if (testDirs.length === 0) {
      return {
        name: '测试容器',
        status: 'ok',
        message: '未发现孤立的测试容器',
      }
    }

    const details = dryRun ? ['试运行 - 未进行任何更改'] : []
    details.push(...testDirs.map((d) => `${d.engine}/${d.name}`))

    if (dryRun) {
      return {
        name: '测试容器',
        status: 'warning',
        message: `发现 ${testDirs.length} 个孤立的测试容器`,
        details,
      }
    }

    return {
      name: '测试容器',
      status: 'warning',
      message: `发现 ${testDirs.length} 个孤立的测试容器`,
      details,
      action: {
        label: '删除孤立的测试容器',
        handler: async () => {
          for (const d of testDirs) {
            await deleteTestContainer(d)
            console.log(uiSuccess(`已删除 ${d.engine}/${d.name}`))
          }
          console.log(uiSuccess(`已删除 ${testDirs.length} 个测试容器`))
        },
      },
    }
  } catch (error) {
    return {
      name: '测试容器',
      status: 'error',
      message: '检查测试容器失败',
      details: [(error as Error).message],
    }
  }
}

// 显示单个健康检查结果
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

export const doctorCommand = new Command('doctor')
  .description('检查系统健康状态并修复常见问题')
  .option('--json', '以 JSON 格式输出')
  .option('--dry-run', '显示将要进行的更改而不实际执行')
  .option('--fix', '自动修复所有问题而无需提示')
  .action(
    async (options: { json?: boolean; dryRun?: boolean; fix?: boolean }) => {
      const dryRun = options.dryRun ?? false
      const autoFix = options.fix ?? false

      // 并行运行所有检查以提高性能
      const checks = await Promise.all([
        checkConfiguration(),
        checkPreferences(),
        checkContainers(),
        checkSqliteRegistry(),
        checkDuckdbRegistry(),
        checkBinaries(),
        checkVersionMigration(dryRun),
        checkOrphanedTestContainers(dryRun),
      ])

      if (options.json) {
        // 为 JSON 输出移除操作处理器
        const jsonChecks = checks.map(({ action: _action, ...rest }) => rest)
        console.log(JSON.stringify(jsonChecks, null, 2))
        return
      }

      // 人类可读输出 - 先打印标题
      console.log()
      console.log(header('SpinDB 健康检查'))
      console.log()

      // 显示结果
      for (const check of checks) {
        displayResult(check)
      }

      // 收集警告的操作（在试运行模式下跳过）
      const actionsAvailable = dryRun ? [] : checks.filter((c) => c.action)

      // 自动修复模式：无需提示运行所有操作
      if (autoFix && actionsAvailable.length > 0) {
        console.log()
        const failures: Array<{ name: string; error: Error }> = []

        for (const check of actionsAvailable) {
          try {
            await check.action!.handler()
          } catch (error) {
            const err = error as Error
            failures.push({ name: check.name, error: err })
            console.error(
              chalk.red(
                `  ✕ "${check.name}" 自动修复失败：${err.message}`,
              ),
            )
          }
        }

        console.log()

        if (failures.length > 0) {
          console.error(
            chalk.yellow(
              `  ⚠ ${failures.length} 个自动修复操作失败。请查看上方错误。`,
            ),
          )
          process.exit(1)
        }
        return
      }

      // 检测非交互环境（CI、无 TTY）
      const isNonInteractive = !!(
        process.env.CI ||
        process.env.GITHUB_ACTIONS ||
        !process.stdin.isTTY
      )

      if (actionsAvailable.length > 0 && !isNonInteractive) {
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

        const { selectedAction } = await inquirer.prompt<{
          selectedAction: string
        }>([
          {
            type: 'list',
            name: 'selectedAction',
            message: '您想要做什么？',
            choices,
          },
        ])

        if (selectedAction === 'skip') {
          return
        }

        // 执行选定的操作
        const check = checks.find((c) => c.name === selectedAction)
        if (check?.action) {
          console.log()
          await check.action.handler()
        }
      } else {
        const hasIssues = checks.some((c) => c.status !== 'ok')
        if (!hasIssues) {
          console.log(chalk.green('所有系统健康！✓'))
        } else if (isNonInteractive) {
          // 在 CI/非交互模式下，打印摘要并以非零代码退出
          const issues = checks.filter((c) => c.status !== 'ok')
          const errors = issues.filter((c) => c.status === 'error')
          const warnings = issues.filter((c) => c.status === 'warning')

          const summary = []
          if (errors.length > 0) {
            summary.push(`${errors.length} 个错误`)
          }
          if (warnings.length > 0) {
            summary.push(`${warnings.length} 个警告`)
          }

          console.log(chalk.red(`健康检查失败：${summary.join('，')}`))
          console.log(chalk.yellow(`运行 'spindb doctor --fix' 进行修复`))
          process.exit(1)
        }
      }

      console.log()
    },
  )
