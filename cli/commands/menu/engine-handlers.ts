import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm, readdir } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { containerManager } from '../../../core/container-manager'
import { createSpinner } from '../../ui/spinner'
import { header, uiError, uiWarning, uiInfo, formatBytes } from '../../ui/theme'
import {
  promptConfirm,
  escapeablePrompt,
  filterableListPrompt,
  type FilterableChoice,
} from '../../ui/prompts'
import { getEngineIcon, getPageSize } from '../../constants'
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  type InstalledMariadbEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
  type InstalledDuckDBEngine,
  type InstalledMongodbEngine,
  type InstalledFerretDBEngine,
  type InstalledRedisEngine,
  type InstalledValkeyEngine,
  type InstalledClickHouseEngine,
  type InstalledQdrantEngine,
  type InstalledMeilisearchEngine,
  type InstalledCouchDBEngine,
  type InstalledCockroachDBEngine,
  type InstalledSurrealDBEngine,
  type InstalledQuestDBEngine,
  type InstalledTypeDBEngine,
  type InstalledInfluxDBEngine,
} from '../../helpers'

import { isV1 } from '../../../engines/ferretdb/version-maps'
import { type MenuChoice } from './shared'

export async function handleEngines(): Promise<void> {
  console.clear()
  console.log(header('已安装的引擎'))
  console.log()

  const spinner = createSpinner('正在加载已安装的引擎...')
  spinner.start()
  const engines = await getInstalledEngines()
  spinner.stop()

  if (engines.length === 0) {
    console.log(uiInfo('尚未安装任何引擎。'))
    console.log(chalk.gray('  数据库引擎会在创建容器时自动下载。'))
    console.log(
      chalk.gray('  或使用：spindb engines download <engine> <version>'),
    )
    return
  }

  // 按引擎类型分组并排序
  const allEnginesSorted = [
    ...engines.filter(
      (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
    ),
    ...engines.filter(
      (e): e is InstalledMariadbEngine => e.engine === 'mariadb',
    ),
    ...engines.filter((e): e is InstalledMysqlEngine => e.engine === 'mysql'),
    ...engines.filter((e): e is InstalledSqliteEngine => e.engine === 'sqlite'),
    ...engines.filter((e): e is InstalledDuckDBEngine => e.engine === 'duckdb'),
    ...engines.filter(
      (e): e is InstalledMongodbEngine => e.engine === 'mongodb',
    ),
    ...engines.filter(
      (e): e is InstalledFerretDBEngine => e.engine === 'ferretdb',
    ),
    ...engines.filter((e): e is InstalledRedisEngine => e.engine === 'redis'),
    ...engines.filter((e): e is InstalledValkeyEngine => e.engine === 'valkey'),
    ...engines.filter(
      (e): e is InstalledClickHouseEngine => e.engine === 'clickhouse',
    ),
    ...engines.filter((e): e is InstalledQdrantEngine => e.engine === 'qdrant'),
    ...engines.filter(
      (e): e is InstalledMeilisearchEngine => e.engine === 'meilisearch',
    ),
    ...engines.filter(
      (e): e is InstalledCouchDBEngine => e.engine === 'couchdb',
    ),
    ...engines.filter(
      (e): e is InstalledCockroachDBEngine => e.engine === 'cockroachdb',
    ),
    ...engines.filter(
      (e): e is InstalledSurrealDBEngine => e.engine === 'surrealdb',
    ),
    ...engines.filter(
      (e): e is InstalledQuestDBEngine => e.engine === 'questdb',
    ),
    ...engines.filter((e): e is InstalledTypeDBEngine => e.engine === 'typedb'),
    ...engines.filter(
      (e): e is InstalledInfluxDBEngine => e.engine === 'influxdb',
    ),
  ]

  // 计算总大小
  const totalSize = allEnginesSorted.reduce((acc, e) => acc + e.sizeBytes, 0)

  // 格式化列宽
  // 引擎名称列：最长名称 "meilisearch" (11) + 内边距 (2) = 13
  const COL_ENGINE_NAME = 13
  const COL_VERSION = 12
  const COL_PLATFORM = 14
  const COL_SIZE = 10

  // 构建带有格式化显示的可选项
  const engineChoices: FilterableChoice[] = allEnginesSorted.map((e) => {
    const icon = getEngineIcon(e.engine)
    const engineName = e.engine.padEnd(COL_ENGINE_NAME)
    const engineDisplay = `${icon}${engineName}`
    const versionDisplay = e.version.padEnd(COL_VERSION)
    const platformDisplay = `${e.platform}-${e.arch}`.padEnd(COL_PLATFORM)
    const sizeDisplay = formatBytes(e.sizeBytes).padStart(COL_SIZE)

    return {
      name:
        chalk.cyan(engineDisplay) +
        chalk.yellow(versionDisplay) +
        chalk.gray(platformDisplay) +
        chalk.white(sizeDisplay),
      value: `select:${e.path}:${e.engine}:${e.version}:${e.sizeBytes}`,
      short: `${e.engine} ${e.version}`,
    }
  })

  // 构建完整的选项列表，包含页脚
  const allChoices: (FilterableChoice | inquirer.Separator)[] = [
    ...engineChoices,
    new inquirer.Separator(),
    new inquirer.Separator(
      `总计：${engines.length} 个引擎，${formatBytes(totalSize)} ${chalk.gray('— 输入关键字筛选')}`,
    ),
    new inquirer.Separator(),
    {
      name: `${chalk.blue('←')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: 'back',
    },
    new inquirer.Separator(),
  ]

  const action = await filterableListPrompt(allChoices, '选择一个引擎：', {
    filterableCount: engineChoices.length,
    pageSize: getPageSize(),
    emptyText: '没有匹配筛选条件的引擎',
  })

  // 返回即回到主菜单（Esc 键已全局处理）
  if (action === 'back') {
    return
  }

  if (action.startsWith('select:')) {
    // 使用 lastIndexOf 从末尾开始解析，以正确处理 Windows 路径中的冒号
    // （例如 C:\Users\...）。格式：select:path:engineName:engineVersion:sizeBytes
    // 先提取 sizeBytes，然后是 version，再然后是 name，保留含有任意冒号的 path。
    const withoutPrefix = action.slice('select:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const sizeBytes = parseInt(withoutPrefix.slice(lastColon + 1), 10)
    const rest = withoutPrefix.slice(0, lastColon)
    const secondLastColon = rest.lastIndexOf(':')
    const engineVersion = rest.slice(secondLastColon + 1)
    const rest2 = rest.slice(0, secondLastColon)
    const thirdLastColon = rest2.lastIndexOf(':')
    const engineName = rest2.slice(thirdLastColon + 1)
    const enginePath = rest2.slice(0, thirdLastColon)

    const result = await showEngineSubmenu(
      enginePath,
      engineName,
      engineVersion,
      sizeBytes,
    )
    if (result === 'main') {
      return
    }
    await handleEngines()
  }
}

async function showEngineSubmenu(
  enginePath: string,
  engineName: string,
  engineVersion: string,
  sizeBytes: number,
): Promise<'back' | 'main' | void> {
  console.log()
  console.log(
    chalk.cyan(
      `  ${getEngineIcon(engineName)}${engineName} ${engineVersion} ${chalk.gray(`(${formatBytes(sizeBytes)})`)}`,
    ),
  )
  console.log()

  const choices: MenuChoice[] = [
    {
      name: `${chalk.red('✕')} 删除`,
      value: 'delete',
    },
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} 返回`, value: 'back' },
    {
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: 'main',
    },
  ]

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '您想执行什么操作？',
      choices,
    },
  ])

  if (action === 'back') {
    return 'back'
  }

  if (action === 'main') {
    return 'main'
  }

  if (action === 'delete') {
    await handleDeleteEngine(enginePath, engineName, engineVersion)
  }
}

async function handleDeleteEngine(
  enginePath: string,
  engineName: string,
  engineVersion: string,
): Promise<void> {
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.log()
    console.log(
      uiError(
        `无法删除：有 ${usingContainers.length} 个容器正在使用 ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  相关容器：${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    await escapeablePrompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('按 Enter 键继续...'),
      },
    ])
    return
  }

  const confirmed = await promptConfirm(
    `确认删除 ${engineName} ${engineVersion} 吗？此操作无法撤销。`,
    false,
  )

  if (!confirmed) {
    console.log(uiWarning('已取消删除'))
    return
  }

  const spinner = createSpinner(`正在删除 ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(enginePath, { recursive: true, force: true })

    // FerretDB 是一个复合引擎 - 根据版本处理后端清理
    let backendStatus = ''
    if (engineName === 'ferretdb') {
      // enginePath 类似：~/.spindb/bin/ferretdb-2.7.0-darwin-arm64
      const binDir = dirname(enginePath)
      const ferretDirName = basename(enginePath)
      // 从目录名中提取版本（例如 "2.7.0" 来自 "ferretdb-2.7.0-darwin-arm64"）
      const parts = ferretDirName.split('-')
      const platformArch = parts.slice(-2).join('-') // "darwin-arm64"

      // 提取版本：移除 "ferretdb-" 前缀和 "-platform-arch" 后缀
      const versionPart = ferretDirName.slice(
        'ferretdb-'.length,
        ferretDirName.length - `-${platformArch}`.length,
      )

      if (isV1(versionPart)) {
        // v1：不删除共享的 PostgreSQL 二进制文件（独立 PG 容器也会使用）
        backendStatus = ' （PostgreSQL 后端已保留 — 与独立容器共享）'
      } else {
        // v2：如果没有其他 v2 FerretDB 安装共用，则清理 postgresql-documentdb 后端
        const entries = await readdir(binDir, { withFileTypes: true })

        // 检查是否存在同一平台的其他 v2 FerretDB 安装
        const otherV2Installs = entries.filter((entry) => {
          if (!entry.isDirectory()) return false
          if (!entry.name.startsWith('ferretdb-')) return false
          if (!entry.name.endsWith(platformArch)) return false
          if (entry.name === ferretDirName) return false
          const otherVersion = entry.name.slice(
            'ferretdb-'.length,
            entry.name.length - `-${platformArch}`.length,
          )
          return !isV1(otherVersion)
        })

        if (otherV2Installs.length > 0) {
          backendStatus = ` （postgresql-documentdb 已保留 — 由其他 ${otherV2Installs.length} 个 v2 安装共用）`
        } else {
          const documentdbPattern = `postgresql-documentdb-`
          let cleaned = false
          for (const entry of entries) {
            if (
              entry.isDirectory() &&
              entry.name.startsWith(documentdbPattern) &&
              entry.name.endsWith(platformArch)
            ) {
              const documentdbPath = join(binDir, entry.name)
              spinner.text = `正在删除 postgresql-documentdb 后端...`
              await rm(documentdbPath, { recursive: true, force: true })
              cleaned = true
            }
          }
          if (cleaned) {
            backendStatus = ' （postgresql-documentdb 后端已一并删除）'
          }
        }
      }
    }

    spinner.succeed(`已删除 ${engineName} ${engineVersion}${backendStatus}`)
  } catch (error) {
    const e = error as Error
    spinner.fail(`删除失败：${e.message}`)
  }
}
