import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { getEngine } from '../../../engines'
import { defaults } from '../../../config/defaults'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  getDefaultFormat,
} from '../../../config/backup-formats'
import {
  generateBackupTimestamp,
  estimateBackupSize,
  checkBackupSize,
} from '../../../core/backup-restore'
import {
  promptCreateOptions,
  promptContainerName,
  promptContainerSelect,
  promptDatabaseName,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptBackupDirectory,
  promptInstallDependencies,
  promptConfirm,
  escapeablePrompt,
  filterableListPrompt,
  type FilterableChoice,
  BACK_VALUE,
  MAIN_MENU_VALUE,
  ESCAPE_VALUE,
} from '../../ui/prompts'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  uiSuccess,
  uiError,
  uiWarning,
  connectionBox,
  formatBytes,
} from '../../ui/theme'
import { getEngineIcon, getPageSize } from '../../constants'
import { Engine, assertExhaustive } from '../../../types'
import { pressEnterToContinue } from './shared'
import { SpinDBError, ErrorCodes } from '../../../core/error-handler'
import { validateTypedbConnectionString } from './validators'

// 去除路径外围的引号（处理拖拽路径）
function stripQuotes(path: string): string {
  return path.replace(/^['"]|['"]$/g, '').trim()
}

/**
 * 对连接字符串中的密码部分进行遮盖以用于显示。
 * 示例: postgresql://user:secretpass@host:5432/db → postgresql://user:****@host:5432/db
 * 通过 URL 解析处理包含 '@' 字符的密码。
 */
function maskConnectionStringPassword(connectionString: string): string {
  if (!connectionString) return connectionString
  try {
    // 使用 URL 构造函数进行稳健解析（处理密码中的 '@' 字符）
    const url = new URL(connectionString)
    if (url.password) {
      url.password = '****'
      return url.toString()
    }
    return connectionString
  } catch {
    // 格式不正确的 URL 回退处理 - 使用贪婪正则匹配，捕获直到最后一个 '@' 之前的所有内容
    try {
      return connectionString.replace(
        /^([a-z+]+:\/\/[^:]*:)(.+)(@[^@]+)$/i,
        (_, prefix, _password, suffix) => `${prefix}****${suffix}`,
      )
    } catch {
      return connectionString
    }
  }
}

/**
 * 验证给定引擎的连接字符串。
 * 有效时返回 true，无效时返回错误消息字符串。
 *
 * 特意允许空输入（返回 true），以支持“按回车返回”的用户体验模式。
 * 调用方必须在提示返回后检查空输入（例如 `if (!connectionString.trim()) return`）。
 */
function validateConnectionString(
  input: string,
  engine: Engine,
): true | string {
  // 允许空输入以实现“按回车返回”的用户体验 - 由调用方处理这种情况
  if (!input) return true

  switch (engine) {
    case Engine.PostgreSQL:
      if (
        !input.startsWith('postgresql://') &&
        !input.startsWith('postgres://')
      ) {
        return '连接字符串必须以 postgresql:// 或 postgres:// 开头'
      }
      break
    case Engine.MySQL:
      if (!input.startsWith('mysql://')) {
        return '连接字符串必须以 mysql:// 开头'
      }
      break
    case Engine.MariaDB:
      if (!input.startsWith('mysql://') && !input.startsWith('mariadb://')) {
        return '连接字符串必须以 mysql:// 或 mariadb:// 开头'
      }
      break
    case Engine.MongoDB:
    case Engine.FerretDB:
      if (
        !input.startsWith('mongodb://') &&
        !input.startsWith('mongodb+srv://')
      ) {
        return '连接字符串必须以 mongodb:// 或 mongodb+srv:// 开头'
      }
      break
    case Engine.Redis:
      if (!input.startsWith('redis://') && !input.startsWith('rediss://')) {
        return '连接字符串必须以 redis:// 或 rediss:// 开头'
      }
      break
    case Engine.Valkey:
      if (
        !input.startsWith('redis://') &&
        !input.startsWith('rediss://') &&
        !input.startsWith('valkey://') &&
        !input.startsWith('valkeys://')
      ) {
        return '连接字符串必须以 redis://、rediss://、valkey:// 或 valkeys:// 开头'
      }
      break
    case Engine.ClickHouse:
      if (
        !input.startsWith('clickhouse://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 clickhouse://、http:// 或 https:// 开头'
      }
      break
    case Engine.Qdrant:
      if (
        !input.startsWith('qdrant://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 qdrant://、http:// 或 https:// 开头'
      }
      break
    case Engine.Meilisearch:
      if (
        !input.startsWith('meilisearch://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 meilisearch://、http:// 或 https:// 开头'
      }
      break
    case Engine.CouchDB:
      if (
        !input.startsWith('couchdb://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 couchdb://、http:// 或 https:// 开头'
      }
      break
    case Engine.CockroachDB:
      if (
        !input.startsWith('postgresql://') &&
        !input.startsWith('postgres://')
      ) {
        return '连接字符串必须以 postgresql:// 或 postgres:// 开头'
      }
      break
    case Engine.SurrealDB:
      if (
        !input.startsWith('surrealdb://') &&
        !input.startsWith('ws://') &&
        !input.startsWith('wss://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 surrealdb://、ws://、wss://、http:// 或 https:// 开头'
      }
      break
    case Engine.QuestDB:
      // QuestDB 使用 PostgreSQL 有线协议
      if (
        !input.startsWith('postgresql://') &&
        !input.startsWith('postgres://')
      ) {
        return '连接字符串必须以 postgresql:// 或 postgres:// 开头'
      }
      break
    case Engine.TypeDB:
      {
        const typedbError = validateTypedbConnectionString(input)
        if (typedbError) return typedbError
      }
      break
    case Engine.InfluxDB:
      if (
        !input.startsWith('influxdb://') &&
        !input.startsWith('http://') &&
        !input.startsWith('https://')
      ) {
        return '连接字符串必须以 influxdb://、http:// 或 https:// 开头'
      }
      break
    case Engine.Weaviate:
      if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return '连接字符串必须以 http:// 或 https:// 开头'
      }
      break
    case Engine.TigerBeetle:
      return 'TigerBeetle 不支持远程转储（自定义二进制协议）'
    case Engine.LibSQL:
      if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return '连接字符串必须以 http:// 或 https:// 开头'
      }
      break
    case Engine.SQLite:
    case Engine.DuckDB:
      return '基于文件的引擎不支持远程连接字符串'
    default:
      assertExhaustive(engine)
  }
  return true
}

/**
 * 提示输入连接字符串，包含验证和密码遮盖。
 * 会显示按回车返回以及按 Esc 返回主菜单的提示。
 *
 * @param engine - 用于连接字符串验证的数据库引擎
 * @returns 连接字符串，若为空或按下退出键则返回 null
 */
async function promptConnectionString(engine: Engine): Promise<string | null> {
  console.log(chalk.gray('  输入连接字符串，或按回车键返回（esc - 主菜单）'))
  const { connectionString } = await escapeablePrompt<{
    connectionString: string
  }>([
    {
      type: 'input',
      name: 'connectionString',
      message: '连接字符串：',
      transformer: (input: string) =>
        maskConnectionStringPassword(input.trim()),
      validate: (input: string) =>
        validateConnectionString(input.trim(), engine),
    },
  ])

  const trimmed = connectionString.trim()
  return trimmed || null
}

export async function handleCreateForRestore(): Promise<{
  name: string
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>
} | null> {
  console.log()
  const answers = await promptCreateOptions()
  let { name: containerName } = answers
  const { engine, port, database } = answers
  let { version } = answers

  console.log()
  console.log(header('创建数据库容器'))
  console.log()

  const dbEngine = getEngine(engine)

  // 固定到完整解析的版本（理由同 cli/commands/create.ts）。
  const resolvedVersion = dbEngine.resolveFullVersion(version)
  if (resolvedVersion !== version) {
    console.log(
      chalk.gray(
        `  已解析 ${dbEngine.displayName} ${version} → ${resolvedVersion}`,
      ),
    )
  }
  version = resolvedVersion

  const portAvailable = await portManager.isPortAvailable(port)
  if (!portAvailable) {
    console.log(uiError(`端口 ${port} 已被占用。请选择其他端口。`))
    return null
  }

  const binarySpinner = createSpinner(
    `正在检查 ${dbEngine.displayName} ${version} 二进制文件...`,
  )
  binarySpinner.start()

  const isInstalled = await dbEngine.isBinaryInstalled(version)
  if (isInstalled) {
    binarySpinner.succeed(
      `${dbEngine.displayName} ${version} 二进制文件就绪（已缓存）`,
    )
  } else {
    binarySpinner.text = `正在下载 ${dbEngine.displayName} ${version} 二进制文件...`
    await dbEngine.ensureBinaries(version, ({ message }) => {
      binarySpinner.text = message
    })
    binarySpinner.succeed(
      `${dbEngine.displayName} ${version} 二进制文件下载完成`,
    )
  }

  while (await containerManager.exists(containerName)) {
    console.log(chalk.yellow(`  容器 "${containerName}" 已存在。`))
    containerName = await promptContainerName()
  }

  const createSpinnerInstance = createSpinner('正在创建容器...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('容器已创建')

  const initSpinner = createSpinner('正在初始化数据库集群...')
  initSpinner.start()

  await dbEngine.initDataDir(containerName, version, {
    superuser: defaults.superuser,
  })

  initSpinner.succeed('数据库集群初始化完成')

  const startSpinner = createSpinner(`正在启动 ${dbEngine.displayName}...`)
  startSpinner.start()

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    startSpinner.fail('无法获取容器配置')
    return null
  }

  await dbEngine.start(config)
  await containerManager.updateConfig(containerName, { status: 'running' })

  startSpinner.succeed(`${dbEngine.displayName} 已启动`)

  if (database !== 'postgres') {
    const dbSpinner = createSpinner(`正在创建数据库 "${database}"...`)
    dbSpinner.start()

    await dbEngine.createDatabase(config, database)

    dbSpinner.succeed(`数据库 "${database}" 已创建`)
  }

  console.log()
  console.log(uiSuccess('容器已准备好进行恢复'))
  console.log()

  return { name: containerName, config }
}

export async function handleRestore(): Promise<void> {
  // 使用循环代替递归以实现“返回”导航
  while (true) {
    const containers = await containerManager.list()
    const running = containers.filter((c) => c.status === 'running')

    // 构建可筛选的容器选项
    const containerChoices: FilterableChoice[] = running.map((c) => ({
      name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)}${c.engine} ${c.version}, 端口 ${c.port})`)} ${chalk.green('● 运行中')}`,
      value: c.name,
      short: c.name,
    }))

    // 构建包含操作和导航选项的页脚
    const footerChoices: (FilterableChoice | inquirer.Separator)[] = [
      new inquirer.Separator(),
      {
        name: `${chalk.green('➕')} 创建新容器`,
        value: '__create_new__',
        short: '创建新容器',
      },
      new inquirer.Separator(),
      { name: `${chalk.blue('←')} 返回`, value: BACK_VALUE },
      {
        name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
        value: MAIN_MENU_VALUE,
      },
      new inquirer.Separator(),
    ]

    const allChoices = [...containerChoices, ...footerChoices]

    const selectedContainer = await filterableListPrompt(
      allChoices,
      '选择要恢复到的容器：',
      {
        filterableCount: containerChoices.length,
        pageSize: getPageSize(),
        emptyText: '没有匹配筛选条件的容器',
      },
    )

    // 处理导航（包括退出）
    if (
      selectedContainer === ESCAPE_VALUE ||
      selectedContainer === BACK_VALUE ||
      selectedContainer === MAIN_MENU_VALUE
    ) {
      return
    }

    let containerName: string
    let config: Awaited<ReturnType<typeof containerManager.getConfig>>

    if (selectedContainer === '__create_new__') {
      const createResult = await handleCreateForRestore()
      if (!createResult) return
      containerName = createResult.name
      config = createResult.config
    } else {
      containerName = selectedContainer
      config = await containerManager.getConfig(containerName)
      if (!config) {
        console.error(uiError(`容器 "${containerName}" 未找到`))
        return
      }
    }

    const depsSpinner = createSpinner('正在检查必需工具...')
    depsSpinner.start()

    let missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      depsSpinner.warn(`缺少工具：${missingDeps.map((d) => d.name).join(', ')}`)

      const installed = await promptInstallDependencies(
        missingDeps[0].binary,
        config.engine,
      )

      if (!installed) {
        return
      }

      missingDeps = await getMissingDependencies(config.engine)
      if (missingDeps.length > 0) {
        console.log(
          uiError(`仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
        )
        return
      }

      console.log(chalk.green('  ✓ 所有必需工具现已可用'))
      console.log()
    } else {
      depsSpinner.succeed('必需工具可用')
    }

    // 所有引擎现在都支持 dumpFromConnectionString
    const restoreChoices: Array<
      { name: string; value: string } | inquirer.Separator
    > = [
      {
        name: `${chalk.magenta('☰')} 转储文件（拖放或输入路径）`,
        value: 'file',
      },
    ]

    restoreChoices.push({
      name: `${chalk.cyan('↗')} 连接字符串 ${chalk.gray('（从远程数据库拉取）')}`,
      value: 'connection',
    })

    restoreChoices.push(new inquirer.Separator(), {
      name: `${chalk.blue('←')} 返回`,
      value: '__back__',
    })

    const { restoreSource } = await escapeablePrompt<{
      restoreSource: 'file' | 'connection' | '__back__'
    }>([
      {
        type: 'list',
        name: 'restoreSource',
        message: '恢复来源：',
        choices: restoreChoices,
      },
    ])

    if (restoreSource === '__back__') {
      continue // 返回容器选择
    }

    let backupPath = ''
    let isTempFile = false

    if (restoreSource === 'connection') {
      const connectionString = await promptConnectionString(config.engine)
      if (!connectionString) {
        continue // 返回容器选择
      }

      const engine = getEngine(config.engine)

      const timestamp = Date.now()
      const defaultFormat = getDefaultFormat(config.engine as Engine)
      const dumpExtension = getBackupExtension(
        config.engine as Engine,
        defaultFormat,
      )
      const tempDumpPath = join(
        tmpdir(),
        `spindb-dump-${timestamp}${dumpExtension}`,
      )

      let dumpSuccess = false
      let attempts = 0
      const maxAttempts = 2

      while (!dumpSuccess && attempts < maxAttempts) {
        attempts++
        const dumpSpinner = createSpinner('正在从远程数据库创建转储...')
        dumpSpinner.start()

        try {
          const dumpResult = await engine.dumpFromConnectionString(
            connectionString,
            tempDumpPath,
          )
          dumpSpinner.succeed('已从远程数据库创建转储')
          if (dumpResult.warnings?.length) {
            for (const warning of dumpResult.warnings) {
              console.log(chalk.yellow(`  ${warning}`))
            }
          }
          backupPath = tempDumpPath
          isTempFile = true
          dumpSuccess = true
        } catch (error) {
          const e = error as Error
          dumpSpinner.fail('创建转储失败')

          // 处理版本不匹配错误，并提供有用的提示
          if (
            e instanceof SpinDBError &&
            e.code === ErrorCodes.VERSION_MISMATCH
          ) {
            console.log()
            console.log(uiError('PostgreSQL 版本不匹配：'))
            console.log(chalk.gray(`  ${e.message}`))
            if (e.suggestion) {
              console.log()
              console.log(uiWarning('解决方法：'))
              console.log(chalk.yellow(`  ${e.suggestion}`))
            }
            console.log()

            try {
              await rm(tempDumpPath, { force: true })
            } catch {
              // 忽略清理错误
            }

            await pressEnterToContinue()
            return
          }

          // 处理连接错误
          if (
            e instanceof SpinDBError &&
            e.code === ErrorCodes.CONNECTION_FAILED
          ) {
            console.log()
            console.log(uiError('连接失败：'))
            console.log(chalk.gray(`  ${e.message}`))
            if (e.suggestion) {
              console.log(chalk.yellow(`  ${e.suggestion}`))
            }
            console.log()

            await pressEnterToContinue()
            return
          }

          // 处理缺失工具错误
          if (
            e.message.includes('pg_dump not found') ||
            e.message.includes('mysqldump not found') ||
            e.message.includes('ENOENT')
          ) {
            const missingTool = e.message.includes('mysqldump')
              ? 'mysqldump'
              : 'pg_dump'
            const toolEngine =
              missingTool === 'mysqldump' ? 'mysql' : 'postgresql'
            const installed = await promptInstallDependencies(
              missingTool,
              toolEngine as Engine,
            )
            if (installed) {
              // 安装计入最大尝试次数 - 使用新安装的工具重试
              continue
            }
          } else {
            const dumpTool = config.engine === 'mysql' ? 'mysqldump' : 'pg_dump'
            console.log()
            console.log(uiError(`${dumpTool} 错误：`))
            console.log(chalk.gray(`  ${e.message}`))
            console.log()
          }

          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // 忽略清理错误
          }

          await pressEnterToContinue()
          return
        }
      }

      if (!dumpSuccess) {
        console.log(uiError('重试后仍无法创建转储'))
        return
      }
    } else {
      console.log(
        chalk.gray(
          '  拖放文件、输入路径（绝对或相对），或按回车键返回（esc - 主菜单）',
        ),
      )
      const { backupPath: rawBackupPath } = await escapeablePrompt<{
        backupPath: string
      }>([
        {
          type: 'input',
          name: 'backupPath',
          message: '备份文件路径：',
          validate: (input: string) => {
            if (!input) return true
            const cleanPath = stripQuotes(input)
            if (!existsSync(cleanPath)) return '文件未找到'
            return true
          },
        },
      ])

      if (!rawBackupPath.trim()) {
        continue // 返回容器选择
      }

      backupPath = stripQuotes(rawBackupPath)
    }

    const engine = getEngine(config.engine)

    // 获取此容器中的现有数据库
    const existingDatabases = config.databases || [config.database]

    // Redis 使用编号数据库 0-15，因此“创建新库”不适用
    const isRedis = config.engine === 'redis'

    // 恢复模式选择
    type RestoreMode = 'new' | 'replace' | '__back__'
    let restoreMode: RestoreMode

    if (isRedis) {
      // Redis：始终恢复到现有数据库（0-15）
      restoreMode = 'replace'
    } else {
      const result = await escapeablePrompt<{ restoreMode: RestoreMode }>([
        {
          type: 'list',
          name: 'restoreMode',
          message: '您希望如何恢复？',
          choices: [
            {
              name: `${chalk.green('➕')} 创建新数据库 ${chalk.gray('（保留现有数据库不变）')}`,
              value: 'new',
            },
            {
              name: `${chalk.yellow('↻')} 替换现有数据库 ${chalk.gray('（覆盖数据）')}`,
              value: 'replace',
              disabled: existingDatabases.length === 0 ? '无现有数据库' : false,
            },
            new inquirer.Separator(),
            {
              name: `${chalk.blue('←')} 返回`,
              value: '__back__',
            },
          ],
        },
      ])
      restoreMode = result.restoreMode
    }

    if (restoreMode === '__back__') {
      continue // 返回容器选择
    }

    let databaseName: string

    if (restoreMode === 'new') {
      // 显示现有数据库以供参考
      if (existingDatabases.length > 0) {
        console.log()
        console.log(chalk.gray('  此容器中的现有数据库：'))
        for (const db of existingDatabases) {
          console.log(chalk.gray(`    • ${db}`))
        }
        console.log()
      }

      // 提示输入新数据库名称（不得已存在）
      const result = await promptDatabaseName(containerName, config.engine, {
        allowBack: true,
        existingDatabases,
        disallowExisting: true,
      })

      if (result === null) {
        continue // 返回容器选择
      }
      databaseName = result
    } else {
      // 替换现有数据库 - 显示选择
      if (existingDatabases.length === 1) {
        databaseName = existingDatabases[0]
      } else {
        const result = await promptDatabaseSelect(
          existingDatabases,
          '选择要替换的数据库：',
          { includeBack: true },
        )
        if (result === null) {
          continue // 返回容器选择
        }
        databaseName = result
      }

      // 确认覆盖
      const confirmed = await promptConfirm(
        `这将覆盖 "${databaseName}" 中的所有数据。是否继续？`,
        false,
      )

      if (!confirmed) {
        continue // 返回容器选择
      }

      // Redis 无需删除/创建 - 数据库 0-15 始终存在
      if (!isRedis) {
        // 在恢复前删除现有数据库
        console.log()
        const dropSpinner = createSpinner(
          `正在删除现有数据库 "${databaseName}"...`,
        )
        dropSpinner.start()

        try {
          await engine.dropDatabase(config, databaseName)
          dropSpinner.succeed(`已删除数据库 "${databaseName}"`)
        } catch (error) {
          dropSpinner.fail(`删除数据库 "${databaseName}" 失败`)
          console.log(uiError((error as Error).message))
          await pressEnterToContinue()
          return
        }
      }
    }

    const detectSpinner = createSpinner('正在检测备份格式...')
    detectSpinner.start()

    const format = await engine.detectBackupFormat(backupPath)
    detectSpinner.succeed(`已检测：${format.description}`)

    // 对于 Redis .redis 文本文件，询问合并还是替换行为
    let flushBeforeRestore = false
    if (isRedis && format.format === 'redis') {
      const { restoreBehavior } = await escapeablePrompt<{
        restoreBehavior: 'replace' | 'merge'
      }>([
        {
          type: 'list',
          name: 'restoreBehavior',
          message: '如何处理现有数据？',
          choices: [
            {
              name: `${chalk.yellow('↻')} 全部替换 ${chalk.gray('（FLUSHDB - 先清空数据库）')}`,
              value: 'replace',
            },
            {
              name: `${chalk.green('➕')} 合并 ${chalk.gray('（添加/更新键，保留其他键）')}`,
              value: 'merge',
            },
          ],
        },
      ])
      flushBeforeRestore = restoreBehavior === 'replace'
    }

    // Redis 不需要 createDatabase - 数据库 0-15 始终存在
    if (!isRedis) {
      const dbSpinner = createSpinner(`正在创建数据库 "${databaseName}"...`)
      dbSpinner.start()

      await engine.createDatabase(config, databaseName)
      dbSpinner.succeed(`数据库 "${databaseName}" 已就绪`)
    }

    const restoreSpinner = createSpinner('正在恢复备份...')
    restoreSpinner.start()

    const result = await engine.restore(config, backupPath, {
      database: databaseName,
      createDatabase: false,
      flush: flushBeforeRestore,
    })

    if (result.code === 0) {
      restoreSpinner.succeed('备份恢复成功')
    } else {
      const stderr = result.stderr || ''

      if (
        stderr.includes('unsupported version') ||
        stderr.includes('Archive version') ||
        stderr.includes('too old')
      ) {
        restoreSpinner.fail('检测到版本兼容性问题')
        console.log()
        console.log(uiError('检测到 PostgreSQL 版本不兼容：'))
        console.log(uiWarning('您的 pg_restore 版本过旧，无法处理此备份文件。'))

        console.log(chalk.yellow('正在清理失败的数据库...'))
        try {
          await engine.dropDatabase(config, databaseName)
          console.log(chalk.gray(`✓ 已删除数据库 "${databaseName}"`))
        } catch {
          console.log(chalk.yellow(`警告：无法删除数据库 "${databaseName}"`))
        }

        console.log()

        const versionMatch = stderr.match(/PostgreSQL (\d+)/)
        const requiredVersion = versionMatch ? versionMatch[1] : '17'

        console.log(chalk.gray(`此备份使用 PostgreSQL ${requiredVersion} 创建`))
        console.log()

        console.log()
        console.log(
          uiWarning(
            `要恢复此备份，请下载 PostgreSQL ${requiredVersion} 二进制文件：`,
          ),
        )
        console.log(
          chalk.cyan(`  spindb engines download postgresql ${requiredVersion}`),
        )
        console.log()
        console.log(chalk.gray('然后使用该版本创建一个新容器并重试恢复。'))
        await pressEnterToContinue()
        return
      } else {
        // 其他恢复错误 - 显示警告
        restoreSpinner.warn('恢复已完成，但有警告')
        if (result.stderr) {
          console.log()
          console.log(chalk.yellow('  警告/错误：'))
          const lines = result.stderr.split('\n').filter((l) => l.trim())
          const displayLines = lines.slice(0, 20)
          for (const line of displayLines) {
            console.log(chalk.gray(`  ${line}`))
          }
          if (lines.length > 20) {
            console.log(chalk.gray(`  ... 还有 ${lines.length - 20} 行`))
          }
        }
      }
    }

    if (result.code === 0) {
      const connectionString = engine.getConnectionString(config, databaseName)
      console.log()
      console.log(uiSuccess(`数据库 "${databaseName}" 已恢复`))
      console.log(chalk.gray('  连接字符串：'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ 连接字符串已复制到剪贴板'))
      } else {
        console.log(chalk.gray('  （无法复制到剪贴板）'))
      }

      console.log()
    }

    if (isTempFile) {
      try {
        await rm(backupPath, { force: true })
      } catch {
        // 忽略清理错误
      }
    }

    await pressEnterToContinue()

    return // 成功恢复后退出向导循环
  }
}

/**
 * 共享备份流程，供主菜单和容器子菜单使用
 * 减少 handleBackup 和 handleBackupForContainer 之间的代码重复
 *
 * @param containerName - 要备份的容器
 * @param database - 可选的数据库名称（若提供则跳过数据库选择）
 */
async function performBackupFlow(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)

  // 检查依赖
  const depsSpinner = createSpinner('正在检查必需工具...')
  depsSpinner.start()

  let missingDeps = await getMissingDependencies(config.engine)
  if (missingDeps.length > 0) {
    depsSpinner.warn(`缺少工具：${missingDeps.map((d) => d.name).join(', ')}`)

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      config.engine,
    )

    if (!installed) {
      return
    }

    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(`仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
      )
      return
    }

    console.log(chalk.green('  ✓ 所有必需工具现已可用'))
    console.log()
  } else {
    depsSpinner.succeed('必需工具可用')
  }

  // 使用提供的数据库，或从可用数据库中选择
  const databases = config.databases || [config.database]
  let databaseName: string

  if (database) {
    // 使用来自容器子菜单的预选数据库
    databaseName = database
  } else if (databases.length > 1) {
    databaseName = await promptDatabaseSelect(databases, '选择要备份的数据库：')
  } else {
    databaseName = databases[0]
  }

  // 显示预估大小
  const estimatedSize = await estimateBackupSize(config)
  if (estimatedSize !== null) {
    console.log(chalk.gray(`  预估数据库大小：${formatBytes(estimatedSize)}`))
    console.log()
  }

  // 选择格式
  const format = await promptBackupFormat(config.engine)

  // 选择输出目录
  const outputDir = await promptBackupDirectory()
  if (!outputDir) return

  // 确保目录存在
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 获取文件名
  const defaultFilename = `${containerName}-${databaseName}-backup-${generateBackupTimestamp()}`
  const filename = await promptBackupFilename(defaultFilename)

  const extension = getBackupExtension(config.engine, format)
  const outputPath = join(outputDir, `${filename}${extension}`)

  const spinnerLabel = getBackupSpinnerLabel(config.engine, format)
  const backupSpinner = createSpinner(
    `正在为 "${databaseName}" 创建 ${spinnerLabel} 备份...`,
  )
  backupSpinner.start()

  try {
    const result = await engine.backup(config, outputPath, {
      database: databaseName,
      format,
    })

    backupSpinner.succeed('备份创建成功')

    console.log()
    console.log(uiSuccess('备份完成'))
    console.log()
    console.log(chalk.gray('  保存至：'), chalk.cyan(result.path))
    console.log(chalk.gray('  大小：'), chalk.white(formatBytes(result.size)))
    console.log(chalk.gray('  格式：'), chalk.white(result.format))
    console.log()
  } catch (error) {
    const e = error as Error
    backupSpinner.fail('备份失败')
    console.log()
    console.log(uiError(e.message))
    console.log()
  }
}

export async function handleBackup(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(uiWarning('没有正在运行的容器。请先启动一个容器。'))
    await pressEnterToContinue()
    return
  }

  const containerName = await promptContainerSelect(
    running,
    '选择要备份的容器：',
    { includeBack: true },
  )
  if (!containerName) return

  await performBackupFlow(containerName)
  await pressEnterToContinue()
}

/**
 * 为特定容器处理备份（从容器子菜单使用）
 * 跳过容器选择，因为已经知道是哪个容器
 */
export async function handleBackupForContainer(
  containerName: string,
  database?: string,
): Promise<void> {
  await performBackupFlow(containerName, database)
  await pressEnterToContinue()
}

/**
 * 为特定容器处理恢复（从容器子菜单使用）
 * 跳过容器选择，因为已经知道是哪个容器
 *
 * @param containerName - 要恢复到的容器
 * @param database - 可选的数据库名称（若提供则预选目标数据库）
 */
export async function handleRestoreForContainer(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const engine = getEngine(config.engine)

  // 检查依赖
  const depsSpinner = createSpinner('正在检查必需工具...')
  depsSpinner.start()

  let missingDeps = await getMissingDependencies(config.engine)
  if (missingDeps.length > 0) {
    depsSpinner.warn(`缺少工具：${missingDeps.map((d) => d.name).join(', ')}`)

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      config.engine,
    )

    if (!installed) {
      return
    }

    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(`仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
      )
      return
    }

    console.log(chalk.green('  ✓ 所有必需工具现已可用'))
    console.log()
  } else {
    depsSpinner.succeed('必需工具可用')
  }

  // 恢复来源选择（文件或连接字符串）
  // 所有引擎现在都支持 dumpFromConnectionString
  const restoreChoices: Array<
    { name: string; value: string } | inquirer.Separator
  > = [
    {
      name: `${chalk.magenta('☰')} 转储文件（拖放或输入路径）`,
      value: 'file',
    },
    {
      name: `${chalk.cyan('↗')} 连接字符串 ${chalk.gray('（从远程数据库拉取）')}`,
      value: 'connection',
    },
  ]

  restoreChoices.push(new inquirer.Separator(), {
    name: `${chalk.blue('←')} 返回`,
    value: '__back__',
  })

  const { restoreSource } = await escapeablePrompt<{
    restoreSource: 'file' | 'connection' | '__back__'
  }>([
    {
      type: 'list',
      name: 'restoreSource',
      message: '恢复来源：',
      choices: restoreChoices,
    },
  ])

  if (restoreSource === '__back__') {
    return
  }

  let backupPath = ''
  let isTempFile = false

  if (restoreSource === 'connection') {
    const connectionString = await promptConnectionString(config.engine)
    if (!connectionString) {
      return
    }

    const timestamp = Date.now()
    const defaultFormat = getDefaultFormat(config.engine as Engine)
    const dumpExtension = getBackupExtension(
      config.engine as Engine,
      defaultFormat,
    )
    const tempDumpPath = join(
      tmpdir(),
      `spindb-dump-${timestamp}${dumpExtension}`,
    )

    const dumpSpinner = createSpinner('正在从远程数据库创建转储...')
    dumpSpinner.start()

    try {
      const dumpResult = await engine.dumpFromConnectionString(
        connectionString,
        tempDumpPath,
      )
      dumpSpinner.succeed('已从远程数据库创建转储')
      if (dumpResult.warnings?.length) {
        for (const warning of dumpResult.warnings) {
          console.log(chalk.yellow(`  ${warning}`))
        }
      }
      backupPath = tempDumpPath
      isTempFile = true
    } catch (error) {
      const e = error as Error
      dumpSpinner.fail('创建转储失败')
      console.log(uiError(e.message))
      await pressEnterToContinue()
      return
    }
  } else {
    // 处理文件恢复
    console.log(
      chalk.gray(
        '  拖放文件、输入路径（绝对或相对），或按回车键返回（esc - 主菜单）',
      ),
    )
    const { backupPath: rawBackupPath } = await escapeablePrompt<{
      backupPath: string
    }>([
      {
        type: 'input',
        name: 'backupPath',
        message: '备份文件路径：',
        validate: (input: string) => {
          if (!input) return true
          const cleanPath = stripQuotes(input)
          if (!existsSync(cleanPath)) return '文件未找到'
          return true
        },
      },
    ])

    if (!rawBackupPath.trim()) {
      return
    }

    backupPath = stripQuotes(rawBackupPath)
  }

  // 检查备份文件大小，如果较大则警告
  const sizeCheck = checkBackupSize(backupPath)
  if (sizeCheck.level === 'very_large') {
    console.log()
    console.log(
      chalk.yellow(`  ⚠ 备份文件较大：${formatBytes(sizeCheck.size)}`),
    )
    console.log(chalk.gray('  此恢复过程可能需要一些时间。'))
    console.log()
    const confirmed = await promptConfirm('是否继续恢复？', true)
    if (!confirmed) {
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      return
    }
  } else if (sizeCheck.level === 'large') {
    console.log(chalk.gray(`  备份文件大小：${formatBytes(sizeCheck.size)}`))
  }

  // 检测备份格式
  const format = await engine.detectBackupFormat(backupPath)
  console.log(chalk.gray(`  检测到的格式：${format.description}`))
  console.log()

  // 获取此容器中的现有数据库
  const existingDatabases = config.databases || [config.database]

  // Redis 使用编号数据库 0-15，因此“创建新库”不适用
  const isRedis = config.engine === 'redis'

  // 恢复模式选择
  type RestoreMode = 'new' | 'replace' | '__back__'
  let restoreMode: RestoreMode

  if (isRedis) {
    // Redis：始终恢复到现有数据库（0-15）
    restoreMode = 'replace'
  } else {
    const result = await escapeablePrompt<{ restoreMode: RestoreMode }>([
      {
        type: 'list',
        name: 'restoreMode',
        message: '您希望如何恢复？',
        choices: [
          {
            name: `${chalk.green('➕')} 创建新数据库 ${chalk.gray('（保留现有数据库不变）')}`,
            value: 'new',
          },
          {
            name: `${chalk.yellow('↻')} 替换现有数据库 ${chalk.gray('（覆盖数据）')}`,
            value: 'replace',
            disabled: existingDatabases.length === 0 ? '无现有数据库' : false,
          },
          new inquirer.Separator(),
          {
            name: `${chalk.blue('←')} 返回`,
            value: '__back__',
          },
        ],
      },
    ])
    restoreMode = result.restoreMode
  }

  if (restoreMode === '__back__') {
    if (isTempFile) {
      await rm(backupPath, { force: true }).catch(() => {})
    }
    return
  }

  let databaseName: string

  if (restoreMode === 'new') {
    // 显示现有数据库以供参考
    if (existingDatabases.length > 0) {
      console.log()
      console.log(chalk.gray('  此容器中的现有数据库：'))
      for (const db of existingDatabases) {
        console.log(chalk.gray(`    • ${db}`))
      }
      console.log()
    }

    // 提示输入新数据库名称
    const result = await promptDatabaseName(containerName, config.engine, {
      existingDatabases,
    })
    if (!result) {
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      return
    }
    databaseName = result

    // 创建新数据库
    const createDbSpinner = createSpinner(`正在创建数据库 "${databaseName}"...`)
    createDbSpinner.start()
    try {
      await engine.createDatabase(config, databaseName)
      createDbSpinner.succeed(`数据库 "${databaseName}" 已创建`)

      // 使用新数据库更新容器配置
      const updatedDbs = [...existingDatabases, databaseName]
      await containerManager.updateConfig(containerName, {
        databases: updatedDbs,
      })
    } catch (error) {
      const e = error as Error
      createDbSpinner.fail('创建数据库失败')
      console.log(uiError(e.message))
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      await pressEnterToContinue()
      return
    }
  } else {
    // 替换现有数据库 - 使用预选的，或在只有一个时自动选择
    if (database) {
      // 使用来自容器子菜单的预选数据库
      databaseName = database
      console.log(chalk.gray(`  目标数据库：${databaseName}`))
    } else if (existingDatabases.length === 1) {
      databaseName = existingDatabases[0]
      console.log(chalk.gray(`  使用数据库：${databaseName}`))
    } else {
      const { database: selectedDb } = await escapeablePrompt<{
        database: string
      }>([
        {
          type: 'list',
          name: 'database',
          message: '选择要替换的数据库：',
          choices: existingDatabases.map((db) => ({ name: db, value: db })),
        },
      ])
      databaseName = selectedDb
    }
  }

  // 对于 Redis .redis 文本文件，询问合并还是替换行为
  let flushBeforeRestore = false
  if (isRedis && format.format === 'redis') {
    const { restoreBehavior } = await escapeablePrompt<{
      restoreBehavior: 'replace' | 'merge'
    }>([
      {
        type: 'list',
        name: 'restoreBehavior',
        message: '如何处理现有数据？',
        choices: [
          {
            name: `${chalk.yellow('↻')} 全部替换 ${chalk.gray('（FLUSHDB - 先清空数据库）')}`,
            value: 'replace',
          },
          {
            name: `${chalk.green('➕')} 合并 ${chalk.gray('（添加/更新键，保留其他键）')}`,
            value: 'merge',
          },
        ],
      },
    ])
    flushBeforeRestore = restoreBehavior === 'replace'
  }

  // 执行恢复
  const restoreSpinner = createSpinner(
    `正在将数据恢复到 ${containerName} 中的 "${databaseName}"...`,
  )
  restoreSpinner.start()

  try {
    const result = await engine.restore(config, backupPath, {
      database: databaseName,
      flush: flushBeforeRestore,
    })

    if (result.code === 0) {
      restoreSpinner.succeed('恢复成功完成')

      const connectionString = engine.getConnectionString(config, databaseName)
      console.log()
      console.log(uiSuccess(`数据库 "${databaseName}" 已恢复`))
      console.log(chalk.gray('  连接字符串：'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ 连接字符串已复制到剪贴板'))
      }
      console.log()
    } else {
      restoreSpinner.warn('恢复已完成，但有警告')
      if (result.stderr) {
        console.log()
        console.log(chalk.yellow('  警告/错误：'))
        const lines = result.stderr.split('\n').filter((l) => l.trim())
        const displayLines = lines.slice(0, 10)
        for (const line of displayLines) {
          console.log(chalk.gray(`  ${line}`))
        }
        if (lines.length > 10) {
          console.log(chalk.gray(`  ... 还有 ${lines.length - 10} 行`))
        }
      }
    }
  } catch (error) {
    const e = error as Error
    restoreSpinner.fail('恢复失败')
    console.log()
    console.log(uiError(e.message))
    console.log()
  }

  await pressEnterToContinue()
}

export async function handleClone(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (containers.length === 0) {
    console.log(uiWarning('未找到容器'))
    return
  }

  if (stopped.length === 0) {
    console.log(uiWarning('所有容器都在运行。请先停止一个容器以进行克隆。'))
    return
  }

  const sourceName = await promptContainerSelect(
    stopped,
    '选择要克隆的容器：',
    { includeBack: true },
  )
  if (!sourceName) return

  const sourceConfig = await containerManager.getConfig(sourceName)
  if (!sourceConfig) {
    console.log(uiError(`容器 "${sourceName}" 未找到`))
    return
  }

  const { targetName } = await escapeablePrompt<{ targetName: string }>([
    {
      type: 'input',
      name: 'targetName',
      message: '克隆容器的名称：',
      default: `${sourceName}-copy`,
      validate: (input: string) => {
        if (!input) return '名称为必填项'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return '名称必须以字母开头，且只能包含字母、数字、连字符和下划线'
        }
        return true
      },
    },
  ])

  // 检查目标容器是否已存在
  if (
    await containerManager.exists(targetName, { engine: sourceConfig.engine })
  ) {
    console.log(uiError(`容器 "${targetName}" 已存在`))
    return
  }

  const spinner = createSpinner(`正在将 ${sourceName} 克隆到 ${targetName}...`)
  spinner.start()

  try {
    const newConfig = await containerManager.clone(sourceName, targetName)

    spinner.succeed(`已将 "${sourceName}" 克隆为 "${targetName}"`)

    const engine = getEngine(newConfig.engine)
    const connectionString = engine.getConnectionString(newConfig)

    console.log()
    console.log(connectionBox(targetName, connectionString, newConfig.port))
  } catch (error) {
    const e = error as Error
    spinner.fail(`克隆 "${sourceName}" 失败`)
    console.log(uiError(e.message))
  }
}
