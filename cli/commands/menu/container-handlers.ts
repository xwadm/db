import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  existsSync,
  renameSync,
  statSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from 'fs'
import { stat, mkdir, rm } from 'fs/promises'
import { dirname, basename, join, resolve } from 'path'
import { homedir } from 'os'
import {
  containerManager,
  updateRenameTracking,
} from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { processManager } from '../../../core/process-manager'
import { getEngine } from '../../../engines'
import { BaseEngine } from '../../../engines/base-engine'
import { sqliteRegistry } from '../../../engines/sqlite/registry'
import { duckdbRegistry } from '../../../engines/duckdb/registry'
import { defaults } from '../../../config/defaults'
import { getEngineConfig } from '../../../config/engines-registry'
import { getPageSize } from '../../constants'
import { paths } from '../../../config/paths'
import {
  promptContainerName,
  promptContainerSelect,
  promptInstallDependencies,
  promptConfirm,
  promptEngine,
  promptVersion,
  promptPort,
  promptDatabaseName,
  promptFileDatabasePath,
  EscapeError,
  escapeablePrompt,
  filterableListPrompt,
  type FilterableChoice,
  BACK_VALUE,
  MAIN_MENU_VALUE,
  TOGGLE_PREFIX,
} from '../../ui/prompts'
import { getEngineDefaults } from '../../../config/defaults'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  uiSuccess,
  uiError,
  uiWarning,
  uiInfo,
  connectionBox,
  formatBytes,
  box,
} from '../../ui/theme'
import {
  handleOpenShell,
  handleCopyConnectionString,
  stopPgwebProcess,
} from './shell-handlers'
import { getPgwebStatus } from '../../../core/pgweb-utils'
import { generatePassword } from '../../../core/credential-generator'
import {
  saveCredentials,
  credentialsExist,
  getDefaultUsername,
} from '../../../core/credential-manager'
import {
  UnsupportedOperationError,
  isValidUsername,
  logDebug,
} from '../../../core/error-handler'
import { handleRunSql, handleViewLogs } from './sql-handlers'
import {
  handleBackupForContainer,
  handleRestoreForContainer,
} from './backup-handlers'
import {
  exportToDocker,
  getExportBackupPath,
  dockerExportExists,
  getDockerConnectionString,
} from '../../../core/docker-exporter'
import {
  getDefaultFormat,
  getBackupExtension,
} from '../../../config/backup-formats'
import {
  parseConnectionString,
  detectEngineFromConnectionString,
  detectProvider,
  isLayerbaseCloudRemote,
  isLocalhost,
  generateRemoteContainerName,
  redactConnectionString,
  buildRemoteConfig,
  getDefaultPortForEngine,
} from '../../../core/remote-container'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../../types'
import {
  canCreateDatabase,
  canDropDatabase,
  canRenameDatabase,
  getDatabaseCapabilities,
} from '../../../core/database-capabilities'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { getEngineIcon } from '../../constants'

/** 用于被禁用的菜单项的辅助函数（提示显示在分隔符中，而非每一项上） */
function disabledItem(icon: string, label: string) {
  return {
    name: chalk.gray(`${icon} ${label}`),
    value: '_disabled_',
    disabled: '', // 空字符串隐藏 "（已禁用）" 文本
  }
}

export async function handleCreate(): Promise<'main' | string | void> {
  console.log()
  console.log(header('创建新的数据库容器'))
  console.log()

  // 向导状态 - 所有值初始为 null
  let selectedEngine: string | null = null
  let selectedVersion: string | null = null
  let containerName: string | null = null

  // 向导循环：各步骤可以返回到前面的步骤
  // 使用单个外层循环，以便 'continue' 从最早的 null 步骤重新开始
  while (containerName === null) {
    // 步骤 1：引擎选择（返回即回到主菜单）
    if (selectedEngine === null) {
      const result = await promptEngine({ includeBack: true })
      if (result === MAIN_MENU_VALUE) return 'main'
      if (result === BACK_VALUE) return // 返回上级菜单
      selectedEngine = result
    }

    // 步骤 2：版本选择（返回即回到引擎选择）
    if (selectedVersion === null) {
      const result = await promptVersion(selectedEngine!, {
        includeBack: true,
      })
      if (result === MAIN_MENU_VALUE) return 'main'
      if (result === BACK_VALUE) {
        selectedEngine = null
        continue
      }
      selectedVersion = result
    }

    // 步骤 3：容器名称（返回即回到版本选择）
    const result = await promptContainerName(undefined, { allowBack: true })
    if (result === null) {
      selectedVersion = null
      continue
    }
    containerName = result
  }

  // 此时，所有向导值均保证已设置
  const engine = selectedEngine!
  let version = selectedVersion!
  const name = containerName!

  // 步骤 4：数据库名称（默认使用容器名称，已清理）
  // Redis 和 Valkey 使用编号数据库 0-15，因此跳过提示，默认设为 "0"
  // Qdrant 使用集合（非数据库），因此默认设为 "default"
  // Meilisearch 使用索引（非数据库），因此默认设为 "default"
  let database: string
  if (engine === 'redis' || engine === 'valkey' || engine === 'tigerbeetle') {
    database = '0'
  } else if (engine === 'qdrant' || engine === 'meilisearch') {
    database = 'default'
  } else if (engine === 'influxdb') {
    database = 'mydb'
  } else {
    database = await promptDatabaseName(name, engine)
  }

  // 步骤 5：端口或文件路径（SQLite/DuckDB）
  const isSQLite = engine === 'sqlite'
  const isDuckDB = engine === 'duckdb'
  const isFileBasedDB = isSQLite || isDuckDB
  let port: number
  let filePath: string | undefined = undefined
  if (isFileBasedDB) {
    // 基于文件的数据库不需要端口，但需要路径
    const defaultExtension = isDuckDB ? '.duckdb' : '.sqlite'
    filePath = await promptFileDatabasePath(name, defaultExtension)
    port = 0
  } else {
    const engineDefaults = getEngineDefaults(engine)
    port = await promptPort(engineDefaults.defaultPort, engine)
  }

  // 现在所有值已就绪 - 继续容器创建
  let containerNameFinal = name

  console.log()
  console.log(header('创建数据库容器'))
  console.log()

  const dbEngine = getEngine(engine)
  const isPostgreSQL = engine === 'postgresql'

  // 固定到完整的已解析版本，以避免将来 spindb 升级时静默地使容器漂移到不同补丁版本。
  // 理由参见 cli/commands/create.ts。
  const resolvedVersion = dbEngine.resolveFullVersion(version)
  if (resolvedVersion !== version) {
    console.log(
      chalk.gray(
        `  已解析 ${dbEngine.displayName} ${version} → ${resolvedVersion}`,
      ),
    )
  }
  version = resolvedVersion

  // 对于 PostgreSQL 和基于文件的数据库，首先下载二进制文件
  // 它们包含后续操作所需的客户端工具
  let portAvailable = true
  if (isPostgreSQL || isFileBasedDB) {
    if (!isFileBasedDB) {
      portAvailable = await portManager.isPortAvailable(port)
    }

    const binarySpinner = createSpinner(
      `正在检查 ${dbEngine.displayName} ${version} 二进制文件...`,
    )
    binarySpinner.start()

    try {
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
    } catch (error) {
      binarySpinner.fail(`下载 ${dbEngine.displayName} 二进制文件失败`)
      const e = error as Error
      console.log()
      console.log(uiError(e.message))
      console.log()
      await pressEnterToContinue()
      return
    }
  }

  // 检查依赖（所有引擎都需要）
  // 对于 PostgreSQL，此步骤在二进制文件下载之后运行，以确保客户端工具可用
  const depsSpinner = createSpinner('正在检查必需工具...')
  depsSpinner.start()

  let missingDeps = await getMissingDependencies(engine)
  if (missingDeps.length > 0) {
    depsSpinner.warn(`缺少工具：${missingDeps.map((d) => d.name).join(', ')}`)

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      engine,
    )

    if (!installed) {
      console.log()
      console.log(uiWarning('容器创建已取消 - 未安装必需工具。'))
      await pressEnterToContinue()
      return
    }

    missingDeps = await getMissingDependencies(engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(`仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
      )
      await pressEnterToContinue()
      return
    }

    console.log(chalk.green('  ✓ 所有必需工具现已可用'))
    console.log()
  } else {
    depsSpinner.succeed('必需工具可用')
  }

  // 服务端数据库（MySQL）：检查端口和二进制文件
  // PostgreSQL 已在上面处理
  if (!isFileBasedDB && !isPostgreSQL) {
    portAvailable = await portManager.isPortAvailable(port)

    const binarySpinner = createSpinner(
      `正在检查 ${dbEngine.displayName} ${version} 二进制文件...`,
    )
    binarySpinner.start()

    try {
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
    } catch (error) {
      binarySpinner.fail(`下载 ${dbEngine.displayName} 二进制文件失败`)
      const e = error as Error
      console.log()
      console.log(uiError(e.message))
      console.log()
      await pressEnterToContinue()
      return
    }
  }

  while (await containerManager.exists(containerNameFinal)) {
    console.log(chalk.yellow(`  容器 "${containerNameFinal}" 已存在。`))
    const newName = await promptContainerName(undefined, { allowBack: true })
    if (!newName) {
      console.log(chalk.blue('  容器创建已取消。'))
      return
    }
    containerNameFinal = newName
  }

  const createSpinnerInstance = createSpinner('正在创建容器...')
  createSpinnerInstance.start()

  await containerManager.create(containerNameFinal, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('容器已创建')

  const initSpinner = createSpinner(
    isFileBasedDB ? '正在创建数据库文件...' : '正在初始化数据库集群...',
  )
  initSpinner.start()

  await dbEngine.initDataDir(containerNameFinal, version, {
    superuser: defaults.superuser,
    path: filePath, // 基于文件的数据库路径（服务端数据库为 undefined）
  })

  initSpinner.succeed(
    isFileBasedDB ? '数据库文件已创建' : '数据库集群初始化完成',
  )

  // 基于文件的数据库（SQLite/DuckDB）：显示文件路径，无需启动
  if (isFileBasedDB) {
    const config = await containerManager.getConfig(containerNameFinal)
    if (config) {
      const connectionString = dbEngine.getConnectionString(config)
      console.log()
      console.log(uiSuccess('数据库已创建'))
      console.log()
      console.log(chalk.gray(`  容器：${containerNameFinal}`))
      console.log(chalk.gray(`  引擎：${dbEngine.displayName} ${version}`))
      console.log(chalk.gray(`  文件：${config.database}`))
      console.log()
      console.log(uiSuccess(`可在 ${config.database} 处使用`))
      console.log()
      console.log(chalk.gray('  连接字符串：'))
      console.log(chalk.cyan(`  ${connectionString}`))

      try {
        const copied = await platformService.copyToClipboard(connectionString)
        if (copied) {
          console.log(chalk.gray('  ✓ 连接字符串已复制到剪贴板'))
        } else {
          console.log(chalk.gray('  （无法复制到剪贴板）'))
        }
      } catch {
        console.log(chalk.gray('  （无法复制到剪贴板）'))
      }

      console.log()

      await escapeablePrompt([
        {
          type: 'input',
          name: 'continue',
          message: chalk.gray('按 Enter 键继续...'),
        },
      ])
    }
    return containerNameFinal
  }

  // 服务端数据库：启动并创建数据库
  if (portAvailable) {
    const startSpinner = createSpinner(`正在启动 ${dbEngine.displayName}...`)
    startSpinner.start()

    const config = await containerManager.getConfig(containerNameFinal)
    if (config) {
      try {
        await dbEngine.start(config)
      } catch (error) {
        startSpinner.fail(`${dbEngine.displayName} 启动失败`)
        const e = error as Error
        console.log()
        console.log(uiError(e.message))
        console.log()
        // 清理已创建但启动失败的容器
        try {
          await containerManager.delete(containerNameFinal, { force: true })
        } catch {
          // 忽略清理错误
        }
        await pressEnterToContinue()
        return
      }
      await containerManager.updateConfig(containerNameFinal, {
        status: 'running',
      })
    }

    startSpinner.succeed(`${dbEngine.displayName} 已启动`)

    // 跳过为 PostgreSQL 创建 'postgres' 数据库 —— 它由 initdb 创建
    // 对于其他引擎（MySQL、SQLite），允许创建名为 'postgres' 的数据库
    if (
      config &&
      !(config.engine === Engine.PostgreSQL && database === 'postgres')
    ) {
      const dbSpinner = createSpinner(`正在创建数据库 "${database}"...`)
      dbSpinner.start()

      await dbEngine.createDatabase(config, database)

      dbSpinner.succeed(`数据库 "${database}" 已创建`)
    }

    if (config) {
      const connectionString = dbEngine.getConnectionString(config)
      console.log()
      console.log(uiSuccess('数据库已创建'))
      console.log()
      console.log(chalk.gray(`  容器：${containerNameFinal}`))
      console.log(chalk.gray(`  引擎：${dbEngine.displayName} ${version}`))
      console.log(chalk.gray(`  数据库：${database}`))
      console.log(chalk.gray(`  端口：${port}`))
      console.log()
      console.log(uiSuccess(`运行在端口 ${port} 上`))
      console.log()
      console.log(chalk.gray('  连接字符串：'))
      console.log(chalk.cyan(`  ${connectionString}`))

      try {
        const copied = await platformService.copyToClipboard(connectionString)
        if (copied) {
          console.log(chalk.gray('  ✓ 连接字符串已复制到剪贴板'))
        } else {
          console.log(chalk.gray('  （无法复制到剪贴板）'))
        }
      } catch {
        console.log(chalk.gray('  （无法复制到剪贴板）'))
      }

      console.log()

      await escapeablePrompt([
        {
          type: 'input',
          name: 'continue',
          message: chalk.gray('按 Enter 键继续...'),
        },
      ])
    }
  } else {
    console.log()
    console.log(uiWarning(`端口 ${port} 当前已被占用。容器已创建但未启动。`))
    console.log(
      uiInfo(
        `稍后使用以下命令启动：${chalk.cyan(`spindb start ${containerNameFinal}`)}`,
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
  }

  return containerNameFinal
}

export async function handleLinkRemote(): Promise<string | void> {
  console.log()
  console.log(header('链接远程数据库'))
  console.log()

  // 步骤 1：提示输入连接字符串
  console.log(chalk.gray('  密码已自动遮盖。'))
  console.log()
  const { connectionString } = await escapeablePrompt<{
    connectionString: string
  }>([
    {
      type: 'input',
      name: 'connectionString',
      message: '连接字符串：',
      transformer: (input: string) => redactConnectionString(input.trim()),
      validate: (input: string) => {
        if (!input.trim()) return '连接字符串为必填项'
        try {
          parseConnectionString(input)
          return true
        } catch (error) {
          return (error as Error).message
        }
      },
    },
  ])

  const parsed = parseConnectionString(connectionString)

  // 步骤 2：检测引擎
  const detectedEngine = detectEngineFromConnectionString(connectionString)
  let engine: Engine

  if (detectedEngine) {
    engine = detectedEngine
    console.log(chalk.gray(`  检测到的引擎：${engine}`))
  } else {
    console.log(uiWarning('无法从连接字符串检测引擎。请手动指定。'))
    const { engineInput } = await escapeablePrompt<{ engineInput: string }>([
      {
        type: 'input',
        name: 'engineInput',
        message: '引擎（postgresql、mysql、mongodb、redis）：',
        validate: (input: string) => {
          if (!input.trim()) return '引擎为必填项'
          const values = Object.values(Engine) as string[]
          if (!values.includes(input.toLowerCase())) {
            return `未知引擎。有效值：${values.join(', ')}`
          }
          return true
        },
      },
    ])
    engine = engineInput.toLowerCase() as Engine
  }

  // 提取详细信息
  const host = parsed.host
  const port = parsed.port ?? getDefaultPortForEngine(engine)
  const database = parsed.database || 'default'
  const provider = detectProvider(host)

  // SpinDB 冲突检查
  if (isLocalhost(host) && port > 0) {
    const containers = await containerManager.list()
    const conflicting = containers.find(
      (c) => c.engine === engine && c.port === port && c.status !== 'linked',
    )
    if (conflicting) {
      console.log(
        uiError(
          `端口 ${port} 已由 SpinDB 容器 "${conflicting.name}" 管理。请改用 "spindb connect ${conflicting.name}"。`,
        ),
      )
      await pressEnterToContinue()
      return
    }
  }

  // 步骤 3：容器名称
  const defaultName = generateRemoteContainerName({
    engine,
    host,
    database,
    provider,
  })

  let containerName = await promptContainerName(defaultName)
  if (!containerName) return

  // 检查唯一性 —— 重复提示直到唯一（与 create 命令模式相同）
  while (await containerManager.exists(containerName, { engine })) {
    console.log(chalk.yellow(`  容器 "${containerName}" 已存在。`))
    containerName = await promptContainerName()
    if (!containerName) return
  }

  // 创建容器
  const containerPath = paths.getContainerPath(containerName, { engine })
  await mkdir(containerPath, { recursive: true })

  const remoteConfig = buildRemoteConfig({
    host,
    connectionString,
    provider,
  })

  const config = {
    name: containerName,
    engine,
    version: 'unknown',
    port,
    database,
    databases: [database],
    created: new Date().toISOString(),
    status: 'linked' as const,
    remote: remoteConfig,
  }

  await containerManager.saveConfig(containerName, { engine }, config)

  // 保存凭据 —— 对于链接的容器，始终使用 'remote' 作为凭据键
  try {
    await saveCredentials(containerName, engine, {
      username: 'remote',
      password: parsed.password || '',
      connectionString,
      engine,
      container: containerName,
      database,
    })
  } catch (credError) {
    console.log(uiWarning('无法保存凭据。可能无法检索完整的连接字符串。'))
    logDebug(`凭据保存失败：${(credError as Error).message}`)
  }

  console.log()
  console.log(uiSuccess(`远程数据库已链接为 "${containerName}"`))
  console.log()
  console.log(
    chalk.gray('  ') + chalk.white('引擎：'.padEnd(14)) + chalk.cyan(engine),
  )
  console.log(
    chalk.gray('  ') + chalk.white('主机：'.padEnd(14)) + chalk.cyan(host),
  )
  if (provider) {
    console.log(
      chalk.gray('  ') +
        chalk.white('提供商：'.padEnd(14)) +
        chalk.magenta(provider),
    )
  }
  console.log()

  await pressEnterToContinue()
  return containerName
}

export async function handleList(
  showMainMenu: () => Promise<void>,
  options?: { focusContainer?: string; inlineMessage?: string },
): Promise<void> {
  console.clear()
  console.log(header('容器'))
  console.log()

  const spinner = createSpinner('正在加载容器...')
  spinner.start()

  const containers = await containerManager.list()

  if (containers.length === 0) {
    spinner.stop()
    console.log(uiInfo('未找到容器。请使用“创建”选项新建。'))
    console.log()

    await escapeablePrompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('按 Enter 键返回主菜单...'),
      },
    ])
    return
  }

  // 获取运行中容器的大小
  const sizes = await Promise.all(
    containers.map(async (container) => {
      if (container.status !== 'running') return null
      try {
        const engine = getEngine(container.engine)
        return await engine.getDatabaseSize(container)
      } catch {
        return null
      }
    }),
  )

  spinner.stop()

  if (options?.inlineMessage) {
    console.log(options.inlineMessage)
    console.log()
  }

  // 用于格式化的列宽
  const COL_NAME = 16
  const COL_ENGINE = 13
  const COL_VERSION = 8
  const COL_PORT = 6
  const COL_SIZE = 9

  // 构建带有格式化显示的可选项（类似引擎菜单）
  const containerChoices: FilterableChoice[] = containers.map((c, i) => {
    const size = sizes[i]
    const isFileBased = isFileBasedEngine(c.engine)

    const isLinked = c.status === 'linked'

    // 状态显示
    const statusDisplay = isLinked
      ? isLayerbaseCloudRemote(c.remote)
        ? chalk.cyan('☁ 云端')
        : chalk.magenta('↔ 已链接')
      : isFileBased
        ? c.status === 'running'
          ? chalk.blue('● 可用')
          : chalk.gray('○ 缺失')
        : c.status === 'running'
          ? chalk.green('● 运行中')
          : chalk.gray('○ 已停止')

    // 如果名称过长则截断
    const displayName =
      c.name.length > COL_NAME - 1
        ? c.name.slice(0, COL_NAME - 2) + '…'
        : c.name

    // 端口、链接的提供商或文件数据库的破折号
    const portDisplay = isLinked
      ? (c.remote?.provider || '远程').slice(0, COL_PORT - 1)
      : isFileBased
        ? '—'
        : String(c.port)

    // 大小显示
    const sizeDisplay = size !== null ? formatBytes(size) : '—'

    // 构建格式化行
    // 分别填充图标和引擎名称，以避免 Emoji 宽度计算问题
    // （padEnd 按码点计算，而非视觉宽度）
    const icon = getEngineIcon(c.engine)
    const engineName = c.engine.padEnd(COL_ENGINE)
    const isRunning = c.status === 'running'
    const row =
      (isRunning
        ? chalk.cyan.bold(displayName.padEnd(COL_NAME))
        : chalk.cyan(displayName.padEnd(COL_NAME))) +
      chalk.white(`${icon}${engineName}`) +
      chalk.yellow(c.version.padEnd(COL_VERSION)) +
      chalk.green(portDisplay.padEnd(COL_PORT)) +
      chalk.magenta(sizeDisplay.padEnd(COL_SIZE)) +
      statusDisplay

    return {
      name: row,
      value: c.name,
      short: c.name,
    }
  })

  // 计算摘要
  const linkedContainers = containers.filter((c) => c.status === 'linked')
  const localContainers = containers.filter((c) => c.status !== 'linked')
  const cloudLinked = linkedContainers.filter((c) =>
    isLayerbaseCloudRemote(c.remote),
  ).length
  const externalLinked = linkedContainers.length - cloudLinked
  const serverContainers = localContainers.filter(
    (c) => !isFileBasedEngine(c.engine),
  )
  const fileBasedContainers = localContainers.filter((c) =>
    isFileBasedEngine(c.engine),
  )
  const running = serverContainers.filter((c) => c.status === 'running').length
  const stopped = serverContainers.filter((c) => c.status !== 'running').length
  const available = fileBasedContainers.filter(
    (c) => c.status === 'running',
  ).length
  const missing = fileBasedContainers.filter(
    (c) => c.status !== 'running',
  ).length

  const parts: string[] = []
  if (serverContainers.length > 0) {
    parts.push(`${running} 运行中，${stopped} 已停止`)
  }
  if (fileBasedContainers.length > 0) {
    parts.push(
      `${available} 文件数据库可用${missing > 0 ? `, ${missing} 缺失` : ''}`,
    )
  }
  if (linkedContainers.length > 0) {
    if (cloudLinked > 0) {
      parts.push(`${cloudLinked} 云端`)
    }
    if (externalLinked > 0) {
      parts.push(`${externalLinked} 已链接`)
    }
  }

  // 检查是否存在任何基于服务的（可切换）容器（排除已链接的）
  const hasServerContainers = containers.some(
    (c) => !isFileBasedEngine(c.engine) && c.status !== 'linked',
  )

  // 构建包含页脚项的完整选项列表
  // 重要：容器必须放在最前面，因为 filterableCount 从索引 0 开始切片
  const summary = `${containers.length} 个容器：${parts.join('; ')}`
  const headerItems = hasServerContainers
    ? [new inquirer.Separator(chalk.cyan('── [Shift+Tab] 切换启动/停止 ──'))]
    : []
  const allChoices: (FilterableChoice | inquirer.Separator)[] = [
    ...containerChoices,
    new inquirer.Separator(),
    new inquirer.Separator(summary),
    new inquirer.Separator(),
    { name: `${chalk.green('+')} 新建`, value: 'create' },
    {
      name: `${chalk.blue('←')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: 'back',
    },
    new inquirer.Separator(),
  ]

  const selectedContainer = await filterableListPrompt(
    allChoices,
    `选择一个容器：${chalk.gray('↑↓ 选择，输入关键字筛选')}`,
    {
      filterableCount: containerChoices.length,
      pageSize: getPageSize(),
      emptyText: '没有匹配筛选条件的容器',
      enableToggle: hasServerContainers,
      defaultValue: options?.focusContainer,
      headerItems,
    },
  )

  // 处理切换（Shift+Tab）—— 启动/停止容器并刷新列表
  if (selectedContainer.startsWith(TOGGLE_PREFIX)) {
    const containerName = selectedContainer.slice(TOGGLE_PREFIX.length)
    const config = await containerManager.getConfig(containerName)
    let inlineMessage: string | undefined

    if (config && isRemoteContainer(config)) {
      inlineMessage = uiWarning(
        `"${containerName}" 是已链接的远程数据库 —— 外部管理。`,
      )
    } else if (config && !isFileBasedEngine(config.engine)) {
      const isRunning = await processManager.isRunning(containerName, {
        engine: config.engine,
      })

      // 显示内联状态，不清除屏幕
      console.log()
      if (isRunning) {
        await handleStopContainer(containerName)
      } else {
        const result = await handleStartContainer(containerName)
        if (result === 'home') {
          await showMainMenu()
          return
        }
      }
    }

    // 刷新容器列表，光标停留在同一容器上
    await handleList(showMainMenu, {
      focusContainer: containerName,
      inlineMessage,
    })
    return
  }

  // 返回即回到主菜单（Escape 已全局处理）
  if (selectedContainer === 'back') {
    return
  }

  if (selectedContainer === 'create') {
    const result = await handleCreate()
    if (result === 'main') {
      await showMainMenu()
    } else if (result) {
      await showContainerSubmenu(result, showMainMenu)
    } else {
      await handleList(showMainMenu)
    }
    return
  }

  await showContainerSubmenu(selectedContainer, showMainMenu)
}

export async function showContainerSubmenu(
  containerName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const isRemote = isRemoteContainer(config)

  // 基于文件的数据库：检查文件是否存在，而非运行状态
  const isSQLite = config.engine === Engine.SQLite
  const isDuckDB = config.engine === Engine.DuckDB
  const isFileBasedDB = isSQLite || isDuckDB
  let isRunning: boolean
  let status: string
  let locationInfo: string

  if (isRemote) {
    isRunning = false
    status = '已链接'
    locationInfo = `→ ${config.remote?.provider || config.remote?.host || '远程'}`
  } else if (isFileBasedDB) {
    const fileExists = existsSync(config.database)
    isRunning = fileExists // 对于文件数据库，“运行中” 表示 “文件存在”
    status = fileExists ? '可用' : '缺失'
    locationInfo = `位于 ${config.database}`
  } else {
    isRunning = await processManager.isRunning(containerName, {
      engine: config.engine,
    })
    status = isRunning ? '运行中' : '已停止'
    locationInfo = `端口 ${config.port}`
  }

  // 获取此容器中的数据库列表
  const databases = config.databases || [config.database]

  // 活动数据库始终来自配置中的默认值
  const activeDatabase = config.database

  // 页眉显示图标 + 容器 → 数据库
  const engineIcon = getEngineIcon(config.engine)
  const headerText = `${engineIcon} ${containerName} ${chalk.gray('→')} ${activeDatabase}`

  console.clear()
  console.log(header(headerText))
  console.log(
    chalk.gray(
      `${config.engine} ${config.version} ${locationInfo} - ${status}`,
    ),
  )
  console.log()

  // 根据引擎类型构建操作选项
  const actionChoices: MenuChoice[] = []

  // 远程容器获得简化的操作集
  if (isRemote) {
    actionChoices.push(new inquirer.Separator(chalk.gray(`── 已链接 ──`)))

    // 连接（打开控制台）
    actionChoices.push({
      name: `${chalk.blue('>')} 打开控制台`,
      value: 'shell',
    })

    // 复制连接字符串
    actionChoices.push({
      name: `${chalk.green('⎘')} 复制连接字符串`,
      value: 'copy',
    })

    actionChoices.push(new inquirer.Separator())

    // 取消链接（删除）
    actionChoices.push({
      name: `${chalk.red('✕')} 取消链接远程数据库`,
      value: 'delete',
    })

    actionChoices.push(new inquirer.Separator())

    // 导航
    actionChoices.push(
      {
        name: `${chalk.blue('←')} 返回容器列表`,
        value: 'back',
      },
      {
        name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
        value: 'main',
      },
      new inquirer.Separator(),
    )

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: '您想执行什么操作？',
        choices: actionChoices,
        pageSize: getPageSize(),
      },
    ])

    switch (action) {
      case 'shell':
        await handleOpenShell(containerName, activeDatabase)
        await showContainerSubmenu(containerName, showMainMenu)
        return
      case 'copy':
        await handleCopyConnectionString(containerName, activeDatabase)
        await showContainerSubmenu(containerName, showMainMenu)
        return
      case 'delete':
        await handleDelete(containerName)
        return
      case 'back':
        await handleList(showMainMenu)
        return
      case 'main':
        return
    }
    return
  }

  // 判断是否可以执行数据库特定操作
  const containerReady = isFileBasedDB ? existsSync(config.database) : isRunning
  const hasMultipleDatabases = databases.length > 1
  const canDoDbAction = !!activeDatabase && containerReady

  // 数据部分分隔符标签 —— 显示状态或所需操作
  function getDataSectionLabel(): string {
    if (!containerReady) {
      return isFileBasedDB ? '数据库文件缺失' : '请先启动容器'
    }
    return isFileBasedDB ? '可用' : '运行中'
  }

  // 管理部分分隔符标签 —— 显示状态或所需操作
  function getManageSectionLabel(): string {
    if (!isFileBasedDB && isRunning) {
      return '请先停止容器'
    }
    // 当操作可用时显示积极状态
    return isFileBasedDB ? '可用' : '已停止'
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 第一部分：容器状态
  // ─────────────────────────────────────────────────────────────────────────────

  // 开始/停止按钮仅适用于服务端数据库（非文件型）
  if (!isFileBasedDB) {
    if (!isRunning) {
      actionChoices.push({
        name: `${chalk.green('▶')} 启动容器`,
        value: 'start',
      })
    } else {
      actionChoices.push({
        name: `${chalk.red('■')} 停止容器`,
        value: 'stop',
      })

      // 停止 pgweb —— 仅当 pgweb 正在运行时，适用于 PG 有线协议引擎
      if (
        config.engine === 'postgresql' ||
        config.engine === 'cockroachdb' ||
        config.engine === 'ferretdb'
      ) {
        const pgwebStatus = await getPgwebStatus(containerName, config.engine)
        if (pgwebStatus.running) {
          actionChoices.push({
            name: `${chalk.redBright('■')} 停止 pgweb（端口 ${pgwebStatus.port}）`,
            value: 'stop-pgweb',
          })
        }
      }
    }

    // 查看日志 —— 服务端数据库随时可用
    actionChoices.push({
      name: `${chalk.gray('☰')} 查看日志`,
      value: 'logs',
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 第二部分：数据操作
  // 分隔符显示当前状态或所需操作
  // ─────────────────────────────────────────────────────────────────────────────
  const dataSectionLabel = getDataSectionLabel()
  actionChoices.push(
    new inquirer.Separator(chalk.gray(`── ${dataSectionLabel} ──`)),
  )

  if (hasMultipleDatabases) {
    // 多数据库：显示 "数据库（N）" 条目 —— 各数据库操作在数据库子菜单中
    actionChoices.push(
      containerReady
        ? {
            name: `${chalk.cyan('◉')} 数据库（${databases.length}）`,
            value: 'databases',
          }
        : disabledItem('◉', `数据库（${databases.length}）`),
    )

    // 设置默认数据库 —— 无需进入数据库子菜单即可快速访问
    if (canCreateDatabase(config.engine)) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.yellow('★')} 设置默认数据库`,
              value: 'set_default_database',
            }
          : disabledItem('★', '设置默认数据库'),
      )
    }
  } else {
    // 单数据库：所有数据操作内联显示

    // 打开控制台
    actionChoices.push(
      canDoDbAction
        ? { name: `${chalk.blue('>')} 打开控制台`, value: 'shell' }
        : disabledItem('>', '打开控制台'),
    )

    // 运行脚本文件
    // 标签来自 engines.json 的 scriptFileLabel；null 表示不支持脚本（REST API 引擎）
    const engineConfig = await getEngineConfig(config.engine)
    if (engineConfig.scriptFileLabel) {
      const runScriptLabel = engineConfig.scriptFileLabel
      actionChoices.push(
        canDoDbAction
          ? {
              name: `${chalk.yellow('▷')} ${runScriptLabel}`,
              value: 'run-sql',
            }
          : disabledItem('▷', runScriptLabel),
      )
    }

    // 复制连接字符串
    actionChoices.push(
      canDoDbAction
        ? {
            name: `${chalk.green('⎘')} 复制连接字符串`,
            value: 'copy',
          }
        : disabledItem('⎘', '复制连接字符串'),
    )

    // 创建用户 —— 仅适用于覆盖了 BaseEngine 的 createUser 的引擎
    const engine = getEngine(config.engine)
    const supportsUsers = engine.createUser !== BaseEngine.prototype.createUser
    if (supportsUsers) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.yellow('+')} 创建用户`,
              value: 'create_user',
            }
          : disabledItem('+', '创建用户'),
      )
    }

    // 创建数据库 —— 仅适用于支持该操作且正在运行的引擎
    if (canCreateDatabase(config.engine)) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.green('+')} 创建数据库`,
              value: 'create_database',
            }
          : disabledItem('+', '创建数据库'),
      )
    }

    // 设置默认数据库 —— 仅当引擎支持多数据库时
    if (canCreateDatabase(config.engine)) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.yellow('★')} 设置默认数据库`,
              value: 'set_default_database',
            }
          : disabledItem('★', '设置默认数据库'),
      )
    }

    // 重命名数据库 —— 仅当引擎支持且容器有数据库时
    if (canRenameDatabase(config.engine) && databases.length > 0) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.yellow('⇄')} 重命名数据库`,
              value: 'rename_database',
            }
          : disabledItem('⇄', '重命名数据库'),
      )
    }

    // 删除数据库 —— 仅当引擎支持且数据库数量 > 1 时（不能删除默认数据库）
    if (canDropDatabase(config.engine) && databases.length > 1) {
      actionChoices.push(
        containerReady
          ? {
              name: `${chalk.red('−')} 删除数据库`,
              value: 'drop_database',
            }
          : disabledItem('−', '删除数据库'),
      )
    }

    // 备份
    actionChoices.push(
      canDoDbAction
        ? {
            name: `${chalk.magenta('↓')} 备份数据库`,
            value: 'backup',
          }
        : disabledItem('↓', '备份数据库'),
    )

    // 恢复
    actionChoices.push(
      canDoDbAction
        ? {
            name: `${chalk.magenta('↑')} 从备份恢复`,
            value: 'restore',
          }
        : disabledItem('↑', '从备份恢复'),
    )
  }

  // 导出 —— 始终是容器级别的（服务端必须运行，文件型必须存在文件）
  actionChoices.push(
    containerReady
      ? { name: `${chalk.cyan('⬆')} 导出`, value: 'export' }
      : disabledItem('⬆', '导出'),
  )

  // ─────────────────────────────────────────────────────────────────────────────
  // 第三部分：容器管理（服务端需处于停止状态）
  // 分隔符显示当前状态或所需操作
  // ─────────────────────────────────────────────────────────────────────────────
  const manageSectionLabel = getManageSectionLabel()
  actionChoices.push(
    new inquirer.Separator(chalk.gray(`── ${manageSectionLabel} ──`)),
  )

  // 编辑容器 —— 文件型数据库随时可编辑（无运行状态），服务端数据库必须处于停止状态
  const canEdit = isFileBasedDB || !isRunning
  actionChoices.push(
    canEdit
      ? { name: `${chalk.yellow('⚙')} 编辑容器`, value: 'edit' }
      : disabledItem('⚙', '编辑容器'),
  )

  // 克隆容器 —— 文件型数据库随时可克隆，服务端数据库必须处于停止状态
  const canClone = isFileBasedDB || !isRunning
  actionChoices.push(
    canClone
      ? { name: `${chalk.cyan('◇')} 克隆容器`, value: 'clone' }
      : disabledItem('◇', '克隆容器'),
  )

  // 分离 —— 仅适用于文件型数据库（取消注册但不删除文件）
  if (isFileBasedDB) {
    actionChoices.push({
      name: `${chalk.yellow('⊘')} 从 SpinDB 分离`,
      value: 'detach',
    })
  }

  // 删除容器 —— 文件型数据库随时可删除，服务端数据库必须处于停止状态
  const canDelete = isFileBasedDB || !isRunning
  actionChoices.push(
    canDelete
      ? { name: `${chalk.red('✕')} 删除容器`, value: 'delete' }
      : disabledItem('✕', '删除容器'),
  )

  actionChoices.push(new inquirer.Separator())

  // ─────────────────────────────────────────────────────────────────────────────
  // 第四部分：导航
  // ─────────────────────────────────────────────────────────────────────────────

  actionChoices.push(
    {
      name: `${chalk.blue('←')} 返回容器列表`,
      value: 'back',
    },
    {
      name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
      value: 'main',
    },
    new inquirer.Separator(),
  )

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '您想执行什么操作？',
      choices: actionChoices,
      pageSize: getPageSize(),
    },
  ])

  // Escape 已由菜单循环全局处理

  switch (action) {
    case 'start': {
      const result = await handleStartContainer(containerName)
      if (result === 'home') {
        await showMainMenu()
        return
      }
      await showContainerSubmenu(containerName, showMainMenu)
      return
    }
    case 'stop':
      await handleStopContainer(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'databases':
      await showDatabasesSubmenu(containerName, showMainMenu)
      return
    case 'shell':
      await handleOpenShell(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'run-sql':
      await handleRunSql(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'logs':
      await handleViewLogs(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'stop-pgweb':
      await stopPgwebProcess(containerName, config.engine)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'edit': {
      const newName = await handleEditContainer(containerName)
      if (newName === null) {
        // 用户选择返回主菜单
        return
      }
      if (newName !== containerName) {
        // 容器已重命名，使用新名称显示子菜单
        await showContainerSubmenu(newName, showMainMenu)
      } else {
        await showContainerSubmenu(containerName, showMainMenu)
      }
      return
    }
    case 'clone':
      await handleCloneFromSubmenu(containerName, showMainMenu)
      return
    case 'copy':
      await handleCopyConnectionString(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'create_user':
      await handleCreateUser(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'create_database':
      await handleCreateDatabase(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'set_default_database':
      await handleSetDefaultDatabase(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'rename_database':
      await handleRenameDatabase(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'drop_database':
      await handleDropDatabase(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'backup':
      await handleBackupForContainer(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'restore':
      await handleRestoreForContainer(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'detach':
      await handleDetachContainer(containerName, showMainMenu)
      return // 分离后返回列表
    case 'delete':
      await handleDelete(containerName)
      return // 删除后不再显示子菜单
    case 'export':
      await handleExportSubmenu(containerName, databases, showMainMenu)
      return
    case 'back':
      await handleList(showMainMenu)
      return
    case 'main':
      return // 返回主菜单
  }
}

async function showDatabasesSubmenu(
  containerName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const databases = config.databases || [config.database]

  // 如果仅剩 1 个数据库，返回容器子菜单（内联模式）
  if (databases.length <= 1) {
    await showContainerSubmenu(containerName, showMainMenu)
    return
  }

  const engineIcon = getEngineIcon(config.engine)

  console.clear()
  console.log(header(`${engineIcon} ${containerName} - 数据库`))
  console.log()

  const choices: MenuChoice[] = databases.map((db) => ({
    name: db === config.database ? `${db} ${chalk.gray('（默认）')}` : db,
    value: db,
  }))

  choices.push(new inquirer.Separator())

  // 创建数据库 —— 仅当引擎支持且容器正在运行时
  const isFileBased = isFileBasedEngine(config.engine)
  const containerReady = isFileBased
    ? existsSync(config.database)
    : await processManager.isRunning(containerName, { engine: config.engine })

  if (canCreateDatabase(config.engine) && containerReady) {
    choices.push({
      name: `${chalk.green('+')} 创建数据库`,
      value: '_create_database',
    })
  }

  choices.push({
    name: `${chalk.blue('←')} 返回`,
    value: '_back',
  })
  choices.push({
    name: `${chalk.blue('⌂')} 主菜单 ${chalk.gray('(esc)')}`,
    value: '_home',
  })
  choices.push(new inquirer.Separator())

  const { selection } = await escapeablePrompt<{ selection: string }>([
    {
      type: 'list',
      name: 'selection',
      message: '选择一个数据库：',
      choices,
      pageSize: getPageSize(),
    },
  ])

  switch (selection) {
    case '_create_database':
      await handleCreateDatabase(containerName)
      await showDatabasesSubmenu(containerName, showMainMenu)
      return
    case '_back':
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case '_home':
      return
    default:
      await showDatabaseActionMenu(containerName, selection, showMainMenu)
      return
  }
}

async function showDatabaseActionMenu(
  containerName: string,
  database: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const databases = config.databases || [config.database]

  // 如果数据库已不存在，返回数据库子菜单
  if (!databases.includes(database)) {
    await showDatabasesSubmenu(containerName, showMainMenu)
    return
  }

  const engineIcon = getEngineIcon(config.engine)
  const headerText = `${engineIcon} ${containerName} ${chalk.gray('→')} ${database}`

  console.clear()
  console.log(header(headerText))

  const isFileBased = isFileBasedEngine(config.engine)
  const isRunning = isFileBased
    ? existsSync(config.database)
    : await processManager.isRunning(containerName, { engine: config.engine })
  const containerReady = isRunning

  console.log(
    chalk.gray(
      `${config.engine} ${config.version} - ${isRunning ? '运行中' : '已停止'}`,
    ),
  )
  console.log()

  const actionChoices: MenuChoice[] = []

  // 数据操作部分
  const dataSectionLabel = containerReady
    ? isFileBased
      ? '可用'
      : '运行中'
    : isFileBased
      ? '数据库文件缺失'
      : '请先启动容器'
  actionChoices.push(
    new inquirer.Separator(chalk.gray(`── ${dataSectionLabel} ──`)),
  )

  // 打开控制台
  actionChoices.push(
    containerReady
      ? { name: `${chalk.blue('>')} 打开控制台`, value: 'shell' }
      : disabledItem('>', '打开控制台'),
  )

  // 运行脚本文件
  const engineConfig = await getEngineConfig(config.engine)
  if (engineConfig.scriptFileLabel) {
    actionChoices.push(
      containerReady
        ? {
            name: `${chalk.yellow('▷')} ${engineConfig.scriptFileLabel}`,
            value: 'run-sql',
          }
        : disabledItem('▷', engineConfig.scriptFileLabel),
    )
  }

  // 复制连接字符串
  actionChoices.push(
    containerReady
      ? {
          name: `${chalk.green('⎘')} 复制连接字符串`,
          value: 'copy',
        }
      : disabledItem('⎘', '复制连接字符串'),
  )

  // 创建用户
  const engine = getEngine(config.engine)
  const supportsUsers = engine.createUser !== BaseEngine.prototype.createUser
  if (supportsUsers) {
    actionChoices.push(
      containerReady
        ? { name: `${chalk.yellow('+')} 创建用户`, value: 'create_user' }
        : disabledItem('+', '创建用户'),
    )
  }

  // 重命名数据库
  if (canRenameDatabase(config.engine)) {
    actionChoices.push(
      containerReady
        ? {
            name: `${chalk.yellow('⇄')} 重命名数据库`,
            value: 'rename_database',
          }
        : disabledItem('⇄', '重命名数据库'),
    )
  }

  // 删除数据库 —— 不能删除默认数据库
  if (canDropDatabase(config.engine) && database !== config.database) {
    actionChoices.push(
      containerReady
        ? {
            name: `${chalk.red('−')} 删除数据库`,
            value: 'drop_database',
          }
        : disabledItem('−', '删除数据库'),
    )
  }

  // 备份
  actionChoices.push(
    containerReady
      ? { name: `${chalk.magenta('↓')} 备份数据库`, value: 'backup' }
      : disabledItem('↓', '备份数据库'),
  )

  // 恢复
  actionChoices.push(
    containerReady
      ? {
          name: `${chalk.magenta('↑')} 从备份恢复`,
          value: 'restore',
        }
      : disabledItem('↑', '从备份恢复'),
  )

  actionChoices.push(new inquirer.Separator())

  // 设为默认
  if (database !== config.database) {
    actionChoices.push({
      name: `${chalk.yellow('★')} 设为默认`,
      value: 'set_default',
    })
  }

  // 导航
  actionChoices.push({
    name: `${chalk.blue('←')} 返回数据库列表`,
    value: 'back',
  })
  actionChoices.push({
    name: `${chalk.blue('⌂')} 主菜单 ${chalk.gray('(esc)')}`,
    value: 'home',
  })
  actionChoices.push(new inquirer.Separator())

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '您想执行什么操作？',
      choices: actionChoices,
      pageSize: getPageSize(),
    },
  ])

  switch (action) {
    case 'shell':
      await handleOpenShell(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'run-sql':
      await handleRunSql(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'copy':
      await handleCopyConnectionString(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'create_user':
      await handleCreateUser(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'rename_database': {
      // 重命名后，数据库名称可能已更改
      const beforeDbs = [...databases]
      await handleRenameDatabase(containerName, database)
      const afterConfig = await containerManager.getConfig(containerName)
      const afterDbs: string[] =
        afterConfig?.databases ||
        ([afterConfig?.database].filter(Boolean) as string[])
      // 查找新数据库名称（重命名后出现但之前没有的）
      const newDb = afterDbs.find((db) => !beforeDbs.includes(db))
      if (newDb) {
        // 数据库已重命名 —— 显示新数据库的操作菜单
        await showDatabaseActionMenu(containerName, newDb, showMainMenu)
      } else {
        // 重命名失败或用户保留了原名 —— 停留在当前数据库
        await showDatabaseActionMenu(containerName, database, showMainMenu)
      }
      return
    }
    case 'drop_database': {
      await handleDropDatabase(containerName, database)
      // 删除后检查数据库是否仍然存在
      const freshConfig = await containerManager.getConfig(containerName)
      if (!freshConfig) {
        // 容器已删除 —— 返回主菜单
        return
      }
      const freshDbs = freshConfig.databases || [freshConfig.database]
      if (!freshDbs.includes(database)) {
        // 数据库已删除
        if ((freshDbs?.length ?? 0) <= 1) {
          // 仅剩 1 个数据库 —— 不再是多数据库，转到容器子菜单
          await showContainerSubmenu(containerName, showMainMenu)
        } else {
          await showDatabasesSubmenu(containerName, showMainMenu)
        }
      } else {
        // 数据库仍然存在（用户取消了）—— 停留在数据库菜单
        await showDatabaseActionMenu(containerName, database, showMainMenu)
      }
      return
    }
    case 'backup':
      await handleBackupForContainer(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'restore':
      await handleRestoreForContainer(containerName, database)
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'set_default':
      await containerManager.updateConfig(containerName, { database })
      console.log()
      console.log(uiSuccess(`默认数据库已更改为 "${database}"`))
      await pressEnterToContinue()
      await showDatabaseActionMenu(containerName, database, showMainMenu)
      return
    case 'back':
      await showDatabasesSubmenu(containerName, showMainMenu)
      return
    case 'home':
      return
  }
}

export async function handleStart(): Promise<void> {
  const containers = await containerManager.list()
  // 筛选已停止的容器，排除文件型数据库和已链接的容器
  const stopped = containers.filter(
    (c) =>
      c.status !== 'running' &&
      c.status !== 'linked' &&
      !isFileBasedEngine(c.engine),
  )

  if (stopped.length === 0) {
    console.log(uiWarning('所有容器已在运行'))
    return
  }

  const containerName = await promptContainerSelect(
    stopped,
    '选择要启动的容器：',
    { includeBack: true },
  )
  if (!containerName) return

  // 复用 handleStartContainer 以保持一致的端口冲突处理
  await handleStartContainer(containerName)
}

export async function handleStop(): Promise<void> {
  const containers = await containerManager.list()
  // 筛选正在运行的容器，排除文件型数据库（没有可停止的服务进程）
  const running = containers.filter(
    (c) => c.status === 'running' && !isFileBasedEngine(c.engine),
  )

  if (running.length === 0) {
    console.log(uiWarning('没有正在运行的容器'))
    return
  }

  const containerName = await promptContainerSelect(
    running,
    '选择要停止的容器：',
    { includeBack: true },
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`正在停止 ${containerName}...`)
  spinner.start()

  await engine.stop(config)
  await containerManager.updateConfig(containerName, { status: 'stopped' })

  spinner.succeed(`容器 "${containerName}" 已停止`)
}

type StartResult = 'started' | 'back' | 'home'

async function handleStartContainer(
  containerName: string,
): Promise<StartResult> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return 'back'
  }

  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    // 查找下一个可用端口
    let newPort: number
    try {
      const result = await portManager.findAvailablePort({
        preferredPort: config.port,
      })
      newPort = result.port
    } catch {
      console.log()
      console.log(uiError('未找到可用端口。请释放一个端口后重试。'))
      return 'back'
    }

    // 检查是否有其他 SpinDB 容器正在使用此端口
    const allContainers = await containerManager.list()
    const conflictingContainer = allContainers.find(
      (c) =>
        c.name !== containerName &&
        c.port === config.port &&
        c.status === 'running',
    )

    const conflictReason = conflictingContainer
      ? `被 "${conflictingContainer.name}" 占用`
      : '被其他进程占用'

    console.log()
    console.log(uiWarning(`端口 ${config.port} ${conflictReason}`))
    console.log()

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: '您想执行什么操作？',
        choices: [
          {
            name: `${chalk.green('▶')} 更新为端口 ${newPort} 并启动 ${chalk.gray('（推荐）')}`,
            value: 'update',
          },
          { name: `${chalk.blue('←')} 返回`, value: 'back' },
          {
            name: `${chalk.blue('⌂')} 返回主菜单`,
            value: 'home',
          },
        ],
      },
    ])

    if (action === 'back') {
      return 'back'
    }
    if (action === 'home') {
      return 'home'
    }

    // 更新端口后继续启动
    config.port = newPort
    await containerManager.updateConfig(containerName, { port: newPort })
    console.log(uiSuccess(`端口已更新为 ${newPort}`))
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`正在启动 ${containerName}...`)
  spinner.start()

  try {
    await engine.start(config)
    await containerManager.updateConfig(containerName, { status: 'running' })

    spinner.succeed(`容器 "${containerName}" 已启动`)

    const connectionString = engine.getConnectionString(config)
    console.log()
    console.log(chalk.gray('  连接字符串：'))
    console.log(chalk.cyan(`  ${connectionString}`))
    return 'started'
  } catch (error) {
    spinner.fail(`启动 "${containerName}" 失败`)
    const e = error as Error
    console.log()
    console.log(uiError(e.message))

    const logPath = paths.getContainerLogPath(containerName, {
      engine: config.engine,
    })
    if (existsSync(logPath)) {
      console.log()
      console.log(uiInfo(`查看日志文件以获取详细信息：${logPath}`))
    }
    return 'back'
  }
}

async function handleStopContainer(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`正在停止 ${containerName}...`)
  spinner.start()

  await engine.stop(config)
  await containerManager.updateConfig(containerName, { status: 'stopped' })

  spinner.succeed(`容器 "${containerName}" 已停止`)
}

async function handleEditContainer(
  containerName: string,
): Promise<string | null> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return null
  }

  const isSQLite = config.engine === Engine.SQLite
  const isDuckDB = config.engine === Engine.DuckDB
  const isFileBasedDB = isSQLite || isDuckDB

  console.clear()
  console.log(header(`编辑：${containerName}`))
  console.log()

  const editChoices: Array<
    { name: string; value: string } | inquirer.Separator
  > = [
    {
      name: `名称：${chalk.white(containerName)}`,
      value: 'name',
    },
  ]

  // 文件型数据库：显示重定位选项及文件路径；其他：显示端口
  if (isFileBasedDB) {
    editChoices.push({
      name: `位置：${chalk.white(config.database)}`,
      value: 'relocate',
    })
  } else {
    editChoices.push({
      name: `端口：${chalk.white(String(config.port))}`,
      value: 'port',
    })
  }

  editChoices.push(new inquirer.Separator())
  editChoices.push({
    name: `${chalk.blue('←')} 返回容器`,
    value: 'back',
  })
  editChoices.push({
    name: `${chalk.blue('⌂')} 返回主菜单 ${chalk.gray('(esc)')}`,
    value: 'main',
  })

  const { field } = await escapeablePrompt<{ field: string }>([
    {
      type: 'list',
      name: 'field',
      message: '选择要编辑的字段：',
      choices: editChoices,
      pageSize: getPageSize(),
    },
  ])

  if (field === 'back') {
    return containerName
  }

  if (field === 'main') {
    return null // 返回主菜单的信号
  }

  if (field === 'name') {
    const { newName } = await escapeablePrompt<{ newName: string }>([
      {
        type: 'input',
        name: 'newName',
        message: '新名称：',
        default: containerName,
        validate: (input: string) => {
          if (!input) return '名称为必填项'
          if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
            return '名称必须以字母开头，且只能包含字母、数字、连字符和下划线'
          }
          return true
        },
      },
    ])

    if (newName === containerName) {
      console.log(uiInfo('名称未更改'))
      return await handleEditContainer(containerName)
    }

    if (await containerManager.exists(newName)) {
      console.log(uiError(`容器 "${newName}" 已存在`))
      return await handleEditContainer(containerName)
    }

    const spinner = createSpinner('正在重命名容器...')
    spinner.start()

    await containerManager.rename(containerName, newName)

    spinner.succeed(`已将 "${containerName}" 重命名为 "${newName}"`)

    // 使用新名称继续编辑
    return await handleEditContainer(newName)
  }

  if (field === 'port') {
    const { newPort } = await escapeablePrompt<{ newPort: number }>([
      {
        type: 'input',
        name: 'newPort',
        message: '新端口：',
        default: String(config.port),
        validate: (input: string) => {
          const num = parseInt(input, 10)
          if (isNaN(num) || num < 1 || num > 65535) {
            return '端口必须为 1 至 65535 之间的数字'
          }
          return true
        },
        filter: (input: string) => parseInt(input, 10),
      },
    ])

    if (newPort === config.port) {
      console.log(uiInfo('端口未更改'))
      return await handleEditContainer(containerName)
    }

    const portAvailable = await portManager.isPortAvailable(newPort)
    if (!portAvailable) {
      console.log(
        uiWarning(
          `端口 ${newPort} 当前已被占用。在启动此容器之前，您需要停止使用该端口的进程。`,
        ),
      )
    }

    await containerManager.updateConfig(containerName, { port: newPort })
    console.log(uiSuccess(`端口已从 ${config.port} 更改为 ${newPort}`))

    // 继续编辑
    return await handleEditContainer(containerName)
  }

  if (field === 'relocate') {
    const currentFileName = basename(config.database)

    const { inputPath } = await escapeablePrompt<{ inputPath: string }>([
      {
        type: 'input',
        name: 'inputPath',
        message: '新文件路径：',
        default: config.database,
        validate: (input: string) => {
          if (!input) return '路径为必填项'
          return true
        },
      },
    ])

    // 展开 ~ 为用户主目录
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

    // 检查路径是否看起来像文件（具有数据库扩展名）还是目录
    const hasDbExtension = /\.(sqlite3?|db|duckdb|ddb)$/i.test(expandedPath)

    // 如果是以下情况，则视为目录：
    // - 以 / 结尾
    // - 已存在且为目录
    // - 没有数据库文件扩展名（假定为目录路径）
    const isDirectory =
      expandedPath.endsWith('/') ||
      (existsSync(expandedPath) && statSync(expandedPath).isDirectory()) ||
      !hasDbExtension

    let finalPath: string
    if (isDirectory) {
      // 去掉尾部斜杠（如果存在），然后拼接文件名
      const dirPath = expandedPath.endsWith('/')
        ? expandedPath.slice(0, -1)
        : expandedPath
      finalPath = join(dirPath, currentFileName)
    } else {
      finalPath = expandedPath
    }

    if (finalPath === config.database) {
      console.log(uiInfo('位置未更改'))
      return await handleEditContainer(containerName)
    }

    // 检查源文件是否存在
    if (!existsSync(config.database)) {
      console.log(uiError(`未找到源文件：${config.database}`))
      return await handleEditContainer(containerName)
    }

    // 检查目标是否已存在
    if (existsSync(finalPath)) {
      console.log(uiError(`目标文件已存在：${finalPath}`))
      return await handleEditContainer(containerName)
    }

    // 检查目标目录是否存在
    const destDir = dirname(finalPath)
    if (!existsSync(destDir)) {
      console.log(uiWarning(`目录不存在：${destDir}`))
      const { createDir } = await escapeablePrompt<{ createDir: string }>([
        {
          type: 'list',
          name: 'createDir',
          message: '是否创建此目录？',
          choices: [
            { name: '是，创建', value: 'yes' },
            { name: '否，取消', value: 'no' },
          ],
        },
      ])

      if (createDir !== 'yes') {
        return await handleEditContainer(containerName)
      }

      try {
        mkdirSync(destDir, { recursive: true })
        console.log(uiSuccess(`目录已创建：${destDir}`))
      } catch (mkdirError) {
        console.log(uiError(`创建目录失败：${(mkdirError as Error).message}`))
        return await handleEditContainer(containerName)
      }
    }

    const spinner = createSpinner('正在移动数据库文件...')
    spinner.start()

    try {
      // 首先尝试重命名（快速，同一文件系统）
      try {
        renameSync(config.database, finalPath)
      } catch (renameErr) {
        const e = renameErr as NodeJS.ErrnoException
        // EXDEV = 跨设备链接，需要复制 + 删除
        if (e.code === 'EXDEV') {
          try {
            // 复制文件并保留模式/权限
            copyFileSync(config.database, finalPath)
            // 仅在成功复制后删除源文件
            unlinkSync(config.database)
          } catch (copyErr) {
            // 失败时清理部分目标文件
            if (existsSync(finalPath)) {
              try {
                unlinkSync(finalPath)
              } catch {
                // 忽略清理错误
              }
            }
            throw copyErr
          }
        } else {
          throw renameErr
        }
      }

      // 更新容器配置和注册表
      await containerManager.updateConfig(containerName, {
        database: finalPath,
      })
      // 根据引擎使用对应的注册表
      if (isSQLite) {
        await sqliteRegistry.update(containerName, { filePath: finalPath })
      } else if (isDuckDB) {
        await duckdbRegistry.update(containerName, { filePath: finalPath })
      }
      spinner.succeed(`数据库已移至 ${finalPath}`)

      // 等待用户看到成功消息后再刷新
      await pressEnterToContinue()
    } catch (error) {
      spinner.fail('移动数据库文件失败')
      console.log(uiError((error as Error).message))
      await pressEnterToContinue()
    }

    // 继续编辑（将获取最新配置）
    return await handleEditContainer(containerName)
  }

  return containerName
}

async function handleCloneFromSubmenu(
  sourceName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
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

    await showContainerSubmenu(targetName, showMainMenu)
  } catch (error) {
    spinner.fail(`克隆 "${sourceName}" 失败`)
    console.log(uiError((error as Error).message))
    await pressEnterToContinue()
  }
}

async function handleDetachContainer(
  containerName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const confirmed = await promptConfirm(
    `将 "${containerName}" 从 SpinDB 分离？（文件将保留在磁盘上）`,
    true,
  )

  if (!confirmed) {
    console.log(uiWarning('已取消'))
    await pressEnterToContinue()
    await showContainerSubmenu(containerName, showMainMenu)
    return
  }

  let filePath: string | undefined
  // 根据引擎使用对应的注册表
  if (config.engine === Engine.SQLite) {
    const entry = await sqliteRegistry.get(containerName)
    filePath = entry?.filePath
    await sqliteRegistry.remove(containerName)
  } else if (config.engine === Engine.DuckDB) {
    const entry = await duckdbRegistry.get(containerName)
    filePath = entry?.filePath
    await duckdbRegistry.remove(containerName)
  }

  console.log(uiSuccess(`已将 "${containerName}" 从 SpinDB 分离`))
  if (filePath) {
    console.log(chalk.gray(`  文件保留在：${filePath}`))
    console.log()
    console.log(chalk.gray('  重新关联：'))
    console.log(chalk.cyan(`    spindb attach ${filePath}`))
  }
  await pressEnterToContinue()
  await handleList(showMainMenu)
}

async function handleDelete(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const isRemote = isRemoteContainer(config)
  const confirmMsg = isRemote
    ? `取消链接 "${containerName}"？远程数据库不受影响。`
    : `确认删除 "${containerName}"？此操作无法撤销。`

  const confirmed = await promptConfirm(confirmMsg, false)

  if (!confirmed) {
    console.log(uiWarning(isRemote ? '取消链接已取消' : '删除已取消'))
    return
  }

  // 远程容器：跳过进程检查
  if (!isRemote) {
    const running = await processManager.isRunning(containerName, {
      engine: config.engine,
    })

    if (running) {
      const stopSpinner = createSpinner(`正在停止 ${containerName}...`)
      stopSpinner.start()

      const engine = getEngine(config.engine)
      await engine.stop(config)

      stopSpinner.succeed(`已停止 "${containerName}"`)
    }
  }

  const deleteSpinner = createSpinner(
    isRemote
      ? `正在取消链接 ${containerName}...`
      : `正在删除 ${containerName}...`,
  )
  deleteSpinner.start()

  await containerManager.delete(containerName, { force: true })

  if (isRemote) {
    deleteSpinner.succeed(`已取消链接 "${containerName}"`)
    console.log(chalk.gray('  远程数据库不受影响。'))
  } else {
    deleteSpinner.succeed(`容器 "${containerName}" 已删除`)
  }
}

async function isDockerContainerRunning(
  containerName: string,
): Promise<boolean> {
  try {
    const { execSync } = await import('child_process')
    const result = execSync(
      `docker ps --filter "name=spindb-${containerName}" --format "{{.Names}}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return result.trim().includes(`spindb-${containerName}`)
  } catch {
    return false
  }
}

async function handleExportSubmenu(
  containerName: string,
  databases: string[],
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  // 检查 Docker 导出是否已存在
  const hasDockerExport = dockerExportExists(containerName, config.engine)

  // 检查 Docker 容器是否正在运行（仅当导出存在时）
  let dockerRunning = false
  if (hasDockerExport) {
    dockerRunning = await isDockerContainerRunning(containerName)
  }

  console.log()
  console.log(header('导出'))
  console.log()

  // 根据导出是否存在构建选项
  const choices: MenuChoice[] = []

  if (hasDockerExport) {
    // 导出已存在：显示获取连接字符串的选项，并附带运行状态
    const runningStatus = dockerRunning
      ? chalk.green('运行中')
      : chalk.gray('未运行')
    choices.push({
      name: `${chalk.green('⎘')} 获取 Docker 连接字符串 ${chalk.gray(`(${runningStatus})`)}`,
      value: 'docker-url',
    })
    choices.push({
      name: `${chalk.cyan('▣')} Docker ${chalk.gray('（重新导出 - 将使原始凭据失效）')}`,
      value: 'docker',
    })
  } else {
    // 无导出：仅显示 Docker 选项
    choices.push({ name: `${chalk.cyan('▣')} Docker`, value: 'docker' })
  }

  choices.push(new inquirer.Separator())
  choices.push({ name: `${chalk.blue('←')} 返回`, value: 'back' })
  choices.push({ name: `${chalk.blue('⌂')} 返回主菜单`, value: 'home' })

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '导出格式：',
      choices,
    },
  ])

  switch (action) {
    case 'docker-url':
      await handleGetDockerConnectionString(containerName, config.engine)
      await handleExportSubmenu(containerName, databases, showMainMenu)
      return
    case 'docker':
      await handleExportDocker(containerName, databases, showMainMenu)
      return
    case 'back':
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'home':
      await showMainMenu()
      return
  }
}

async function handleGetDockerConnectionString(
  containerName: string,
  engine: Engine,
): Promise<void> {
  const connectionString = await getDockerConnectionString(
    containerName,
    engine,
  )

  if (!connectionString) {
    console.log()
    console.log(uiError('无法读取 Docker 导出凭据'))
    await pressEnterToContinue()
    return
  }

  // 复制到剪贴板
  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(uiSuccess('连接字符串已复制到剪贴板'))
  } else {
    console.log(uiWarning('无法复制到剪贴板'))
  }
  console.log()
  console.log(chalk.gray('  连接字符串：'))
  console.log(chalk.cyan(`  ${connectionString}`))
  console.log()

  await pressEnterToContinue()
}

async function handleExportDocker(
  containerName: string,
  databases: string[],
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    await showContainerSubmenu(containerName, showMainMenu)
    return
  }

  const engine = getEngine(config.engine)
  const engineDefaultPort = getEngineDefaults(config.engine).defaultPort

  // 确定输出目录
  const outputDir = join(
    paths.getContainerPath(containerName, { engine: config.engine }),
    'docker',
  )

  // 检查输出目录是否已存在
  if (existsSync(outputDir)) {
    console.log()
    console.log(uiWarning(`输出目录已存在：${outputDir}`))
    const shouldOverwrite = await promptConfirm('是否覆盖？', false)
    if (!shouldOverwrite) {
      console.log(uiInfo('导出已取消'))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu)
      return
    }
    // 删除现有目录
    try {
      await rm(outputDir, { recursive: true, force: true })
    } catch (error) {
      console.log(uiError(`删除现有目录失败：${(error as Error).message}`))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu)
      return
    }
  }

  // 确定目标端口
  let targetPort = engineDefaultPort
  if (config.port !== engineDefaultPort) {
    console.log()
    console.log(
      chalk.yellow(
        `本地容器使用端口 ${chalk.cyan(String(config.port))}，但 ${engine.displayName} 的标准端口是 ${chalk.cyan(String(engineDefaultPort))}。`,
      ),
    )
    const { selectedPort } = await escapeablePrompt<{ selectedPort: number }>([
      {
        type: 'list',
        name: 'selectedPort',
        message: 'Docker 容器应使用哪个端口？',
        choices: [
          {
            name: `${engineDefaultPort} ${chalk.gray('（标准端口 - 推荐）')}`,
            value: engineDefaultPort,
          },
          {
            name: `${config.port} ${chalk.gray('（与本地容器相同）')}`,
            value: config.port,
          },
        ],
        default: engineDefaultPort,
      },
    ])
    targetPort = selectedPort
  }

  console.log()
  console.log(
    chalk.bold(`正在将 ${chalk.cyan(containerName)} 导出至 Docker...`),
  )
  console.log()

  // 为所有数据库创建备份（对于文件型数据库，直接复制文件）
  const backupPaths: Array<{ database: string; path: string }> = []
  const isFileBased = isFileBasedEngine(config.engine)

  if (isFileBased) {
    // 文件型数据库：直接复制数据库文件
    const copySpinner = createSpinner('正在复制数据库文件...')
    copySpinner.start()

    try {
      await mkdir(join(outputDir, 'data'), { recursive: true })

      // 从 config.database 获取数据库文件路径
      const dbFilePath = config.database
      if (!existsSync(dbFilePath)) {
        throw new Error(`未找到数据库文件：${dbFilePath}`)
      }

      // 以原始文件名复制到数据目录
      const destPath = join(outputDir, 'data', basename(dbFilePath))
      copyFileSync(dbFilePath, destPath)

      const fileSize = (await stat(destPath)).size
      backupPaths.push({ database: config.database, path: destPath })

      copySpinner.succeed(`数据库文件已复制（${formatBytes(fileSize)}）`)
    } catch (error) {
      copySpinner.fail('复制数据库文件失败')
      console.log(uiError((error as Error).message))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu)
      return
    }
  } else {
    // 服务端数据库：使用引擎的备份方法创建备份
    const backupSpinner = createSpinner(
      databases.length > 1
        ? `正在为 ${databases.length} 个数据库创建备份...`
        : '正在创建数据库备份...',
    )
    backupSpinner.start()

    try {
      await mkdir(join(outputDir, 'data'), { recursive: true })

      for (const db of databases) {
        const backupPath = getExportBackupPath(
          outputDir,
          containerName,
          db,
          config.engine,
        )
        const format = getDefaultFormat(config.engine)
        const result = await engine.backup(config, backupPath, {
          database: db,
          format,
        })
        backupPaths.push({ database: db, path: result.path })
      }

      const totalSize = await Promise.all(
        backupPaths.map(async (bp) => (await stat(bp.path)).size),
      ).then((sizes) => sizes.reduce((a, b) => a + b, 0))

      backupSpinner.succeed(
        databases.length > 1
          ? `已为 ${databases.length} 个数据库创建备份（${formatBytes(totalSize)}）`
          : `备份已创建（${formatBytes(totalSize)}）`,
      )
    } catch (error) {
      backupSpinner.fail('备份失败')
      console.log(uiError((error as Error).message))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu)
      return
    }
  }

  // 生成 Docker 构建物
  const exportSpinner = createSpinner('正在生成 Docker 构建物...')
  exportSpinner.start()

  try {
    const result = await exportToDocker(config, {
      outputDir,
      port: targetPort,
      includeData: true,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
      skipTLS: isFileBased, // 跳过文件型数据库的 TLS（无网络连接）
    })

    exportSpinner.succeed('Docker 构建物已生成')

    console.log()
    console.log(uiSuccess(`已将 ${chalk.cyan(containerName)} 导出至 Docker`))
    console.log()

    // 显示摘要
    const lines = [
      `${chalk.bold(engine.displayName)} ${config.version}`,
      `端口：${chalk.green(String(targetPort))}`,
      databases.length > 1
        ? `数据库：${chalk.cyan(databases.join(', '))}`
        : `数据库：${chalk.cyan(config.database)}`,
      '',
      chalk.bold('生成的凭据'),
      chalk.gray('────────────────────────'),
      `用户名：${chalk.white(result.credentials.username)}`,
      `密码：${chalk.white(result.credentials.password)}`,
      chalk.gray('────────────────────────'),
      '',
      chalk.yellow('请立即保存这些凭据 — 存储在 .env 中'),
    ]

    // 使用主题的 box 函数进行简单框显示
    console.log(box(lines))

    console.log()
    console.log(chalk.gray('  输出：'), chalk.cyan(result.outputDir))
    console.log()
    console.log(chalk.bold('  运行方式：'))
    console.log(
      chalk.cyan(`    cd "${result.outputDir}" && docker compose up -d`),
    )
    console.log()
  } catch (error) {
    exportSpinner.fail('导出失败')
    console.log(uiError((error as Error).message))
  }

  await pressEnterToContinue()
  await showContainerSubmenu(containerName, showMainMenu)
}

async function handleCreateUser(
  containerName: string,
  activeDatabase?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  try {
    // 提示输入用户名
    const defaultUser = getDefaultUsername(config.engine)
    const { username } = await escapeablePrompt<{ username: string }>([
      {
        type: 'input',
        name: 'username',
        message: '用户名：',
        default: defaultUser,
        validate: (input: string) => {
          if (!input.trim()) return '用户名为必填项'
          if (!isValidUsername(input)) {
            return '必须以字母开头，仅包含字母/数字/下划线'
          }
          return true
        },
      },
    ])

    // 检查是否存在现有凭据
    if (credentialsExist(containerName, config.engine, username)) {
      const overwrite = await promptConfirm(
        `"${username}" 的凭据已存在。是否覆盖？`,
        false,
      )
      if (!overwrite) {
        console.log(chalk.yellow('凭据创建已取消。'))
        await pressEnterToContinue()
        return
      }
    }

    const password = generatePassword({ length: 20, alphanumericOnly: true })
    const engine = getEngine(config.engine)

    const spinner = createSpinner(`正在创建用户 "${username}"...`)
    spinner.start()

    let credentials
    try {
      credentials = await engine.createUser(config, {
        username,
        password,
        database: activeDatabase || config.database,
      })
      spinner.succeed(`已创建用户 "${username}"`)
    } catch (error) {
      spinner.fail(`创建用户 "${username}" 失败`)
      throw error
    }

    // 保存凭据（非致命 — 凭据已创建）
    let credentialFile: string | undefined
    try {
      credentialFile = await saveCredentials(
        containerName,
        config.engine,
        credentials,
      )
    } catch (error) {
      console.log(
        uiWarning(`无法将凭据保存到磁盘：${(error as Error).message}`),
      )
    }

    console.log()
    if (credentials.apiKey) {
      console.log(`  ${chalk.gray('密钥名称：')}  ${credentials.username}`)
      console.log(`  ${chalk.gray('API 密钥：')}   ${credentials.apiKey}`)
      console.log(
        `  ${chalk.gray('API URL：')}   ${credentials.connectionString}`,
      )
    } else {
      console.log(`  ${chalk.gray('用户名：')}  ${credentials.username}`)
      console.log(`  ${chalk.gray('密码：')}  ${credentials.password}`)
      if (credentials.database) {
        console.log(`  ${chalk.gray('数据库：')}  ${credentials.database}`)
      }
      console.log(
        `  ${chalk.gray('URL：')}       ${credentials.connectionString}`,
      )
    }
    if (credentialFile) {
      console.log()
      console.log(`  ${chalk.gray('保存至：')} ${credentialFile}`)
    }
    console.log()

    // 提示复制到剪贴板
    try {
      const copyText = credentials.apiKey || credentials.connectionString
      const copied = await platformService.copyToClipboard(copyText)
      if (copied) {
        console.log(
          uiSuccess(
            credentials.apiKey
              ? 'API 密钥已复制到剪贴板'
              : '连接字符串已复制到剪贴板',
          ),
        )
      }
    } catch {
      // 剪贴板失败无关紧要 — 凭据已在上面显示
    }
  } catch (error) {
    if (error instanceof UnsupportedOperationError) {
      console.log(uiError('此引擎不支持用户管理'))
    } else {
      console.log(uiError((error as Error).message))
    }
  }

  await pressEnterToContinue()
}

async function handleCreateDatabase(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })
  if (!isRunning) {
    console.log(
      uiError(
        `容器 "${containerName}" 未运行。请先使用以下命令启动：spindb start ${containerName}`,
      ),
    )
    await pressEnterToContinue()
    return
  }

  // 提示输入名称 — Escape 返回子菜单
  let dbName: string
  try {
    const result = await escapeablePrompt<{ dbName: string }>([
      {
        type: 'input',
        name: 'dbName',
        message: '新数据库名称：',
        validate: (input: string) => {
          if (!input.trim()) return '数据库名称为必填项'
          if (/\s/.test(input)) return '数据库名称不能包含空格'
          return true
        },
      },
    ])
    dbName = result.dbName
  } catch (error) {
    if (error instanceof EscapeError) return
    throw error
  }

  // 检查是否已存在
  const rawDatabases = config.databases || []
  const trackedDatabases = [...new Set([config.database, ...rawDatabases])]
  if (trackedDatabases.includes(dbName)) {
    console.log(uiError(`数据库 "${dbName}" 在 "${containerName}" 中已存在`))
    await pressEnterToContinue()
    return
  }

  const engine = getEngine(config.engine)

  // 检查数据库是否在服务器上存在（不仅仅是跟踪记录）
  try {
    const serverDatabases = await engine.listDatabases(config)
    if (serverDatabases.includes(dbName)) {
      console.log(
        uiError(
          `数据库 "${dbName}" 在服务器上已存在。使用 "spindb databases add ${containerName} ${dbName}" 进行跟踪。`,
        ),
      )
      await pressEnterToContinue()
      return
    }
  } catch {
    // listDatabases 不支持所有引擎 — 继续
  }

  try {
    const spinner = createSpinner(
      `正在 "${containerName}" 中创建数据库 "${dbName}"...`,
    )
    spinner.start()

    try {
      await engine.createDatabase(config, dbName)
      spinner.succeed(`已创建数据库 "${dbName}"`)
    } catch (error) {
      spinner.fail(`创建数据库 "${dbName}" 失败`)
      throw error
    }

    await containerManager.addDatabase(containerName, dbName)

    const connectionString = engine.getConnectionString(config, dbName)
    console.log()
    console.log(uiSuccess(`数据库 "${dbName}" 已在 "${containerName}" 中创建`))
    console.log()
    console.log(chalk.gray('  连接：'), chalk.cyan(connectionString))
  } catch (error) {
    console.log(uiError((error as Error).message))
  }

  await pressEnterToContinue()
}

async function handleSetDefaultDatabase(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })
  if (!isRunning) {
    console.log(
      uiError(
        `容器 "${containerName}" 未运行。请先使用以下命令启动：spindb start ${containerName}`,
      ),
    )
    await pressEnterToContinue()
    return
  }

  const engine = getEngine(config.engine)

  // 查询服务器以获取实际数据库，回退到跟踪列表
  let availableDatabases: string[]
  try {
    availableDatabases = await engine.listDatabases(config)
  } catch {
    const rawDatabases = config.databases || []
    availableDatabases = [...new Set([config.database, ...rawDatabases])]
  }

  // 过滤掉当前默认数据库
  const selectable = availableDatabases.filter((db) => db !== config.database)

  if (selectable.length === 0) {
    console.log(
      uiWarning(
        `在 "${containerName}" 中未找到其他数据库。请先使用以下命令创建：spindb databases create ${containerName}`,
      ),
    )
    await pressEnterToContinue()
    return
  }

  console.log(chalk.gray(`  当前默认数据库：${chalk.cyan(config.database)}`))

  let dbName: string
  try {
    const result = await escapeablePrompt<{ dbName: string }>([
      {
        type: 'list',
        name: 'dbName',
        message: '选择新的默认数据库：',
        choices: selectable.map((db) => ({ name: db, value: db })),
        pageSize: getPageSize(),
      },
    ])
    dbName = result.dbName
  } catch (error) {
    if (error instanceof EscapeError) return
    throw error
  }

  // 如果尚未跟踪，添加到跟踪列表
  const trackedDatabases = config.databases || []
  if (!trackedDatabases.includes(dbName) && dbName !== config.database) {
    await containerManager.addDatabase(containerName, dbName)
  }

  await containerManager.updateConfig(containerName, { database: dbName })

  console.log()
  console.log(
    uiSuccess(`默认数据库已从 "${config.database}" 更改为 "${dbName}"`),
  )
  await pressEnterToContinue()
}

async function handleRenameDatabase(
  containerName: string,
  targetDatabase?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })
  if (!isRunning) {
    console.log(
      uiError(
        `容器 "${containerName}" 未运行。请先使用以下命令启动：spindb start ${containerName}`,
      ),
    )
    await pressEnterToContinue()
    return
  }

  const rawDatabases = config.databases || []
  const trackedDatabases = [...new Set([config.database, ...rawDatabases])]

  if (trackedDatabases.length === 0) {
    console.log(uiError(`在 "${containerName}" 中没有可重命名的数据库`))
    await pressEnterToContinue()
    return
  }

  // 选择要重命名的数据库 — 若提供了 targetDatabase 则跳过提示
  let oldName: string
  if (targetDatabase) {
    oldName = targetDatabase
  } else {
    try {
      const result = await escapeablePrompt<{ oldName: string }>([
        {
          type: 'list',
          name: 'oldName',
          message: '选择要重命名的数据库：',
          choices: trackedDatabases.map((db) => {
            const isDefault = db === config.database
            return {
              name: isDefault ? `${db} (默认)` : db,
              value: db,
            }
          }),
        },
      ])
      oldName = result.oldName
    } catch (error) {
      if (error instanceof EscapeError) return
      throw error
    }
  }

  // 输入新名称 — Escape 返回子菜单
  let newName: string
  try {
    const result = await escapeablePrompt<{ newName: string }>([
      {
        type: 'input',
        name: 'newName',
        message: `"${oldName}" 的新名称：`,
        validate: (input: string) => {
          if (!input.trim()) return '数据库名称为必填项'
          if (/\s/.test(input)) return '数据库名称不能包含空格'
          if (input === oldName) return '新名称必须与原名称不同'
          if (trackedDatabases.includes(input)) return `"${input}" 已存在`
          return true
        },
      },
    ])
    newName = result.newName
  } catch (error) {
    if (error instanceof EscapeError) return
    throw error
  }

  try {
    const isPrimaryRename = oldName === config.database
    if (isPrimaryRename) {
      console.log(
        uiWarning(`这将重命名默认数据库。默认数据库将更新为 "${newName}"。`),
      )
    }

    const caps = getDatabaseCapabilities(config.engine)
    const engine = getEngine(config.engine)
    let shouldDrop = true
    let dropSucceeded = false
    let backupPath: string | undefined

    if (caps.supportsRename === 'native') {
      // 原生重命名（PostgreSQL、ClickHouse、CockroachDB、Meilisearch）—— 即时，无需备份
      const spinner = createSpinner(
        `正在将 "${oldName}" 重命名为 "${newName}"...`,
      )
      spinner.start()
      try {
        await engine.renameDatabase(config, oldName, newName)
        spinner.succeed(`已将 "${oldName}" 重命名为 "${newName}"`)
        dropSucceeded = true // 原生重命名原子性地替换旧名称
      } catch (error) {
        spinner.fail(`重命名数据库失败`)
        throw error
      }
    } else {
      // 通过备份/恢复进行重命名 —— 向用户解释策略
      console.log()
      console.log(uiInfo(`${engine.displayName} 不支持原生的数据库重命名。`))
      console.log(
        chalk.gray(
          `  我们将把 "${oldName}" 克隆到名为 "${newName}" 的新数据库中，`,
        ),
      )
      console.log(chalk.gray(`  然后询问您是否要删除原始数据库。`))
      console.log()

      await mkdir(paths.renameBackups, { recursive: true })

      const format = getDefaultFormat(config.engine)
      const extension = getBackupExtension(config.engine, format)
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '')
        .slice(0, 15)
      const backupFileName = `${containerName}-${oldName}-rename-${timestamp}${extension}`
      backupPath = join(paths.renameBackups, backupFileName)

      const spinner = createSpinner(`正在备份 "${oldName}"...`)
      spinner.start()

      // 步骤 1：备份
      try {
        await engine.backup(config, backupPath, {
          database: oldName,
          format,
        })
      } catch (error) {
        spinner.fail(`备份 "${oldName}" 失败`)
        throw error
      }

      // 步骤 2：创建新数据库
      spinner.text = `正在创建数据库 "${newName}"...`
      try {
        await engine.createDatabase(config, newName)
      } catch (error) {
        spinner.fail(`创建数据库 "${newName}" 失败`)
        throw error
      }

      // 步骤 3：恢复数据
      spinner.text = `正在将数据恢复到 "${newName}"...`
      try {
        await engine.restore({ ...config, database: newName }, backupPath, {
          database: newName,
        })
      } catch (error) {
        spinner.fail(`将数据恢复到 "${newName}" 失败`)
        // 回滚：删除新数据库，保留备份
        try {
          await engine.dropDatabase(config, newName)
        } catch {
          console.log(
            uiWarning(
              `无法删除部分创建的数据库 "${newName}" — 可能需要手动清理`,
            ),
          )
        }
        console.log(uiWarning(`安全备份保留在：${backupPath}`))
        throw error
      }

      spinner.succeed(`已将 "${oldName}" 克隆到 "${newName}"`)

      // 询问是否删除原始数据库
      console.log()
      console.log(uiSuccess('数据库克隆成功。'))
      try {
        shouldDrop = await promptConfirm(`删除原始数据库 "${oldName}"？`, true)
      } catch (error) {
        if (error instanceof EscapeError) {
          shouldDrop = false // Escape = 保留原始数据库
        } else {
          throw error
        }
      }

      if (shouldDrop) {
        const dropSpinner = createSpinner(`正在删除旧数据库 "${oldName}"...`)
        dropSpinner.start()
        try {
          await engine.terminateConnections(config, oldName)
          await engine.dropDatabase(config, oldName)
          dropSpinner.succeed(`已删除旧数据库 "${oldName}"`)
          dropSucceeded = true
        } catch (error) {
          dropSpinner.warn(`无法删除 "${oldName}"：${(error as Error).message}`)
          // 非致命 — 数据已安全转移到新数据库
        }
      } else {
        console.log(
          chalk.gray(`  已保留 "${oldName}" — 两个数据库目前均存在。`),
        )
      }
    }

    // 更新跟踪
    await updateRenameTracking(containerName, oldName, newName, {
      shouldDrop: dropSucceeded,
      isPrimaryRename,
    })

    // 摘要
    const connectionString = engine.getConnectionString(
      { ...config, database: newName },
      newName,
    )
    console.log()
    console.log(uiSuccess(`已重命名 "${oldName}" → "${newName}"`))
    console.log()
    console.log(chalk.gray('  连接：'), chalk.cyan(connectionString))
    if (backupPath) {
      console.log(chalk.gray('  备份：    '), chalk.white(backupPath))
    }
    if (isPrimaryRename) {
      console.log(chalk.gray(`  默认数据库已更新为 "${newName}"。`))
    }
  } catch (error) {
    console.log(uiError((error as Error).message))
  }

  await pressEnterToContinue()
}

async function handleDropDatabase(
  containerName: string,
  targetDatabase?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`容器 "${containerName}" 未找到`))
    await pressEnterToContinue()
    return
  }

  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })
  if (!isRunning) {
    console.log(
      uiError(
        `容器 "${containerName}" 未运行。请先使用以下命令启动：spindb start ${containerName}`,
      ),
    )
    await pressEnterToContinue()
    return
  }

  // 选择要删除的数据库 — 若提供了 targetDatabase 则跳过提示
  let dbName: string
  if (targetDatabase) {
    if (targetDatabase === config.database) {
      console.log(
        uiError(`无法删除默认数据库。请使用 "spindb delete" 删除容器。`),
      )
      await pressEnterToContinue()
      return
    }
    dbName = targetDatabase
  } else {
    const rawDatabases = config.databases || []
    const trackedDatabases = [...new Set([config.database, ...rawDatabases])]
    const droppable = trackedDatabases.filter((db) => db !== config.database)

    if (droppable.length === 0) {
      console.log(uiError(`没有可删除的数据库。无法删除默认数据库。`))
      await pressEnterToContinue()
      return
    }

    try {
      console.log(
        chalk.gray(
          `  默认数据库 "${config.database}" 被排除 — 请使用 "spindb delete" 删除容器。`,
        ),
      )
      const result = await escapeablePrompt<{ dbName: string }>([
        {
          type: 'list',
          name: 'dbName',
          message: '选择要删除的数据库：',
          choices: droppable.map((db) => ({ name: db, value: db })),
        },
      ])
      dbName = result.dbName
    } catch (error) {
      if (error instanceof EscapeError) return
      throw error
    }
  }

  // 确认 — Escape 取消
  let confirm: boolean
  try {
    confirm = await promptConfirm(
      `从 ${config.engine} 容器 "${containerName}" 中删除数据库 "${dbName}"？此操作无法撤销。`,
      false,
    )
  } catch (error) {
    if (error instanceof EscapeError) return
    throw error
  }
  if (!confirm) {
    console.log(chalk.gray('已取消。'))
    await pressEnterToContinue()
    return
  }

  try {
    const engine = getEngine(config.engine)

    const spinner = createSpinner(
      `正在从 "${containerName}" 中删除数据库 "${dbName}"...`,
    )
    spinner.start()

    try {
      await engine.terminateConnections(config, dbName)
      await engine.dropDatabase(config, dbName)
      spinner.succeed(`已删除数据库 "${dbName}"`)
    } catch (error) {
      spinner.fail(`删除数据库 "${dbName}" 失败`)
      throw error
    }

    await containerManager.removeDatabase(containerName, dbName)

    console.log()
    console.log(uiSuccess(`数据库 "${dbName}" 已从 "${containerName}" 中删除`))
  } catch (error) {
    console.log(uiError((error as Error).message))
  }

  await pressEnterToContinue()
}