import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { basename } from 'path'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { paths } from '../../config/paths'
import { getEngine } from '../../engines'
import {
  getRemoteOrigin,
  isLayerbaseCloudRemote,
} from '../../core/remote-container'
import { uiError, uiInfo, header } from '../ui/theme'
import { getEngineIcon } from '../constants'
import {
  isFileBasedEngine,
  isRemoteContainer,
  type ContainerConfig,
} from '../../types'
import { getEngineMetadata } from '../helpers'

/**
 * 格式化日期显示
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleString()
}

/**
 * 获取容器的实际状态
 */
async function getActualStatus(
  config: ContainerConfig,
): Promise<'running' | 'stopped' | 'available' | 'missing' | 'linked'> {
  // 远程容器始终为 'linked'
  if (isRemoteContainer(config)) {
    return 'linked'
  }

  // 基于文件的引擎：检查文件是否存在而非运行状态
  if (isFileBasedEngine(config.engine)) {
    const fileExists = existsSync(config.database)
    return fileExists ? 'available' : 'missing'
  }

  const running = await processManager.isRunning(config.name, {
    engine: config.engine,
  })
  return running ? 'running' : 'stopped'
}

/**
 * 显示单个容器的详细信息
 */
async function displayContainerInfo(
  config: ContainerConfig,
  options: { json?: boolean },
): Promise<void> {
  const actualStatus = await getActualStatus(config)
  const engine = getEngine(config.engine)
  const isRemote = isRemoteContainer(config)
  const connectionString = isRemote
    ? (config.remote?.connectionString ?? '')
    : engine.getConnectionString(config)
  const dataDir = paths.getContainerDataPath(config.name, {
    engine: config.engine,
  })

  if (options.json) {
    const metadata = await getEngineMetadata(config.engine)
    console.log(
      JSON.stringify(
        {
          ...config,
          status: actualStatus,
          connectionString,
          dataDir,
          ...metadata,
        },
        null,
        2,
      ),
    )
    return
  }

  const icon = getEngineIcon(config.engine)
  const isFileBased = isFileBasedEngine(config.engine)

  // 根据容器类型显示状态
  let statusDisplay: string
  if (isRemote) {
    statusDisplay = isLayerbaseCloudRemote(config.remote)
      ? chalk.cyan('☁ 云端')
      : chalk.magenta('↔ 已链接')
  } else if (isFileBased) {
    statusDisplay =
      actualStatus === 'available'
        ? chalk.blue('🔵 可用')
        : chalk.gray('⚪ 缺失')
  } else {
    statusDisplay =
      actualStatus === 'running'
        ? chalk.green('● 运行中')
        : chalk.gray('○ 已停止')
  }

  console.log()
  console.log(header(`容器：${config.name}`))
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.white('引擎：'.padEnd(14)) +
      chalk.cyan(`${icon}${config.engine} ${config.version}`),
  )
  console.log(
    chalk.gray('  ') + chalk.white('状态：'.padEnd(14)) + statusDisplay,
  )

  if (isRemote) {
    // 远程容器信息
    console.log(
      chalk.gray('  ') +
        chalk.white('主机：'.padEnd(14)) +
        chalk.cyan(config.remote?.host ?? ''),
    )
    console.log(
      chalk.gray('  ') +
        chalk.white('端口：'.padEnd(14)) +
        chalk.green(String(config.port)),
    )
    console.log(
      chalk.gray('  ') +
        chalk.white('数据库：'.padEnd(14)) +
        chalk.yellow(config.database),
    )
    console.log(
      chalk.gray('  ') +
        chalk.white('来源：'.padEnd(14)) +
        (getRemoteOrigin(config.remote) === 'layerbase-cloud'
          ? chalk.cyan('Layerbase Cloud')
          : chalk.magenta('外部')),
    )
    if (config.remote?.provider) {
      console.log(
        chalk.gray('  ') +
          chalk.white('提供商：'.padEnd(14)) +
          chalk.magenta(config.remote.provider),
      )
    }
    console.log(
      chalk.gray('  ') +
        chalk.white('SSL：'.padEnd(14)) +
        (config.remote?.ssl ? chalk.green('是') : chalk.gray('否')),
    )
  } else if (isFileBased) {
    // 基于文件的引擎信息
    console.log(
      chalk.gray('  ') +
        chalk.white('文件：'.padEnd(14)) +
        chalk.green(config.database),
    )
  } else {
    // 基于服务器的引擎信息
    console.log(
      chalk.gray('  ') +
        chalk.white('端口：'.padEnd(14)) +
        chalk.green(String(config.port)),
    )
    console.log(
      chalk.gray('  ') +
        chalk.white('数据库：'.padEnd(14)) +
        chalk.yellow(config.database),
    )
  }

  console.log(
    chalk.gray('  ') +
      chalk.white('创建时间：'.padEnd(14)) +
      chalk.gray(formatDate(config.created)),
  )

  // 不显示基于文件或远程容器的数据目录
  if (!isFileBased && !isRemote) {
    console.log(
      chalk.gray('  ') +
        chalk.white('数据目录：'.padEnd(14)) +
        chalk.gray(dataDir),
    )
  }
  if (config.clonedFrom) {
    console.log(
      chalk.gray('  ') +
        chalk.white('克隆自：'.padEnd(14)) +
        chalk.gray(config.clonedFrom),
    )
  }
  console.log()
  console.log(chalk.gray('  ') + chalk.white('连接字符串：'))
  console.log(chalk.gray('  ') + chalk.cyan(connectionString))
  console.log()
}

/**
 * 显示所有容器的信息
 */
async function displayAllContainersInfo(
  containers: ContainerConfig[],
  options: { json?: boolean },
): Promise<void> {
  if (options.json) {
    const containersWithStatus = await Promise.all(
      containers.map(async (config) => {
        const actualStatus = await getActualStatus(config)
        const engine = getEngine(config.engine)
        const connectionString = isRemoteContainer(config)
          ? (config.remote?.connectionString ?? '')
          : engine.getConnectionString(config)
        const dataDir = paths.getContainerDataPath(config.name, {
          engine: config.engine,
        })
        const metadata = await getEngineMetadata(config.engine)
        return {
          ...config,
          status: actualStatus,
          connectionString,
          dataDir,
          ...metadata,
        }
      }),
    )
    console.log(JSON.stringify(containersWithStatus, null, 2))
    return
  }

  console.log()
  console.log(header('所有容器'))
  console.log()

  console.log(
    chalk.gray('  ') +
      chalk.bold.white('名称'.padEnd(18)) +
      chalk.bold.white('引擎'.padEnd(14)) +
      chalk.bold.white('版本'.padEnd(10)) +
      chalk.bold.white('端口'.padEnd(8)) +
      chalk.bold.white('数据库'.padEnd(16)) +
      chalk.bold.white('状态'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(78)))

  for (const container of containers) {
    const actualStatus = await getActualStatus(container)
    const isFileBased = isFileBasedEngine(container.engine)

    // 根据容器类型显示状态
    let statusDisplay: string
    if (actualStatus === 'linked') {
      statusDisplay = isLayerbaseCloudRemote(container.remote)
        ? chalk.cyan('☁ 云端')
        : chalk.magenta('↔ 已链接')
    } else if (isFileBased) {
      statusDisplay =
        actualStatus === 'available'
          ? chalk.blue('🔵 可用')
          : chalk.gray('⚪ 缺失')
    } else {
      statusDisplay =
        actualStatus === 'running'
          ? chalk.green('● 运行中')
          : chalk.gray('○ 已停止')
    }

    // getEngineIcon() 包含尾部空格以保持一致的对齐
    const engineDisplay = `${getEngineIcon(container.engine)}${container.engine}`

    // 对于基于文件的引擎显示截断的文件路径而非端口
    let portOrPath: string
    if (isFileBased) {
      const fileName = basename(container.database)
      // 如果超过 8 个字符则截断以适应 8 字符列
      portOrPath = fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
    } else {
      portOrPath = String(container.port)
    }

    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(18)) +
        chalk.white(engineDisplay.padEnd(13)) +
        chalk.yellow(container.version.padEnd(10)) +
        chalk.green(portOrPath.padEnd(8)) +
        chalk.gray(container.database.padEnd(16)) +
        statusDisplay,
    )
  }

  console.log()

  const statusChecks = await Promise.all(
    containers.map((c) => getActualStatus(c)),
  )
  const running = statusChecks.filter((s) => s === 'running').length
  const stopped = statusChecks.filter((s) => s === 'stopped').length
  const fileAvailable = statusChecks.filter((s) => s === 'available').length
  const fileMissing = statusChecks.filter((s) => s === 'missing').length
  const linked = statusChecks.filter((s) => s === 'linked').length

  const parts: string[] = []
  if (running + stopped > 0) {
    parts.push(`${running} 个运行中，${stopped} 个已停止`)
  }
  if (fileAvailable + fileMissing > 0) {
    parts.push(
      `${fileAvailable} 个基于文件的可用${fileMissing > 0 ? `，${fileMissing} 个缺失` : ''}`,
    )
  }
  if (linked > 0) {
    parts.push(`${linked} 个已链接`)
  }

  console.log(
    chalk.gray(`  ${containers.length} 个容器：${parts.join('；')}`),
  )
  console.log()

  console.log(chalk.bold.white('  连接字符串：'))
  console.log(chalk.gray('  ' + '─'.repeat(78)))
  for (const container of containers) {
    const engine = getEngine(container.engine)
    const connectionString = isRemoteContainer(container)
      ? (container.remote?.connectionString ?? '')
      : engine.getConnectionString(container)
    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(18)) +
        chalk.gray(connectionString),
    )
  }
  console.log()
}

export const infoCommand = new Command('info')
  .alias('status')
  .description('显示容器详细信息')
  .argument('[name]', '容器名称（省略则显示全部）')
  .option('--json', '以 JSON 格式输出')
  .action(async (name: string | undefined, options: { json?: boolean }) => {
    try {
      // 如果提供了特定的容器名称，先检查它
      if (name) {
        const config = await containerManager.getConfig(name)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `未找到容器 "${name}"` }),
            )
          } else {
            console.error(uiError(`未找到容器 "${name}"`))
          }
          process.exit(1)
        }
        await displayContainerInfo(config, options)
        return
      }

      // 未提供名称 - 列出所有容器
      const containers = await containerManager.list()

      if (containers.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2))
        } else {
          console.log(
            uiInfo('未找到容器。请使用以下命令创建：spindb create'),
          )
        }
        return
      }

      if (!options.json && process.stdout.isTTY && containers.length > 1) {
        const { choice } = await inquirer.prompt<{
          choice: string
        }>([
          {
            type: 'list',
            name: 'choice',
            message: '显示以下项的信息：',
            choices: [
              { name: '所有容器', value: 'all' },
              ...containers.map((c) => ({
                name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)}${c.engine})`)}`,
                value: c.name,
              })),
            ],
          },
        ])

        if (choice === 'all') {
          await displayAllContainersInfo(containers, options)
        } else {
          const config = await containerManager.getConfig(choice)
          if (config) {
            await displayContainerInfo(config, options)
          }
        }
        return
      }

      await displayAllContainersInfo(containers, options)
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.error(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })
