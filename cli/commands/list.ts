import { Command } from 'commander'
import chalk from 'chalk'
import { dirname, basename } from 'path'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { uiInfo, uiError, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { isLayerbaseCloudRemote } from '../../core/remote-container'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'
import type { ContainerConfig } from '../../types'
import {
  scanForUnregisteredFiles,
  deriveContainerName,
  getRegistryForEngine,
  type UnregisteredFile,
} from '../../engines/file-based-utils'
import { getEngineMetadata } from '../helpers'
import inquirer from 'inquirer'

type UnregisteredFileWithEngine = UnregisteredFile & { engine: Engine }

/**
 * 提示用户关于当前工作目录中未注册的基于文件的数据库文件
 * 如果用户注册了任何文件则返回 true（需要刷新）
 */
async function promptUnregisteredFiles(): Promise<boolean> {
  const [sqliteFiles, duckdbFiles] = await Promise.all([
    scanForUnregisteredFiles(Engine.SQLite),
    scanForUnregisteredFiles(Engine.DuckDB),
  ])

  const unregistered: UnregisteredFileWithEngine[] = [
    ...sqliteFiles.map((f) => ({ ...f, engine: Engine.SQLite as Engine })),
    ...duckdbFiles.map((f) => ({ ...f, engine: Engine.DuckDB as Engine })),
  ]

  if (unregistered.length === 0) {
    return false
  }

  let anyRegistered = false

  for (let i = 0; i < unregistered.length; i++) {
    const file = unregistered[i]
    const engineLabel = file.engine === Engine.SQLite ? 'SQLite' : 'DuckDB'
    const prompt =
      unregistered.length > 1 ? `[${i + 1}/${unregistered.length}] ` : ''

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: `${prompt}在当前目录发现未注册的 ${engineLabel} 数据库 "${file.fileName}"。是否注册到 SpinDB？`,
        choices: [
          { name: '是', value: 'yes' },
          { name: '否', value: 'no' },
          { name: '否 - 以后不再询问此文件夹', value: 'ignore' },
        ],
      },
    ])

    if (action === 'yes') {
      const registry = getRegistryForEngine(file.engine)
      const suggestedName = deriveContainerName(
        file.fileName,
        file.engine as Engine.SQLite | Engine.DuckDB,
      )
      const { containerName } = await inquirer.prompt<{
        containerName: string
      }>([
        {
          type: 'input',
          name: 'containerName',
          message: '容器名称：',
          default: suggestedName,
          validate: (input: string) => {
            if (!input) return '名称是必需的'
            if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
              return '名称必须以字母开头，仅包含字母、数字、连字符和下划线'
            }
            return true
          },
        },
      ])

      // 检查名称是否已存在
      if (await registry.exists(containerName)) {
        console.log(
          chalk.yellow(
            `  容器 "${containerName}" 已存在。跳过。`,
          ),
        )
        continue
      }

      await registry.add({
        name: containerName,
        filePath: file.absolutePath,
        created: new Date().toISOString(),
      })
      console.log(
        chalk.green(`  已将 "${file.fileName}" 注册为 "${containerName}"`),
      )
      anyRegistered = true
    } else if (action === 'ignore') {
      await getRegistryForEngine(file.engine).addIgnoreFolder(
        dirname(file.absolutePath),
      )
      console.log(chalk.gray('  此文件夹将在以后的扫描中被忽略。'))
      break // 提前退出
    }
  }

  if (anyRegistered) {
    console.log() // 在列表前添加间距
  }

  return anyRegistered
}

