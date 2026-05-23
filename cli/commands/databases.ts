import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { mkdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import {
  containerManager,
  updateRenameTracking,
} from '../../core/container-manager'
import { uiError, uiSuccess, uiWarning } from '../ui/theme'
import { getEngineMetadata } from '../helpers'
import { getEngine } from '../../engines'
import { isRemoteContainer } from '../../types'
import {
  canCreateDatabase,
  canDropDatabase,
  canRenameDatabase,
  getDatabaseCapabilities,
  getUnsupportedCreateMessage,
  getUnsupportedDropMessage,
  getUnsupportedRenameMessage,
} from '../../core/database-capabilities'
import { createSpinner } from '../ui/spinner'
import { paths } from '../../config/paths'
import {
  getDefaultFormat,
  getBackupExtension,
} from '../../config/backup-formats'
import {
  isInteractiveMode,
  isValidDatabaseName,
} from '../../core/error-handler'

/**
 * 容器内数据库管理的 CLI 命令。
 *
 * 包括：
 * - create/drop/rename：对运行中的容器执行实际的数据库操作
 * - list/add/remove/sync/refresh/set-default：管理数据库跟踪元数据
 */
export const databasesCommand = new Command('databases').description(
  '管理容器内的数据库',
)

// 列出容器中的数据库（如未指定则列出所有容器）
databasesCommand
  .command('list')
  .description('列出容器中跟踪的数据库（如未指定则列出所有）')
  .argument('[container]', '容器名称（可选 - 省略则列出全部）')
  .option('-j, --json', '以 JSON 格式输出')
  .option('--default', '仅显示默认数据库（需要指定容器）')
  .action(
    async (
      container: string | undefined,
      options: { json?: boolean; default?: boolean },
    ) => {
      try {
        // --default 需要指定容器
        if (options.default && !container) {
          const errorMsg = '--default 需要指定容器名称'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 如未指定容器，列出所有容器及其数据库
        if (!container) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            if (options.json) {
              console.log(JSON.stringify([], null, 2))
            } else {
              console.log()
              console.log(chalk.gray('未找到容器。'))
              console.log()
            }
            return
          }

          if (options.json) {
            const result = await Promise.all(
              containers.map(async (c) => {
                const rawDatabases = c.databases || []
                const databases = [...new Set([c.database, ...rawDatabases])]
                const metadata = await getEngineMetadata(c.engine)
                return {
                  container: c.name,
                  engine: c.engine,
                  primary: c.database,
                  databases,
                  ...metadata,
                }
              }),
            )
            console.log(JSON.stringify(result, null, 2))
          } else {
            console.log()
            for (const c of containers) {
              const rawDatabases = c.databases || []
              const databases = [...new Set([c.database, ...rawDatabases])]
              console.log(
                chalk.bold(`${c.name}`) + chalk.gray(` (${c.engine})`),
              )
              for (const db of databases) {
                const isPrimary = db === c.database
                const label = isPrimary ? chalk.gray(' (主数据库)') : ''
                console.log(`  ${chalk.cyan(db)}${label}`)
              }
              console.log()
            }
          }
          return
        }

        // 指定了单个容器
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `未找到容器 "${container}"` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // --default 标志：仅输出默认数据库名称
        if (options.default) {
          if (options.json) {
            console.log(JSON.stringify({ database: config.database }, null, 2))
          } else {
            console.log(config.database)
          }
          return
        }

        // 合并 config.databases 和 config.database 以确保主数据库始终包含在内
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(JSON.stringify({ ...config, ...metadata }, null, 2))
        } else {
          console.log()
          console.log(chalk.bold(`"${container}" 中的数据库：`))
          for (const db of databases) {
            const isPrimary = db === config.database
            const label = isPrimary ? chalk.gray(' (主数据库)') : ''
            console.log(`  ${chalk.cyan(db)}${label}`)
          }
          console.log()
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 添加数据库到跟踪
databasesCommand
  .command('add')
  .description(
    '添加数据库到跟踪（不创建实际的数据库）',
  )
  .argument('<container>', '容器名称')
  .argument('<database>', '要添加的数据库名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `未找到容器 "${container}"` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // 合并 config.databases 和 config.database 以确保主数据库始终包含在内
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (databases.includes(database)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `数据库 "${database}" 已在跟踪中`,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `数据库 "${database}" 已在 "${container}" 的跟踪中`,
              ),
            )
          }
          return
        }

        await containerManager.addDatabase(container, database)
        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                added: database,
                databases: updatedDatabases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(`已将 "${database}" 添加到 "${container}" 的跟踪中`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 从跟踪中移除数据库
databasesCommand
  .command('remove')
  .description(
    '从跟踪中移除数据库（不删除实际的数据库）',
  )
  .argument('<container>', '容器名称')
  .argument('<database>', '要移除的数据库名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `未找到容器 "${container}"` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // 检查是否尝试移除主数据库
        if (database === config.database) {
          const errorMsg = `无法从跟踪中移除主数据库 "${database}"`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 合并 config.databases 和 config.database 以确保主数据库始终包含在内
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (!databases.includes(database)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `数据库 "${database}" 不在跟踪中`,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `数据库 "${database}" 不在 "${container}" 的跟踪中`,
              ),
            )
          }
          return
        }

        await containerManager.removeDatabase(container, database)
        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                removed: database,
                databases: updatedDatabases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(`已从 "${container}" 的跟踪中移除 "${database}"`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 同步命令 - 重命名操作后更新跟踪
databasesCommand
  .command('sync')
  .description('数据库重命名后同步跟踪（移除旧名称，添加新名称）')
  .argument('<container>', '容器名称')
  .argument('<old-name>', '要从跟踪中移除的旧数据库名称')
  .argument('<new-name>', '要添加到跟踪的新数据库名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      container: string,
      oldName: string,
      newName: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `未找到容器 "${container}"` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // 如果旧名称是主数据库则无法同步
        if (oldName === config.database) {
          const errorMsg = `无法同步主数据库 "${oldName}"。请使用 'spindb edit' 更改主数据库。`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 如果旧名称和新名称相同则无操作
        if (oldName === newName) {
          const errorMsg = `旧名称和新名称相同："${oldName}"`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 先添加新名称（以防旧名称不在跟踪中）
        await containerManager.addDatabase(container, newName)

        // 如果旧名称在跟踪中则移除
        // 合并 config.databases 和 config.database 以确保主数据库始终包含在内
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        const wasTracked = databases.includes(oldName)
        if (wasTracked) {
          await containerManager.removeDatabase(container, oldName)
        }

        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          const result: Record<string, unknown> = {
            success: true,
            added: newName,
            databases: updatedDatabases,
          }
          // 仅当旧名称实际在跟踪中时才包含 'removed'
          if (wasTracked) {
            result.removed = oldName
          }
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(
            uiSuccess(
              `已同步数据库重命名："${oldName}" -> "${newName}" 在 "${container}" 中`,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 从服务器刷新数据库 - 查询实际的数据库服务器
databasesCommand
  .command('refresh')
  .description(
    '通过查询数据库服务器获取实际数据库来刷新跟踪',
  )
  .argument('<container>', '容器名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(async (container: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(
            JSON.stringify(
              { error: `未找到容器 "${container}"` },
              null,
              2,
            ),
          )
        } else {
          console.error(uiError(`未找到容器 "${container}"`))
        }
        process.exit(1)
      }

      const beforeDatabases = config.databases || [config.database]
      const afterDatabases = await containerManager.syncDatabases(container)

      // 计算变更
      const added = afterDatabases.filter((db) => !beforeDatabases.includes(db))
      const removed = beforeDatabases.filter(
        (db) => !afterDatabases.includes(db),
      )

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: true,
              container,
              databases: afterDatabases,
              changes: {
                added: added.length > 0 ? added : undefined,
                removed: removed.length > 0 ? removed : undefined,
              },
            },
            null,
            2,
          ),
        )
      } else {
        if (added.length === 0 && removed.length === 0) {
          console.log(chalk.gray(`"${container}" 的注册表已同步`))
        } else {
          console.log(
            uiSuccess(`已刷新 "${container}" 的数据库跟踪`),
          )
          if (added.length > 0) {
            console.log(chalk.green(`  已添加：${added.join(', ')}`))
          }
          if (removed.length > 0) {
            console.log(chalk.yellow(`  已移除：${removed.join(', ')}`))
          }
        }
        console.log()
        console.log(chalk.bold('当前数据库：'))
        for (const db of afterDatabases) {
          const isPrimary = db === config.database
          const label = isPrimary ? chalk.gray(' (主数据库)') : ''
          console.log(`  ${chalk.cyan(db)}${label}`)
        }
      }
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }, null, 2))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })

// 设置容器的默认/主数据库
databasesCommand
  .command('set-default')
  .description('设置容器的默认（主）数据库')
  .argument('<container>', '容器名称')
  .argument('<database>', '要设置为默认的数据库名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `未找到容器 "${container}"` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`未找到容器 "${container}"`))
          }
          process.exit(1)
        }

        // 检查数据库是否在跟踪中
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (!databases.includes(database)) {
          const errorMsg = `数据库 "${database}" 不在 "${container}" 的跟踪中。请先添加：spindb databases add ${container} ${database}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 检查是否已是默认
        if (database === config.database) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `数据库 "${database}" 已是默认数据库`,
                  primary: database,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `数据库 "${database}" 已是 "${container}" 的默认数据库`,
              ),
            )
          }
          return
        }

        // 更新主数据库
        await containerManager.updateConfig(container, { database })

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                primary: database,
                previous: config.database,
                databases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(
              `"${container}" 的默认数据库已从 "${config.database}" 更改为 "${database}"`,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// ─────────────────────────────────────────────────────────────────────────────
// 实际数据库操作（create, drop, rename）
// 这些对运行中的容器执行实际的数据库操作
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 辅助函数：以适当的格式输出错误并退出
 */
function outputError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2))
  } else {
    console.error(uiError(message))
  }
  process.exit(1)
}

/**
 * 辅助函数：验证 CLI 参数的数据库名称格式
 */
function validateDbName(name: string, json?: boolean): void {
  if (!isValidDatabaseName(name)) {
    outputError(
      `无效的数据库名称："${name}"。名称必须以字母开头，仅包含字母、数字和下划线。`,
      json,
    )
  }
}

/**
 * 辅助函数：验证数据库操作的常见前置条件
 */
async function validateContainer(
  containerName: string,
  options: { json?: boolean; requireRunning?: boolean },
) {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    outputError(`未找到容器 "${containerName}"`, options.json)
  }

  if (isRemoteContainer(config)) {
    outputError(
      `链接的远程容器不支持数据库操作。请使用数据库提供者的工具。`,
      options.json,
    )
  }

  if (options.requireRunning && config.status !== 'running') {
    outputError(
      `容器 "${containerName}" 未运行。请先启动：spindb start ${containerName}`,
      options.json,
    )
  }

  return config
}

// 在运行中的容器内创建新数据库
databasesCommand
  .command('create')
  .description('在运行中的容器内创建新数据库')
  .argument('<container>', '容器名称')
  .argument('[database]', '数据库名称（如省略则交互式提示）')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      containerName: string,
      database: string | undefined,
      options: { json?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canCreateDatabase(config.engine)) {
          outputError(getUnsupportedCreateMessage(config.engine), options.json)
        }

        // JSON 模式下需要数据库参数（无交互式提示）
        if (!database && options.json) {
          outputError('--json 模式下需要数据库名称', options.json)
        }

        // 如未提供则提示输入数据库名称
        if (!database) {
          if (!isInteractiveMode()) {
            outputError(
              '非交互模式下需要数据库名称。用法：spindb databases create <container> <database>',
              options.json,
            )
          }
          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'input',
              name: 'dbName',
              message: '数据库名称：',
              validate: (input: string) => {
                if (!input.trim()) return '数据库名称是必需的'
                if (/\s/.test(input)) return '数据库名称不能包含空格'
                return true
              },
            },
          ])
          database = dbName
        }

        validateDbName(database, options.json)

        // 检查数据库是否已在跟踪中存在
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]
        if (trackedDatabases.includes(database)) {
          outputError(
            `数据库 "${database}" 已存在于 "${containerName}" 中`,
            options.json,
          )
        }

        // 检查数据库是否在服务器上存在
        const engine = getEngine(config.engine)
        try {
          const serverDatabases = await engine.listDatabases(config)
          if (serverDatabases.includes(database)) {
            outputError(
              `数据库 "${database}" 已在服务器上存在。使用 "spindb databases add ${containerName} ${database}" 进行跟踪。`,
              options.json,
            )
          }
        } catch {
          // listDatabases 可能不支持；继续执行
        }

        // 创建数据库
        if (!options.json) {
          const spinner = createSpinner(
            `正在在 "${containerName}" 中创建数据库 "${database}"...`,
          )
          spinner.start()
          try {
            await engine.createDatabase(config, database)
            spinner.succeed(
              `已在 "${containerName}" 中创建数据库 "${database}"`,
            )
          } catch (error) {
            spinner.fail(`创建数据库 "${database}" 失败`)
            throw error
          }
        } else {
          await engine.createDatabase(config, database)
        }

        // 跟踪新数据库
        await containerManager.addDatabase(containerName, database)

        // 获取连接字符串
        const connectionString = engine.getConnectionString(config, database)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                container: containerName,
                engine: config.engine,
                database,
                connectionString,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            chalk.gray(`  连接字符串：${chalk.white(connectionString)}`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 从运行中的容器中删除数据库
databasesCommand
  .command('drop')
  .description('从运行中的容器中删除数据库（需确认）')
  .argument('<container>', '容器名称')
  .argument('[database]', '数据库名称（如省略则交互式选择）')
  .option('-j, --json', '以 JSON 格式输出')
  .option('-f, --force', '跳过确认提示')
  .action(
    async (
      containerName: string,
      database: string | undefined,
      options: { json?: boolean; force?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canDropDatabase(config.engine)) {
          outputError(getUnsupportedDropMessage(config.engine), options.json)
        }

        // JSON 模式下需要数据库参数
        if (!database && options.json) {
          outputError('--json 模式下需要数据库名称', options.json)
        }

        // 构建可删除的数据库列表（排除主数据库）
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]
        const droppable = trackedDatabases.filter(
          (db) => db !== config.database,
        )

        // 如未提供则提示选择数据库名称
        if (!database) {
          if (droppable.length === 0) {
            outputError(
              `"${containerName}" 中没有可删除的数据库。主数据库无法删除。`,
              options.json,
            )
          }

          if (!isInteractiveMode()) {
            outputError(
              '非交互模式下需要数据库名称。用法：spindb databases drop <container> <database>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'list',
              name: 'dbName',
              message: '选择要删除的数据库：',
              choices: droppable.map((db) => ({ name: db, value: db })),
            },
          ])
          database = dbName
        }

        validateDbName(database, options.json)

        // 阻止删除主数据库
        if (database === config.database) {
          outputError(
            `无法删除主数据库 "${database}"。使用 "spindb delete ${containerName}" 移除整个容器。`,
            options.json,
          )
        }

        // 除非 --force 否则确认
        if (!options.force && !options.json) {
          if (!isInteractiveMode()) {
            outputError(
              `删除数据库是破坏性操作。在非交互模式下使用 --force 跳过确认。`,
              options.json,
            )
          }
          const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
            {
              type: 'confirm',
              name: 'confirm',
              message: `从 ${config.engine} 容器 "${containerName}" 中删除数据库 "${database}"？此操作不可撤销。`,
              default: false,
            },
          ])
          if (!confirm) {
            console.log(chalk.gray('已取消。'))
            return
          }
        }

        const engine = getEngine(config.engine)

        // 终止连接并删除
        if (!options.json) {
          const spinner = createSpinner(
            `正在从 "${containerName}" 中删除数据库 "${database}"...`,
          )
          spinner.start()
          try {
            await engine.terminateConnections(config, database)
            await engine.dropDatabase(config, database)
            spinner.succeed(
              `已从 "${containerName}" 中删除数据库 "${database}"`,
            )
          } catch (error) {
            spinner.fail(`删除数据库 "${database}" 失败`)
            throw error
          }
        } else {
          await engine.terminateConnections(config, database)
          await engine.dropDatabase(config, database)
        }

        // 从跟踪中移除
        await containerManager.removeDatabase(containerName, database)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                container: containerName,
                engine: config.engine,
                dropped: database,
              },
              null,
              2,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// 在运行中的容器内重命名数据库
databasesCommand
  .command('rename')
  .description('在运行中的容器内重命名数据库')
  .argument('<container>', '容器名称')
  .argument('[old-name]', '当前数据库名称')
  .argument('[new-name]', '新数据库名称')
  .option('-j, --json', '以 JSON 格式输出')
  .option(
    '--backup',
    '强制使用备份/恢复路径（即使引擎支持原生重命名）',
  )
  .option('--no-drop', '将数据复制到新名称后保留旧数据库')
  .action(
    async (
      containerName: string,
      oldName: string | undefined,
      newName: string | undefined,
      options: { json?: boolean; backup?: boolean; drop?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canRenameDatabase(config.engine)) {
          outputError(getUnsupportedRenameMessage(config.engine), options.json)
        }

        // JSON 模式下需要两个参数
        if ((!oldName || !newName) && options.json) {
          outputError(
            '--json 模式下需要旧名称和新名称',
            options.json,
          )
        }

        // 构建可重命名的数据库列表
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]

        // 如未提供则提示输入旧名称
        if (!oldName) {
          if (trackedDatabases.length === 0) {
            outputError(
              `"${containerName}" 中没有可重命名的数据库。`,
              options.json,
            )
          }

          if (!isInteractiveMode()) {
            outputError(
              '非交互模式下需要数据库名称。用法：spindb databases rename <container> <old> <new>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'list',
              name: 'dbName',
              message: '选择要重命名的数据库：',
              choices: trackedDatabases.map((db) => {
                const isPrimary = db === config.database
                return {
                  name: isPrimary ? `${db} (主数据库)` : db,
                  value: db,
                }
              }),
            },
          ])
          oldName = dbName
        }

        // 如未提供则提示输入新名称
        if (!newName) {
          if (!isInteractiveMode()) {
            outputError(
              '非交互模式下需要新数据库名称。用法：spindb databases rename <container> <old> <new>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'input',
              name: 'dbName',
              message: `"${oldName}" 的新名称：`,
              validate: (input: string) => {
                if (!input.trim()) return '数据库名称是必需的'
                if (/\s/.test(input)) return '数据库名称不能包含空格'
                if (input === oldName) return '新名称必须不同'
                return true
              },
            },
          ])
          newName = dbName
        }

        validateDbName(oldName, options.json)
        validateDbName(newName, options.json)

        // 验证旧名称 != 新名称
        if (oldName === newName) {
          outputError(
            `旧名称和新名称相同："${oldName}"`,
            options.json,
          )
        }

        // 验证旧名称存在
        if (!trackedDatabases.includes(oldName)) {
          outputError(
            `数据库 "${oldName}" 不在 "${containerName}" 的跟踪中。使用 "spindb databases remove ${containerName} ${oldName}" 清理过期条目。`,
            options.json,
          )
        }

        // 验证新名称不存在
        if (trackedDatabases.includes(newName)) {
          outputError(
            `数据库 "${newName}" 已存在于 "${containerName}" 中`,
            options.json,
          )
        }

        // 同时检查服务器上的新名称
        const engine = getEngine(config.engine)
        try {
          const serverDatabases = await engine.listDatabases(config)
          if (!serverDatabases.includes(oldName)) {
            outputError(
              `数据库 "${oldName}" 在服务器上不存在。使用 "spindb databases remove ${containerName} ${oldName}" 清理跟踪。`,
              options.json,
            )
          }
          if (serverDatabases.includes(newName)) {
            outputError(
              `数据库 "${newName}" 已在服务器上存在`,
              options.json,
            )
          }
        } catch {
          // listDatabases 可能不支持；继续执行
        }

        const caps = getDatabaseCapabilities(config.engine)
        const useNativeRename =
          caps.supportsRename === 'native' &&
          !options.backup &&
          options.drop !== false
        const isPrimaryRename = oldName === config.database

        if (isPrimaryRename && !options.json) {
          console.log(
            uiWarning(
              `正在重命名主数据库。主数据库将更新为 "${newName}"。`,
            ),
          )
        }

        if (useNativeRename) {
          // 原生重命名路径（PostgreSQL, ClickHouse, CockroachDB, Meilisearch）
          if (!options.json) {
            const spinner = createSpinner(
              `正在在 "${containerName}" 中将 "${oldName}" 重命名为 "${newName}"...`,
            )
            spinner.start()
            try {
              await engine.renameDatabase(config, oldName, newName)
              spinner.succeed(`已将 "${oldName}" 重命名为 "${newName}"`)
            } catch (error) {
              spinner.fail(`重命名数据库失败`)
              throw error
            }
          } else {
            await engine.renameDatabase(config, oldName, newName)
          }

          // 更新跟踪
          await updateRenameTracking(containerName, oldName, newName, {
            shouldDrop: true,
            isPrimaryRename,
          })

          const connectionString = engine.getConnectionString(
            { ...config, database: newName },
            newName,
          )

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  container: containerName,
                  engine: config.engine,
                  oldName,
                  newName,
                  method: 'native',
                  connectionString,
                  primaryChanged: isPrimaryRename,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(`  连接字符串：${chalk.white(connectionString)}`),
            )
            if (isPrimaryRename) {
              console.log(
                chalk.gray(
                  `  注意：主数据库已更改为 "${newName}"。`,
                ),
              )
            }
          }
        } else {
          // 备份/恢复重命名路径
          if (!options.json) {
            if (caps.supportsRename === 'native') {
              console.log(
                `\n使用备份/恢复（通过标志绕过原生重命名）。`,
              )
            } else {
              console.log(
                `\n${engine.displayName} 不支持原生数据库重命名。`,
              )
            }
            console.log(
              `通过备份/恢复在 "${containerName}" 中将 "${oldName}" 克隆为 "${newName}"...\n`,
            )
          }

          await mkdir(paths.renameBackups, { recursive: true })

          const format = getDefaultFormat(config.engine)
          const extension = getBackupExtension(config.engine, format)
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '')
            .slice(0, 15)
          const backupFileName = `${containerName}-${oldName}-rename-${timestamp}${extension}`
          const backupPath = join(paths.renameBackups, backupFileName)

          let backupSize = 0

          // 步骤 1：备份旧数据库
          if (!options.json) {
            const spinner = createSpinner(`正在备份 "${oldName}"...`)
            spinner.start()
            try {
              const result = await engine.backup(config, backupPath, {
                database: oldName,
                format,
              })
              backupSize = result.size
              const sizeStr =
                backupSize > 0 ? ` (${formatBackupSize(backupSize)})` : ''
              spinner.succeed(`已备份 "${oldName}"${sizeStr}`)
            } catch (error) {
              spinner.fail(`备份 "${oldName}" 失败`)
              throw error
            }
          } else {
            const result = await engine.backup(config, backupPath, {
              database: oldName,
              format,
            })
            backupSize = result.size
          }

          // 步骤 2：创建新数据库
          let newDbCreated = false
          try {
            if (!options.json) {
              const spinner = createSpinner(`正在创建数据库 "${newName}"...`)
              spinner.start()
              try {
                await engine.createDatabase(config, newName)
                newDbCreated = true
                spinner.succeed(`已创建数据库 "${newName}"`)
              } catch (error) {
                spinner.fail(`创建数据库 "${newName}" 失败`)
                throw error
              }
            } else {
              await engine.createDatabase(config, newName)
              newDbCreated = true
            }
          } catch (error) {
            // 回滚：删除备份文件
            try {
              await unlink(backupPath)
            } catch {
              // 备份文件可能不存在
            }
            throw error
          }

          // 步骤 3：恢复数据到新数据库
          try {
            if (!options.json) {
              const spinner = createSpinner(`正在恢复数据到 "${newName}"...`)
              spinner.start()
              try {
                await engine.restore(
                  { ...config, database: newName },
                  backupPath,
                  { database: newName },
                )
                spinner.succeed(`已恢复数据到 "${newName}"`)
              } catch (error) {
                spinner.fail(`恢复数据到 "${newName}" 失败`)
                throw error
              }
            } else {
              await engine.restore(
                { ...config, database: newName },
                backupPath,
                { database: newName },
              )
            }
          } catch (error) {
            // 回滚：删除新创建的数据库，保留备份
            if (newDbCreated) {
              try {
                await engine.dropDatabase(config, newName)
              } catch {
                // 尽力清理
              }
            }
            const e = error as Error
            const msg = `恢复失败：${e.message}\n安全备份保留在：${backupPath}`
            outputError(msg, options.json)
          }

          // 步骤 4：验证新数据库存在
          if (!options.json) {
            const spinner = createSpinner(`正在验证 "${newName}" 是否存在...`)
            spinner.start()
            try {
              const serverDbs = await engine.listDatabases(config)
              if (serverDbs.includes(newName)) {
                spinner.succeed(`已验证 "${newName}" 存在`)
              } else {
                spinner.warn(`无法通过 listDatabases 验证 "${newName}"`)
              }
            } catch {
              spinner.warn(`验证已跳过（不支持 listDatabases）`)
            }
          }

          // 步骤 5：删除旧数据库（除非 --no-drop）
          // options.drop 在传递 --no-drop 时为 false（commander 会反转）
          const shouldDrop = options.drop !== false
          let dropSucceeded = false
          let oldDropError: string | undefined
          if (shouldDrop) {
            if (!options.json) {
              const spinner = createSpinner(
                `正在删除旧数据库 "${oldName}"...`,
              )
              spinner.start()
              try {
                await engine.terminateConnections(config, oldName)
                await engine.dropDatabase(config, oldName)
                spinner.succeed(`已删除旧数据库 "${oldName}"`)
                dropSucceeded = true
              } catch (error) {
                const e = error as Error
                oldDropError = e.message
                spinner.warn(
                  `无法删除旧数据库 "${oldName}"：${e.message}`,
                )
                // 非致命 — 数据已安全存储在新数据库中
              }
            } else {
              try {
                await engine.terminateConnections(config, oldName)
                await engine.dropDatabase(config, oldName)
                dropSucceeded = true
              } catch (error) {
                oldDropError = (error as Error).message
                // 非致命 — 在 JSON 输出中报告
              }
            }
          }

          // 更新跟踪 — 仅当删除实际成功时才从跟踪中移除旧数据库
          await updateRenameTracking(containerName, oldName, newName, {
            shouldDrop: dropSucceeded,
            isPrimaryRename,
          })

          const connectionString = engine.getConnectionString(
            { ...config, database: newName },
            newName,
          )

          // 获取备份文件大小
          try {
            const backupStat = await stat(backupPath)
            backupSize = backupStat.size
          } catch {
            // 使用之前捕获的大小
          }

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  container: containerName,
                  engine: config.engine,
                  oldName,
                  newName,
                  method: 'backup-restore',
                  backup: {
                    path: backupPath,
                    size: backupSize,
                    format: String(format),
                  },
                  connectionString,
                  primaryChanged: isPrimaryRename,
                  oldDatabaseDropped: dropSucceeded,
                  ...(oldDropError && { oldDropError }),
                },
                null,
                2,
              ),
            )
          } else {
            console.log(`\n重命名完成。`)
            console.log(
              chalk.gray(`  安全备份：${chalk.white(backupPath)}`),
            )
            console.log(
              chalk.gray(`  连接字符串：${chalk.white(connectionString)}`),
            )
            if (isPrimaryRename) {
              console.log(
                chalk.gray(
                  `\n  注意：主数据库已更改为 "${newName}"。`,
                ),
              )
            }
          }
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
