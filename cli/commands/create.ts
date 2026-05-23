import { Command } from 'commander'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import {
  promptCreateOptions,
  promptInstallDependencies,
  promptContainerName,
  promptConfirm,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { header, connectionBox } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { startWithRetry } from '../../core/start-with-retry'
import { TransactionManager } from '../../core/transaction-manager'
import { isValidDatabaseName, exitWithError } from '../../core/error-handler'
import { resolve } from 'path'
import { Engine, Platform, ALL_ENGINES } from '../../types'
import { canCreateDatabase } from '../../core/database-capabilities'
import {
  FERRETDB_VERSION_MAP,
  isV1 as isFerretDBv1,
} from '../../engines/ferretdb/version-maps'
import type { BaseEngine } from '../../engines/base-engine'
import { getEngineMetadata } from '../helpers'

/**
 * 简化的 SQLite 容器创建流程
 * SQLite 是基于文件的，因此不需要端口、启动/停止或服务器管理
 */
async function createSqliteContainer(
  containerName: string,
  dbEngine: BaseEngine,
  version: string,
  options: {
    path?: string
    from?: string | null
    connect?: boolean
    force?: boolean
    json?: boolean
  },
): Promise<void> {
  const {
    path: filePath,
    from: restoreLocation,
    connect,
    force,
    json,
  } = options

  // 检查依赖
  const depsSpinner = json ? null : createSpinner('正在检查必需工具...')
  depsSpinner?.start()

  const missingDeps = await getMissingDependencies('sqlite')
  if (missingDeps.length > 0) {
    if (json) {
      return exitWithError({
        message: `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
        json: true,
      })
    }
    depsSpinner?.warn(
      `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
    )
    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      'sqlite',
    )
    if (!installed) {
      return exitWithError({ message: '必需工具未安装' })
    }
  } else {
    depsSpinner?.succeed('必需工具可用')
  }

  // 检查容器是否已存在
  if (await containerManager.exists(containerName)) {
    if (force) {
      // 强制删除现有容器
      if (!json) {
        console.log(
          chalk.yellow(`  正在移除现有容器 "${containerName}"...`),
        )
      }
      await containerManager.delete(containerName, { force: true })
    } else if (json) {
      return exitWithError({
        message: `容器 "${containerName}" 已存在。使用 --force 覆盖。`,
        json: true,
      })
    } else {
      while (await containerManager.exists(containerName)) {
        console.log(
          chalk.yellow(`  容器 "${containerName}" 已存在。`),
        )
        containerName = await promptContainerName()
      }
    }
  }

  // 确定文件路径
  const defaultPath = `./${containerName}.sqlite`
  const absolutePath = resolve(filePath || defaultPath)

  // 检查文件是否已存在
  if (existsSync(absolutePath)) {
    return exitWithError({
      message: `文件已存在：${absolutePath}`,
      json,
    })
  }

  const createSpinnerInstance = json
    ? null
    : createSpinner('正在创建 SQLite 数据库...')
  createSpinnerInstance?.start()

  try {
    // 初始化 SQLite 数据库文件并在注册表中注册
    await dbEngine.initDataDir(containerName, version, { path: absolutePath })
    createSpinnerInstance?.succeed('SQLite 数据库已创建')
  } catch (error) {
    createSpinnerInstance?.fail('创建 SQLite 数据库失败')
    throw error
  }

  // 处理 --from 恢复
  if (restoreLocation) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const format = await dbEngine.detectBackupFormat(restoreLocation)
      const restoreSpinner = json
        ? null
        : createSpinner(`正在从 ${format.description} 恢复...`)
      restoreSpinner?.start()

      try {
        await dbEngine.restore(config, restoreLocation)
        restoreSpinner?.succeed('备份恢复成功')
      } catch (error) {
        restoreSpinner?.fail('恢复备份失败')
        // 恢复失败时清理创建的容器
        try {
          await containerManager.delete(containerName, { force: true })
        } catch {
          // 忽略清理错误 - 仍然抛出原始恢复错误
        }
        throw error
      }
    }
  }

  const connectionString = `sqlite:///${absolutePath}`

  // 显示成功信息
  if (json) {
    const metadata = await getEngineMetadata('sqlite')
    console.log(
      JSON.stringify({
        success: true,
        name: containerName,
        engine: 'sqlite',
        version,
        path: absolutePath,
        database: containerName,
        connectionString,
        restored: !!restoreLocation,
        ...metadata,
      }),
    )
  } else {
    console.log()
    console.log(chalk.green('  ✓ SQLite 数据库就绪'))
    console.log()
    console.log(chalk.gray('  文件路径：'))
    console.log(chalk.cyan(`    ${absolutePath}`))
    console.log()
    console.log(chalk.gray('  连接字符串：'))
    console.log(chalk.cyan(`    ${connectionString}`))
    console.log()

    if (connect) {
      const config = await containerManager.getConfig(containerName)
      if (config) {
        console.log(chalk.gray('  正在打开 Shell...'))
        console.log()
        await dbEngine.connect(config)
      }
    } else {
      console.log(chalk.gray('  使用以下命令连接：'))
      console.log(chalk.cyan(`    spindb connect ${containerName}`))
      console.log()
    }
  }
}

/**
 * 简化的 DuckDB 容器创建流程
 * DuckDB 是基于文件的，因此不需要端口、启动/停止或服务器管理
 */
async function createDuckDBContainer(
  containerName: string,
  dbEngine: BaseEngine,
  version: string,
  options: {
    path?: string
    from?: string | null
    connect?: boolean
    force?: boolean
    json?: boolean
  },
): Promise<void> {
  const {
    path: filePath,
    from: restoreLocation,
    connect,
    force,
    json,
  } = options

  // 检查依赖
  const depsSpinner = json ? null : createSpinner('正在检查必需工具...')
  depsSpinner?.start()

  const missingDeps = await getMissingDependencies('duckdb')
  if (missingDeps.length > 0) {
    if (json) {
      return exitWithError({
        message: `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
        json: true,
      })
    }
    depsSpinner?.warn(
      `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
    )
    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      'duckdb',
    )
    if (!installed) {
      return exitWithError({ message: '必需工具未安装' })
    }
  } else {
    depsSpinner?.succeed('必需工具可用')
  }

  // 检查容器是否已存在
  if (await containerManager.exists(containerName)) {
    if (force) {
      // 强制删除现有容器
      if (!json) {
        console.log(
          chalk.yellow(`  正在移除现有容器 "${containerName}"...`),
        )
      }
      await containerManager.delete(containerName, { force: true })
    } else if (json) {
      return exitWithError({
        message: `容器 "${containerName}" 已存在。使用 --force 覆盖。`,
        json: true,
      })
    } else {
      while (await containerManager.exists(containerName)) {
        console.log(
          chalk.yellow(`  容器 "${containerName}" 已存在。`),
        )
        containerName = await promptContainerName()
      }
    }
  }

  // 确定文件路径 — 如果提供了明确的 --path 则使用，否则让
  // initDataDir 默认使用容器目录（而非 CWD，后者在
  // 本地 CLI 和云端 docker exec 环境之间会有所不同）
  const absolutePath = filePath ? resolve(filePath) : undefined

  // 检查文件是否已存在（当提供明确路径时）
  if (absolutePath && existsSync(absolutePath)) {
    return exitWithError({
      message: `文件已存在：${absolutePath}`,
      json,
    })
  }

  const createSpinnerInstance = json
    ? null
    : createSpinner('正在创建 DuckDB 数据库...')
  createSpinnerInstance?.start()

  try {
    // 初始化 DuckDB 数据库文件并在注册表中注册
    await dbEngine.initDataDir(
      containerName,
      version,
      absolutePath ? { path: absolutePath } : {},
    )
    createSpinnerInstance?.succeed('DuckDB 数据库已创建')
  } catch (error) {
    createSpinnerInstance?.fail('创建 DuckDB 数据库失败')
    throw error
  }

  // 处理 --from 恢复
  if (restoreLocation) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const format = await dbEngine.detectBackupFormat(restoreLocation)
      const restoreSpinner = json
        ? null
        : createSpinner(`正在从 ${format.description} 恢复...`)
      restoreSpinner?.start()

      try {
        await dbEngine.restore(config, restoreLocation)
        restoreSpinner?.succeed('备份恢复成功')
      } catch (error) {
        restoreSpinner?.fail('恢复备份失败')
        // 恢复失败时清理创建的容器
        try {
          await containerManager.delete(containerName, { force: true })
        } catch {
          // 忽略清理错误 - 仍然抛出原始恢复错误
        }
        throw error
      }
    }
  }

  // 从注册表获取实际文件路径（initDataDir 可能使用了默认值）
  const registryEntry = await (
    await import('../../engines/duckdb/registry.js')
  ).duckdbRegistry.get(containerName)
  const actualPath = registryEntry?.filePath || absolutePath || containerName
  const connectionString = `duckdb:///${actualPath}`

  // 显示成功信息
  if (json) {
    const metadata = await getEngineMetadata('duckdb')
    console.log(
      JSON.stringify({
        success: true,
        name: containerName,
        engine: 'duckdb',
        version,
        path: absolutePath,
        database: containerName,
        connectionString,
        restored: !!restoreLocation,
        ...metadata,
      }),
    )
  } else {
    console.log()
    console.log(chalk.green('  ✓ DuckDB 数据库就绪'))
    console.log()
    console.log(chalk.gray('  文件路径：'))
    console.log(chalk.cyan(`    ${absolutePath}`))
    console.log()
    console.log(chalk.gray('  连接字符串：'))
    console.log(chalk.cyan(`    ${connectionString}`))
    console.log()

    if (connect) {
      const config = await containerManager.getConfig(containerName)
      if (config) {
        console.log(chalk.gray('  正在打开 Shell...'))
        console.log()
        await dbEngine.connect(config)
      }
    } else {
      console.log(chalk.gray('  使用以下命令连接：'))
      console.log(chalk.cyan(`    spindb connect ${containerName}`))
      console.log()
    }
  }
}

export function detectLocationType(location: string): {
  type: 'connection' | 'file' | 'not_found'
  inferredEngine?: Engine
} {
  if (
    location.startsWith('postgresql://') ||
    location.startsWith('postgres://')
  ) {
    return { type: 'connection', inferredEngine: Engine.PostgreSQL }
  }

  if (location.startsWith('mysql://')) {
    return { type: 'connection', inferredEngine: Engine.MySQL }
  }

  if (location.startsWith('sqlite://')) {
    return { type: 'connection', inferredEngine: Engine.SQLite }
  }

  if (location.startsWith('duckdb://')) {
    return { type: 'connection', inferredEngine: Engine.DuckDB }
  }

  if (location.startsWith('redis://') || location.startsWith('rediss://')) {
    return { type: 'connection', inferredEngine: Engine.Redis }
  }

  if (location.startsWith('valkey://') || location.startsWith('valkeys://')) {
    return { type: 'connection', inferredEngine: Engine.Valkey }
  }

  if (location.startsWith('meilisearch://')) {
    return { type: 'connection', inferredEngine: Engine.Meilisearch }
  }

  if (location.startsWith('influxdb://')) {
    return { type: 'connection', inferredEngine: Engine.InfluxDB }
  }

  if (existsSync(location)) {
    // 检查是否为 SQLite 文件（不区分大小写）
    const lowerLocation = location.toLowerCase()
    if (
      lowerLocation.endsWith('.sqlite') ||
      lowerLocation.endsWith('.sqlite3')
    ) {
      return { type: 'file', inferredEngine: Engine.SQLite }
    }
    // 检查是否为 DuckDB 文件（不区分大小写）
    // 注意：我们不会从 '.db' 扩展名推断 DuckDB，因为它通常被 SQLite 使用
    if (lowerLocation.endsWith('.duckdb') || lowerLocation.endsWith('.ddb')) {
      return { type: 'file', inferredEngine: Engine.DuckDB }
    }
    return { type: 'file' }
  }

  return { type: 'not_found' }
}

export const createCommand = new Command('create')
  .description('创建新的数据库容器')
  .argument('[name]', '容器名称')
  .option(
    '-e, --engine <engine>',
    `数据库引擎（${ALL_ENGINES.join(', ')}）`,
  )
  .option('--db-version <version>', '数据库版本（例如：17, 8.0）')
  .option('-d, --database <database>', '数据库名称')
  .option('-p, --port <port>', '端口号')
  .option(
    '--path <path>',
    'SQLite/DuckDB 数据库文件路径（默认：./<name>.sqlite 或 ./<name>.duckdb）',
  )
  .option(
    '--max-connections <number>',
    '最大数据库连接数（默认：200）',
  )
  .option(
    '-f, --force',
    '覆盖现有容器而无需提示（删除现有数据）',
  )
  .option('--start', '创建后启动容器（跳过提示）')
  .option('--no-start', '创建后不启动容器')
  .option('--connect', '创建后打开 Shell 连接')
  .option(
    '--from <location>',
    '创建后从转储文件或连接字符串恢复',
  )
  .option('-j, --json', '以 JSON 格式输出结果')
  .option(
    '--show-deprecated',
    '在版本选择列表中显示已弃用的版本',
  )
  .action(
    async (
      name: string | undefined,
      options: {
        engine?: string
        dbVersion?: string
        database?: string
        port?: string
        path?: string
        maxConnections?: string
        force?: boolean
        start?: boolean
        connect?: boolean
        from?: string
        json?: boolean
        showDeprecated?: boolean
      },
    ) => {
      let tempDumpPath: string | null = null

      try {
        let containerName = name
        let engine: Engine = (options.engine as Engine) || Engine.PostgreSQL
        let version = options.dbVersion
        let database = options.database

        let restoreLocation: string | null = null
        let restoreType: 'connection' | 'file' | null = null

        if (options.from) {
          const locationInfo = detectLocationType(options.from)

          if (locationInfo.type === 'not_found') {
            return exitWithError({
              message: `未找到位置：${options.from}。请提供有效的文件路径或连接字符串（postgresql://, mysql://, redis://, sqlite://, duckdb://）`,
              json: options.json,
            })
          }

          restoreLocation = options.from
          restoreType = locationInfo.type

          if (!options.engine && locationInfo.inferredEngine) {
            engine = locationInfo.inferredEngine
            if (!options.json) {
              console.log(
                chalk.gray(
                  `  从连接字符串推断引擎 "${engine}"`,
                ),
              )
            }
          }

          if (options.start === false) {
            return exitWithError({
              message:
                '无法将 --no-start 与 --from 一起使用（恢复需要运行中的容器）',
              json: options.json,
            })
          }
        }

        const engineDefaults = getEngineDefaults(engine)

        if (!version) {
          version = engineDefaults.defaultVersion
        }

        if (!containerName) {
          // JSON 模式需要容器名称参数
          if (options.json) {
            return exitWithError({
              message: '容器名称是必需的',
              json: true,
            })
          }

          const answers = await promptCreateOptions({
            showDeprecated: options.showDeprecated,
          })
          containerName = answers.name
          engine = answers.engine as Engine
          version = answers.version
          database = answers.database
        }

        // FerretDB：在 Windows 上强制使用 v1（v2 需要 postgresql-documentdb，Windows 上不可用）
        // 在 CLI 和交互式路径都解析了引擎 + 版本之后运行
        if (
          engine === Engine.FerretDB &&
          !isFerretDBv1(version) &&
          platformService.getPlatformInfo().platform === Platform.Win32
        ) {
          version = FERRETDB_VERSION_MAP['1']
          if (!options.json) {
            console.log(
              chalk.yellow(
                `  FerretDB v2 在 Windows 上不受支持 — 使用 v1（${version}）`,
              ),
            )
          }
        }


        // Redis/Valkey 使用编号数据库（0-15），默认为 "0"
        // 其他引擎默认使用容器名称（将连字符替换为下划线以兼容 SQL）
        if (engine === Engine.Redis || engine === Engine.Valkey) {
          database = database ?? '0'
          // 验证 Redis/Valkey 数据库是否为纯整数字符串 0-15
          // 拒绝小数（"1.5"）、科学计数法（"1e2"）和尾部垃圾字符（"5abc"）
          if (!/^[0-9]+$/.test(database)) {
            return exitWithError({
              message:
                'Redis/Valkey 数据库必须是 0 到 15 之间的整数',
              json: options.json,
            })
          }
          const dbIndex = parseInt(database, 10)
          if (dbIndex < 0 || dbIndex > 15) {
            return exitWithError({
              message:
                'Redis/Valkey 数据库必须是 0 到 15 之间的整数',
              json: options.json,
            })
          }
        } else if (engine === Engine.TigerBeetle) {
          database = database ?? '0'
          if (!/^[0-9]+$/.test(database)) {
            return exitWithError({
              message: 'TigerBeetle 集群 ID 必须是非负整数',
              json: options.json,
            })
          }
          database = String(parseInt(database, 10))
        } else if (engine === Engine.LibSQL) {
          // libSQL 每个实例运行一个 SQLite 数据库
          database = database ?? 'main'
        } else {
          database = database ?? containerName.replace(/-/g, '_')
          // 验证数据库名称以防止 SQL 注入
          if (!isValidDatabaseName(database)) {
            return exitWithError({
              message:
                '数据库名称必须以字母开头，仅包含字母、数字和下划线',
              json: options.json,
            })
          }
        }

        if (!options.json) {
          console.log(header('创建数据库容器'))
          console.log()
        }

        const dbEngine = getEngine(engine)

        // 将解析的完整版本固定到容器配置中，以便将来的
        // spindb 升级（可能会将 defaults['18'] 从 18.4.0 → 18.6.0）
        // 不会静默地将现有容器移动到不同的二进制文件。
        // 容器锁定到创建时使用的版本；
        // `spindb doctor` 可以让用户稍后选择升级。
        const resolvedVersion = dbEngine.resolveFullVersion(version)
        if (resolvedVersion !== version && !options.json) {
          console.log(
            chalk.gray(
              `  已解析 ${dbEngine.displayName} ${version} → ${resolvedVersion}`,
            ),
          )
        }
        version = resolvedVersion

        // SQLite 有简化的流程（无端口，无启动/停止）
        if (engine === Engine.SQLite) {
          await createSqliteContainer(containerName, dbEngine, version, {
            path: options.path,
            from: restoreLocation,
            connect: options.connect,
            force: options.force,
            json: options.json,
          })
          return
        }

        // DuckDB 有简化的流程（无端口，无启动/停止）
        if (engine === Engine.DuckDB) {
          await createDuckDBContainer(containerName, dbEngine, version, {
            path: options.path,
            from: restoreLocation,
            connect: options.connect,
            force: options.force,
            json: options.json,
          })
          return
        }

        // 对于服务器数据库，验证 --connect 与 --no-start
        if (options.connect && options.start === false) {
          return exitWithError({
            message:
              '无法将 --no-start 与 --connect 一起使用（连接需要运行中的容器）',
            json: options.json,
          })
        }

        // 在 JSON 模式下，需要明确的 --start 或 --no-start 标志以避免交互式提示
        if (
          options.json &&
          options.start === undefined &&
          !restoreLocation &&
          !options.connect
        ) {
          return exitWithError({
            message:
              '在 JSON 模式下，必须为服务器数据库指定 --start 或 --no-start',
            json: true,
          })
        }

        // 如果提供了 --max-connections 则验证
        if (options.maxConnections) {
          const parsed = parseInt(options.maxConnections, 10)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return exitWithError({
              message:
                '无效的 --max-connections 值：必须是正整数',
              json: options.json,
            })
          }
        }

        const portSpinner = options.json
          ? null
          : createSpinner('正在查找可用端口...')
        portSpinner?.start()

        let port: number
        if (options.port) {
          port = parseInt(options.port, 10)
          const available = await portManager.isPortAvailable(port)
          if (!available) {
            portSpinner?.fail(`端口 ${port} 已被占用`)
            return exitWithError({
              message: `端口 ${port} 已被占用`,
              json: options.json,
            })
          }
          portSpinner?.succeed(`使用端口 ${port}`)
        } else {
          const { port: foundPort, isDefault } =
            await portManager.findAvailablePort({
              preferredPort: engineDefaults.defaultPort,
              portRange: engineDefaults.portRange,
            })
          port = foundPort
          if (isDefault) {
            portSpinner?.succeed(`使用默认端口 ${port}`)
          } else {
            portSpinner?.warn(
              `默认端口 ${engineDefaults.defaultPort} 已被占用，使用端口 ${port}`,
            )
          }
        }

        // 首先为所有引擎确保二进制文件 - 它们可能包含客户端工具
        // （例如 PostgreSQL 的 psql, pg_dump）并且 ensureBinaries 注册工具
        // 路径到配置缓存中，以便 getMissingDependencies 可以找到它们。
        // 在 Windows 上，像 Redis 这样的引擎没有系统回退路径，因此二进制文件
        // 必须在依赖检查之前下载，否则总是会失败。
        let binaryPath: string | undefined
        {
          const binarySpinner = options.json
            ? null
            : createSpinner(
                `正在检查 ${dbEngine.displayName} ${version} 二进制文件...`,
              )
          binarySpinner?.start()

          try {
            // ensureBinaries 优雅地处理缓存的二进制文件
            // 并在配置中注册客户端工具路径（依赖检查需要）
            binaryPath = await dbEngine.ensureBinaries(
              version,
              ({ stage, message }) => {
                if (binarySpinner) {
                  if (stage === 'cached') {
                    binarySpinner.text = `${dbEngine.displayName} ${version} 二进制文件就绪（已缓存）`
                  } else {
                    binarySpinner.text = message
                  }
                }
              },
            )
            binarySpinner?.succeed(
              `${dbEngine.displayName} ${version} 二进制文件就绪`,
            )
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error)
            binarySpinner?.fail(
              `${dbEngine.displayName} ${version} 不可用`,
            )
            if (options.json) {
              return exitWithError({
                message: `${dbEngine.displayName} ${version} 不可用：${detail}`,
                json: true,
              })
            }
            throw error
          }
        }

        // 检查依赖（所有引擎都需要）
        // 这在二进制下载之后运行，因此客户端工具可用
        const depsSpinner = options.json
          ? null
          : createSpinner('正在检查必需工具...')
        depsSpinner?.start()

        let missingDeps = await getMissingDependencies(engine)
        if (missingDeps.length > 0) {
          // 在 JSON 模式下，直接报错而不提示
          if (options.json) {
            return exitWithError({
              message: `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
              json: true,
            })
          }

          depsSpinner?.warn(
            `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            engine,
          )

          if (!installed) {
            return exitWithError({ message: '必需工具未安装' })
          }

          missingDeps = await getMissingDependencies(engine)
          if (missingDeps.length > 0) {
            return exitWithError({
              message: `仍然缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
            })
          }

          console.log(chalk.green('  ✓ 所有必需工具现已可用'))
          console.log()
        } else {
          depsSpinner?.succeed('必需工具可用')
        }

        if (await containerManager.exists(containerName)) {
          if (options.force) {
            // 如果容器正在运行则停止，然后删除
            const existingConfig =
              await containerManager.getConfig(containerName)
            if (existingConfig?.status === 'running') {
              if (!options.json) {
                console.log(
                  chalk.yellow(
                    `  正在停止现有容器 "${containerName}"...`,
                  ),
                )
              }
              try {
                await dbEngine.stop(existingConfig)
              } catch {
                // 忽略停止错误 - 容器可能已停止
              }
            }
            if (!options.json) {
              console.log(
                chalk.yellow(
                  `  正在移除现有容器 "${containerName}"...`,
                ),
              )
            }
            await containerManager.delete(containerName, { force: true })
          } else if (options.json) {
            return exitWithError({
              message: `容器 "${containerName}" 已存在。使用 --force 覆盖。`,
              json: true,
            })
          } else {
            while (await containerManager.exists(containerName)) {
              console.log(
                chalk.yellow(`  容器 "${containerName}" 已存在。`),
              )
              containerName = await promptContainerName()
            }
          }
        }

        const tx = new TransactionManager()

        const createSpinnerInstance = createSpinner('正在创建容器...')
        createSpinnerInstance.start()

        try {
          await containerManager.create(containerName, {
            engine: dbEngine.name as Engine,
            version,
            port,
            database,
            binaryPath,
          })

          tx.addRollback({
            description: `删除容器 "${containerName}"`,
            execute: async () => {
              await containerManager.delete(containerName, { force: true })
            },
          })

          createSpinnerInstance.succeed('容器已创建')
        } catch (error) {
          createSpinnerInstance.fail('创建容器失败')
          throw error
        }

        const initSpinner = createSpinner('正在初始化数据库集群...')
        initSpinner.start()

        try {
          await dbEngine.initDataDir(containerName, version, {
            port,
            superuser: engineDefaults.superuser,
            maxConnections: options.maxConnections
              ? parseInt(options.maxConnections, 10)
              : undefined,
          })
          initSpinner.succeed('数据库集群已初始化')
        } catch (error) {
          initSpinner.fail('初始化数据库集群失败')
          await tx.rollback()
          throw error
        }

        // --from 需要启动，--start 强制启动，--no-start 跳过，否则询问用户
        // --connect 对于服务器数据库意味着 --start
        let shouldStart = false
        if (restoreLocation || options.connect) {
          shouldStart = true
        } else if (options.start === true) {
          shouldStart = true
        } else if (options.start === false) {
          shouldStart = false
        } else {
          // 在非交互模式（无 TTY）下，默认不启动
          // 这允许脚本/CI 在没有 --no-start 标志的情况下运行
          if (!process.stdin.isTTY) {
            shouldStart = false
          } else {
            console.log()
            shouldStart = await promptConfirm(
              `现在启动 ${containerName} 吗？`,
              true,
            )
          }
        }

        const config = await containerManager.getConfig(containerName)

        if (shouldStart && config) {
          const startSpinner = createSpinner(
            `正在启动 ${dbEngine.displayName}...`,
          )
          startSpinner.start()

          try {
            const result = await startWithRetry({
              engine: dbEngine,
              config,
              onPortChange: (oldPort, newPort) => {
                startSpinner.text = `端口 ${oldPort} 已被占用，正在尝试端口 ${newPort}...`
                port = newPort
              },
            })

            if (!result.success) {
              startSpinner.fail(`启动 ${dbEngine.displayName} 失败`)
              await tx.rollback()
              if (result.error) {
                throw result.error
              }
              throw new Error('启动容器失败')
            }

            tx.addRollback({
              description: `停止容器 "${containerName}"`,
              execute: async () => {
                try {
                  await dbEngine.stop(config)
                } catch {
                  // 回滚时忽略停止错误
                }
              },
            })

            await containerManager.updateConfig(containerName, {
              status: 'running',
            })

            if (result.retriesUsed > 0) {
              startSpinner.warn(
                `${dbEngine.displayName} 已在端口 ${result.finalPort} 启动（原端口已被占用）`,
              )
            } else {
              startSpinner.succeed(`${dbEngine.displayName} 已启动`)
            }
          } catch (error) {
            if (!startSpinner.isSpinning) {
              // 错误已在上面处理
            } else {
              startSpinner.fail(`启动 ${dbEngine.displayName} 失败`)
            }
            await tx.rollback()
            throw error
          }

          const defaultDb = engineDefaults.superuser
          if (database !== defaultDb && canCreateDatabase(engine)) {
            const dbSpinner = createSpinner(
              `正在创建数据库 "${database}"...`,
            )
            dbSpinner.start()

            try {
              await dbEngine.createDatabase(config, database)
              dbSpinner.succeed(`数据库 "${database}" 已创建`)
            } catch (error) {
              dbSpinner.fail(`创建数据库 "${database}" 失败`)
              await tx.rollback()
              throw error
            }
          }
        }

        if (restoreLocation && restoreType && config && shouldStart) {
          let backupPath = ''

          if (restoreType === 'connection') {
            const timestamp = Date.now()
            tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

            let dumpSuccess = false
            let attempts = 0
            const maxAttempts = 2

            while (!dumpSuccess && attempts < maxAttempts) {
              attempts++
              const dumpSpinner = createSpinner(
                '正在从远程数据库创建转储...',
              )
              dumpSpinner.start()

              try {
                const dumpResult = await dbEngine.dumpFromConnectionString(
                  restoreLocation,
                  tempDumpPath,
                )
                dumpSpinner.succeed('已从远程数据库创建转储')
                if (dumpResult.warnings?.length) {
                  for (const warning of dumpResult.warnings) {
                    console.log(chalk.yellow(`  ${warning}`))
                  }
                }
                backupPath = tempDumpPath
                dumpSuccess = true
              } catch (error) {
                const e = error as Error
                dumpSpinner.fail('创建转储失败')

                if (
                  e.message.includes('pg_dump not found') ||
                  e.message.includes('ENOENT')
                ) {
                  // 在 JSON 模式下，不提示 - 直接报错退出
                  if (options.json) {
                    return exitWithError({
                      message: 'pg_dump 未安装',
                      json: true,
                    })
                  }
                  const installed = await promptInstallDependencies('pg_dump')
                  if (!installed) {
                    return exitWithError({
                      message: 'pg_dump 未安装',
                      json: options.json,
                    })
                  }
                  continue
                }

                return exitWithError({
                  message: `pg_dump 错误：${e.message}`,
                  json: options.json,
                })
              }
            }

            if (!dumpSuccess) {
              return exitWithError({
                message: '重试后仍无法创建转储',
                json: options.json,
              })
            }
          } else {
            backupPath = restoreLocation
          }

          const detectSpinner = createSpinner('正在检测备份格式...')
          detectSpinner.start()

          const format = await dbEngine.detectBackupFormat(backupPath)
          detectSpinner.succeed(`检测到：${format.description}`)

          const restoreSpinner = createSpinner('正在恢复备份...')
          restoreSpinner.start()

          const result = await dbEngine.restore(config, backupPath, {
            database,
            createDatabase: false,
          })

          if (result.code === 0) {
            restoreSpinner.succeed('备份恢复成功')
          } else {
            restoreSpinner.warn('恢复完成但有警告')
            if (result.stderr) {
              console.log(chalk.yellow('\n  警告：'))
              const lines = result.stderr.split('\n').slice(0, 5)
              lines.forEach((line) => {
                if (line.trim()) {
                  console.log(chalk.gray(`    ${line}`))
                }
              })
              if (result.stderr.split('\n').length > 5) {
                console.log(chalk.gray('    ...'))
              }
            }
          }
        }

        tx.commit()

        const finalConfig = await containerManager.getConfig(containerName)
        if (finalConfig) {
          const connectionString = dbEngine.getConnectionString(finalConfig)

          if (options.json) {
            const metadata = await getEngineMetadata(finalConfig.engine)
            console.log(
              JSON.stringify({
                success: true,
                name: containerName,
                engine: finalConfig.engine,
                version: finalConfig.version,
                port: finalConfig.port,
                database,
                connectionString,
                status: finalConfig.status,
                restored: !!restoreLocation,
                ...metadata,
              }),
            )
          } else {
            console.log()
            console.log(
              connectionBox(containerName, connectionString, finalConfig.port),
            )
            console.log()

            if (options.connect && shouldStart) {
              // --connect 标志：直接打开 Shell
              const copied =
                await platformService.copyToClipboard(connectionString)
              if (copied) {
                console.log(
                  chalk.gray('  连接字符串已复制到剪贴板'),
                )
              }
              console.log(chalk.gray('  正在打开 Shell...'))
              console.log()
              await dbEngine.connect(finalConfig, database)
            } else if (shouldStart) {
              console.log(chalk.gray('  使用以下命令连接：'))
              console.log(chalk.cyan(`  spindb connect ${containerName}`))

              const copied =
                await platformService.copyToClipboard(connectionString)
              if (copied) {
                console.log(
                  chalk.gray('  连接字符串已复制到剪贴板'),
                )
              }
              console.log()
            } else {
              console.log(chalk.gray('  启动容器：'))
              console.log(chalk.cyan(`  spindb start ${containerName}`))
              console.log()
            }
          }
        }
      } catch (error) {
        const e = error as Error

        const missingToolPatterns = [
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
          'mysql not found',
          'mysqldump not found',
          'mysqld not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.includes(p),
        )

        if (matchingPattern) {
          if (options.json) {
            return exitWithError({ message: e.message, json: true })
          }
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  请重新运行命令以继续。'),
            )
          }
          return exitWithError({
            message: '缺失必需工具',
            json: options.json,
          })
        }

        return exitWithError({ message: e.message, json: options.json })
      } finally {
        if (tempDumpPath) {
          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // 忽略清理错误
          }
        }
      }
    },
  )