async function getContainerSize(
  container: ContainerConfig,
): Promise<number | null> {
  // 基于文件的引擎始终可以获取大小（仅文件大小）
  if (isFileBasedEngine(container.engine)) {
    try {
      const engine = getEngine(container.engine)
      return await engine.getDatabaseSize(container)
    } catch {
      return null
    }
  }

  // 服务器数据库需要处于运行状态
  if (container.status !== 'running') {
    return null
  }
  try {
    const engine = getEngine(container.engine)
    return await engine.getDatabaseSize(container)
  } catch {
    return null
  }
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('列出所有容器')
  .option('--json', '以 JSON 格式输出')
  .option('--no-scan', '跳过扫描当前工作目录中未注册的数据库文件')
  .action(async (options: { json?: boolean; scan?: boolean }) => {
    try {
      // 扫描当前工作目录中未注册的基于文件的数据库文件（除非 JSON 模式或 --no-scan）
      if (!options.json && options.scan !== false) {
        await promptUnregisteredFiles()
      }

      const containers = await containerManager.list()

      if (options.json) {
        const containersWithSize = await Promise.all(
          containers.map(async (container) => ({
            ...container,
            ...(await getEngineMetadata(container.engine)),
            sizeBytes: await getContainerSize(container),
            ...(container.remote ? { remote: container.remote } : {}),
          })),
        )
        console.log(JSON.stringify(containersWithSize, null, 2))
        return
      }

      if (containers.length === 0) {
        console.log(
          uiInfo('未找到容器。请使用以下命令创建：spindb create'),
        )
        return
      }

      const sizes = await Promise.all(containers.map(getContainerSize))

      console.log()
      console.log(
        chalk.gray('  ') +
          chalk.bold.white('名称'.padEnd(20)) +
          chalk.bold.white('引擎'.padEnd(18)) +
          chalk.bold.white('版本'.padEnd(10)) +
          chalk.bold.white('端口'.padEnd(8)) +
          chalk.bold.white('大小'.padEnd(10)) +
          chalk.bold.white('状态'),
      )
      console.log(chalk.gray('  ' + '─'.repeat(76)))

      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const size = sizes[i]

        // 根据容器类型显示状态标签
        let statusDisplay: string
        if (isRemoteContainer(container)) {
          statusDisplay = isLayerbaseCloudRemote(container.remote)
            ? chalk.cyan('☁ 云端')
            : chalk.magenta('↔ 已链接')
        } else if (isFileBasedEngine(container.engine)) {
          statusDisplay =
            container.status === 'running'
              ? chalk.blue('🔵 可用')
              : chalk.gray('⚪ 缺失')
        } else {
          statusDisplay =
            container.status === 'running'
              ? chalk.green('● 运行中')
              : chalk.gray('○ 已停止')
        }

        // getEngineIcon() 包含尾部空格 - 单独填充引擎名称以避免 ANSI 代码长度问题
        const engineIcon = getEngineIcon(container.engine)
        const engineName = container.engine.padEnd(13)

        const sizeDisplay = size !== null ? formatBytes(size) : '—'

        // 基于文件的引擎显示截断的文件名，远程显示主机，其他显示端口
        let portOrPath: string
        if (isRemoteContainer(container)) {
          // 优先显示提供商名称（更具信息性），回退到截断的主机名
          const provider = container.remote?.provider
          const host = container.remote?.host ?? ''
          portOrPath = provider
            ? provider.length > 8
              ? provider.slice(0, 7) + '…'
              : provider
            : host.length > 8
              ? host.slice(0, 7) + '…'
              : host
        } else if (isFileBasedEngine(container.engine)) {
          const fileName = basename(container.database)
          // 如果超过 8 个字符则截断以适应 8 字符列
          portOrPath =
            fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
        } else {
          portOrPath = String(container.port)
        }

        console.log(
          chalk.gray('  ') +
            chalk.cyan(container.name.padEnd(20)) +
            engineIcon +
            chalk.white(engineName) +
            chalk.yellow(container.version.padEnd(10)) +
            chalk.green(portOrPath.padEnd(8)) +
            chalk.magenta(sizeDisplay.padEnd(10)) +
            statusDisplay,
        )
      }

      console.log()

      const remoteContainers = containers.filter((c) => isRemoteContainer(c))
      const localContainers = containers.filter((c) => !isRemoteContainer(c))
      const serverContainers = localContainers.filter(
        (c) => !isFileBasedEngine(c.engine),
      )
      const fileBasedContainers = localContainers.filter((c) =>
        isFileBasedEngine(c.engine),
      )

      const running = serverContainers.filter(
        (c) => c.status === 'running',
      ).length
      const stopped = serverContainers.filter(
        (c) => c.status !== 'running',
      ).length
      const available = fileBasedContainers.filter(
        (c) => c.status === 'running',
      ).length
      const missing = fileBasedContainers.filter(
        (c) => c.status !== 'running',
      ).length

      const parts: string[] = []
      if (serverContainers.length > 0) {
        parts.push(`${running} 个运行中，${stopped} 个已停止`)
      }
      if (fileBasedContainers.length > 0) {
        parts.push(
          `${available} 个基于文件的可用${missing > 0 ? `，${missing} 个缺失` : ''}`,
        )
      }
      if (remoteContainers.length > 0) {
        parts.push(`${remoteContainers.length} 个已链接`)
      }

      console.log(
        chalk.gray(`  ${containers.length} 个容器：${parts.join('；')}`),
      )
      console.log()
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })
