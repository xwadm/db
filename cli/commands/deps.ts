import { Command } from 'commander'
import chalk from 'chalk'
import { header, uiSuccess, uiWarning, uiError } from '../ui/theme'
import { createSpinner } from '../ui/spinner'
import {
  detectPackageManager,
  checkEngineDependencies,
  getMissingDependencies,
  getAllMissingDependencies,
  installEngineDependencies,
  installAllDependencies,
  getManualInstallInstructions,
  getCurrentPlatform,
  type DependencyStatus,
} from '../../core/dependency-manager'
import { Platform } from '../../types'
import {
  engineDependencies,
  getEngineDependencies,
} from '../../config/os-dependencies'

// 格式化依赖状态以供显示
function formatStatus(status: DependencyStatus): string {
  const { dependency, installed, path, version } = status

  if (installed) {
    const versionStr = version ? ` (${version})` : ''
    const pathStr = path ? chalk.gray(` → ${path}`) : ''
    return `  ${chalk.green('✓')} ${dependency.name}${versionStr}${pathStr}`
  } else {
    return `  ${chalk.red('✗')} ${dependency.name} ${chalk.gray('- 未安装')}`
  }
}

export const depsCommand = new Command('deps').description(
  '管理操作系统级别的数据库客户端依赖',
)

// =============================================================================
// deps check
// =============================================================================

depsCommand
  .command('check')
  .description('检查数据库客户端工具的状态')
  .option('-e, --engine <engine>', '检查特定引擎的依赖')
  .option('-a, --all', '检查所有引擎的所有依赖')
  .action(async (options: { engine?: string; all?: boolean }) => {
    console.log(header('依赖状态'))
    console.log()

    // 检测包管理器
    const packageManager = await detectPackageManager()
    if (packageManager) {
      console.log(`  包管理器：${chalk.cyan(packageManager.name)}`)
    } else {
      console.log(`  包管理器：${chalk.yellow('未检测到')}`)
    }
    console.log()

    if (options.all || (!options.engine && !options.all)) {
      // 检查所有引擎
      for (const engineConfig of engineDependencies) {
        console.log(chalk.bold(`${engineConfig.displayName}：`))

        const statuses = await checkEngineDependencies(engineConfig.engine)
        for (const status of statuses) {
          console.log(formatStatus(status))
        }

        const installed = statuses.filter((s) => s.installed).length
        const total = statuses.length
        if (installed === total) {
          console.log(chalk.green(`  所有 ${total} 个依赖已安装`))
        } else {
          console.log(
            chalk.yellow(`  已安装 ${installed}/${total} 个依赖`),
          )
        }
        console.log()
      }
    } else if (options.engine) {
      // 检查特定引擎
      const engineConfig = getEngineDependencies(options.engine)
      if (!engineConfig) {
        console.error(uiError(`未知引擎：${options.engine}`))
        console.log(
          chalk.gray(
            `  可用引擎：${engineDependencies.map((e) => e.engine).join(', ')}`,
          ),
        )
        process.exit(1)
      }

      console.log(chalk.bold(`${engineConfig.displayName}：`))

      const statuses = await checkEngineDependencies(options.engine)
      for (const status of statuses) {
        console.log(formatStatus(status))
      }

      const installed = statuses.filter((s) => s.installed).length
      const total = statuses.length
      console.log()
      if (installed === total) {
        console.log(uiSuccess(`所有 ${total} 个依赖已安装`))
      } else {
        console.log(uiWarning(`已安装 ${installed}/${total} 个依赖`))
        console.log()
        console.log(
          chalk.gray(`  运行：spindb deps install --engine ${options.engine}`),
        )
      }
    }
  })

// =============================================================================
// deps install
// =============================================================================

depsCommand
  .command('install')
  .description('安装缺失的数据库客户端工具')
  .option(
    '-e, --engine <engine>',
    '安装特定引擎的依赖（例如：postgresql, mysql）',
  )
  .option('-a, --all', '安装所有引擎的所有缺失依赖')
  .action(async (options: { engine?: string; all?: boolean }) => {
    // 首先检测包管理器
    const packageManager = await detectPackageManager()

    if (!packageManager) {
      console.log(uiError('未检测到支持的包管理器'))
      console.log()

      const platform = getCurrentPlatform()
      if (platform === Platform.Darwin) {
        console.log(chalk.gray('  macOS：请先安装 Homebrew：'))
        console.log(
          chalk.cyan(
            '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          ),
        )
      } else {
        console.log(
          chalk.gray('  支持的包管理器：apt, yum, dnf, pacman'),
        )
      }
      process.exit(1)
    }

    console.log(header('安装依赖'))
    console.log()
    console.log(`  使用：${chalk.cyan(packageManager.name)}`)
    console.log()

    if (options.all) {
      // 安装所有缺失的依赖
      const missing = await getAllMissingDependencies()

      if (missing.length === 0) {
        console.log(uiSuccess('所有依赖已安装'))
        return
      }

      console.log(`  缺失：${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner('正在安装依赖...')
      spinner.start()

      const results = await installAllDependencies(packageManager)

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed('所有依赖安装成功')
      } else {
        spinner.warn('部分依赖安装失败')
        console.log()
        for (const f of failed) {
          console.log(uiError(`  ${f.dependency.name}：${f.error}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(
          uiSuccess(
            `已安装：${succeeded.map((r) => r.dependency.name).join(', ')}`,
          ),
        )
      }
    } else if (options.engine) {
      // 安装特定引擎的依赖
      const engineConfig = getEngineDependencies(options.engine)
      if (!engineConfig) {
        console.error(uiError(`未知引擎：${options.engine}`))
        console.log(
          chalk.gray(
            `  可用引擎：${engineDependencies.map((e) => e.engine).join(', ')}`,
          ),
        )
        process.exit(1)
      }

      const missing = await getMissingDependencies(options.engine)

      if (missing.length === 0) {
        console.log(
          uiSuccess(
            `所有 ${engineConfig.displayName} 依赖已安装`,
          ),
        )
        return
      }

      console.log(`  引擎：${chalk.cyan(engineConfig.displayName)}`)
      console.log(`  缺失：${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner(
        `正在安装 ${engineConfig.displayName} 依赖...`,
      )
      spinner.start()

      const results = await installEngineDependencies(
        options.engine,
        packageManager,
      )

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed(
          `${engineConfig.displayName} 依赖安装成功`,
        )
      } else {
        spinner.warn('部分依赖安装失败')
        console.log()
        for (const f of failed) {
          console.log(uiError(`  ${f.dependency.name}：${f.error}`))
        }

        // 显示手动安装说明
        console.log()
        console.log(chalk.gray('  手动安装：'))
        const instructions = getManualInstallInstructions(
          missing[0],
          getCurrentPlatform(),
        )
        for (const instruction of instructions) {
          console.log(chalk.gray(`    ${instruction}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(
          uiSuccess(
            `已安装：${succeeded.map((r) => r.dependency.name).join(', ')}`,
          ),
        )
      }
    } else {
      // 默认：安装 PostgreSQL 依赖（最常见的用例）
      console.log(
        chalk.gray(
          '  未指定引擎，默认为 PostgreSQL。使用 --all 安装所有引擎。',
        ),
      )
      console.log()

      const missing = await getMissingDependencies('postgresql')

      if (missing.length === 0) {
        console.log(uiSuccess('所有 PostgreSQL 依赖已安装'))
        return
      }

      console.log(`  缺失：${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner('正在安装 PostgreSQL 依赖...')
      spinner.start()

      const results = await installEngineDependencies(
        'postgresql',
        packageManager,
      )

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed('PostgreSQL 依赖安装成功')
      } else {
        spinner.warn('部分依赖安装失败')
        console.log()
        for (const f of failed) {
          console.log(uiError(`  ${f.dependency.name}：${f.error}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(
          uiSuccess(
            `已安装：${succeeded.map((r) => r.dependency.name).join(', ')}`,
          ),
        )
      }
    }
  })

// =============================================================================
// deps list
// =============================================================================

depsCommand
  .command('list')
  .description('列出所有支持的依赖')
  .action(async () => {
    console.log(header('支持的依赖'))
    console.log()

    for (const engineConfig of engineDependencies) {
      console.log(chalk.bold(`${engineConfig.displayName}：`))

      for (const dep of engineConfig.dependencies) {
        console.log(`  ${chalk.cyan(dep.name)} - ${dep.description}`)
      }
      console.log()
    }

    console.log(chalk.gray('使用：spindb deps check'))
    console.log(chalk.gray('     spindb deps install --engine <engine>'))
    console.log(chalk.gray('     spindb deps install --all'))
  })
