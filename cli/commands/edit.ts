import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  existsSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from 'fs'
import { dirname, resolve, basename, join } from 'path'
import { homedir } from 'os'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, uiSuccess, uiInfo } from '../ui/theme'
import { Engine, isFileBasedEngine } from '../../types'
import {
  FILE_BASED_EXTENSION_REGEX,
  isValidExtensionForEngine,
  formatExtensionsForEngine,
  getRegistryForEngine,
} from '../../engines/file-based-utils'

function isValidName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

// 未提供选项时提示选择要编辑的内容
async function promptEditAction(
  engine: string,
): Promise<'name' | 'port' | 'config' | 'relocate' | null> {
  const choices = [{ name: '重命名容器', value: 'name' }]

  // 基于文件的引擎：显示重定位而非端口
  if (isFileBasedEngine(engine as Engine)) {
    choices.push({ name: '重定位数据库文件', value: 'relocate' })
  } else {
    choices.push({ name: '更改端口', value: 'port' })
  }

  // 仅对支持的引擎显示配置选项
  if (engine === Engine.PostgreSQL) {
    choices.push({
      name: '编辑数据库配置 (postgresql.conf)',
      value: 'config',
    })
  }

  choices.push({ name: chalk.gray('取消'), value: 'cancel' })

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '您想要编辑什么？',
      choices,
    },
  ])

  if (action === 'cancel') return null
  return action as 'name' | 'port' | 'config' | 'relocate'
}

async function promptNewName(currentName: string): Promise<string | null> {
  const { newName } = await inquirer.prompt<{ newName: string }>([
    {
      type: 'input',
      name: 'newName',
      message: '新容器名称：',
      default: currentName,
      validate: (input: string) => {
        if (!input) return '名称是必需的'
        if (!isValidName(input)) {
          return '名称必须以字母开头，仅包含字母、数字、连字符和下划线'
        }
        return true
      },
    },
  ])

  if (newName === currentName) {
    console.log(uiWarning('名称未更改'))
    return null
  }

  return newName
}

// 用户可能想要编辑的常见 PostgreSQL 配置设置
const COMMON_PG_SETTINGS = [
  {
    name: 'max_connections',
    description: '最大并发连接数',
    default: '200',
  },
  {
    name: 'shared_buffers',
    description: '共享缓冲区内存',
    default: '128MB',
  },
  { name: 'work_mem', description: '每个操作的内存', default: '4MB' },
  {
    name: 'maintenance_work_mem',
    description: '维护操作的内存',
    default: '64MB',
  },
  {
    name: 'effective_cache_size',
    description: '规划器缓存大小估计',
    default: '4GB',
  },
]

// 提示选择要编辑的 PostgreSQL 配置设置
async function promptConfigSetting(): Promise<{
  key: string
  value: string
} | null> {
  const choices = COMMON_PG_SETTINGS.map((s) => ({
    name: `${s.name.padEnd(25)} ${chalk.gray(s.description)}`,
    value: s.name,
  }))
  choices.push({ name: chalk.cyan('自定义设置...'), value: '__custom__' })
  choices.push({ name: chalk.gray('取消'), value: '__cancel__' })

  const { setting } = await inquirer.prompt<{ setting: string }>([
    {
      type: 'list',
      name: 'setting',
      message: '选择要编辑的设置：',
      choices,
    },
  ])

  if (setting === '__cancel__') return null

  let key = setting
  if (setting === '__custom__') {
    const { customKey } = await inquirer.prompt<{ customKey: string }>([
      {
        type: 'input',
        name: 'customKey',
        message: '设置名称：',
        validate: (input: string) => {
          if (!input.trim()) return '设置名称是必需的'
          if (!/^[a-z_]+$/.test(input))
            return '设置名称使用小写字母和下划线'
          return true
        },
      },
    ])
    key = customKey
  }

  const defaultValue =
    COMMON_PG_SETTINGS.find((s) => s.name === key)?.default || ''
  const { value } = await inquirer.prompt<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message: `${key} 的值：`,
      default: defaultValue,
      validate: (input: string) => {
        if (!input.trim()) return '值是必需的'
        return true
      },
    },
  ])

  return { key, value }
}

// 提示输入新端口
async function promptNewPort(currentPort: number): Promise<number | null> {
  const { newPort } = await inquirer.prompt<{ newPort: number }>([
    {
      type: 'input',
      name: 'newPort',
      message: '新端口：',
      default: String(currentPort),
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

  if (newPort === currentPort) {
    console.log(uiWarning('端口未更改'))
    return null
  }

  const portAvailable = await portManager.isPortAvailable(newPort)
  if (!portAvailable) {
    console.log(
      uiWarning(
        `注意：端口 ${newPort} 当前已被占用。容器启动时将使用此端口。`,
      ),
    )
  }

  return newPort
}

// 提示输入新文件位置（基于文件的引擎重定位）
async function promptNewLocation(
  currentPath: string,
  engine: Engine.SQLite | Engine.DuckDB,
): Promise<string | null> {
  console.log()
  console.log(chalk.gray(`  当前位置：${currentPath}`))
  console.log(
    chalk.gray('  输入绝对路径或相对于当前目录的路径。'),
  )
  console.log()

  const { newPath } = await inquirer.prompt<{ newPath: string }>([
    {
      type: 'input',
      name: 'newPath',
      message: '新文件位置：',
      default: currentPath,
      validate: (input: string) => {
        if (!input.trim()) return '路径是必需的'
        if (!isValidExtensionForEngine(resolve(input), engine)) {
          return `路径应以 ${formatExtensionsForEngine(engine)} 结尾`
        }
        return true
      },
    },
  ])

  const resolvedPath = resolve(newPath)

  if (resolvedPath === currentPath) {
    console.log(uiWarning('位置未更改'))
    return null
  }

  // 检查目标是否已存在
  if (existsSync(resolvedPath)) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `文件已存在于 ${resolvedPath}。是否覆盖？`,
        default: false,
      },
    ])
    if (!overwrite) {
      console.log(uiWarning('重定位已取消'))
      return null
    }
  }

  return resolvedPath
}

export const editCommand = new Command('edit')
  .description(
    '编辑容器属性（重命名、端口、重定位或数据库配置）',
  )
  .argument('[name]', '容器名称')
  .option('-n, --name <newName>', '新容器名称')
  .option('-p, --port <port>', '新端口号', parseInt)
  .option(
    '--relocate <path>',
    '基于文件的数据库的新文件位置（移动文件）',
  )
  .option(
    '--overwrite',
    '如果目标文件存在则覆盖（用于 --relocate）',
  )
  .option(
    '--set-config <setting>',
    '设置数据库配置值（例如：max_connections=200）',
  )
  .option('-j, --json', '以 JSON 格式输出结果')
  .action(
    async (
      name: string | undefined,
      options: {
        name?: string
        port?: number
        relocate?: string
        overwrite?: boolean
        setConfig?: string
        json?: boolean
      },
    ) => {
      try {
        let containerName = name
        const changes: Record<string, unknown> = {}

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('未找到容器'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            '选择要编辑的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`未找到容器 "${containerName}"`))
          process.exit(1)
        }

        // 如果未提供选项，提示选择要编辑的内容
        if (
          options.name === undefined &&
          options.port === undefined &&
          options.relocate === undefined &&
          options.setConfig === undefined
        ) {
          const action = await promptEditAction(config.engine)
          if (!action) return

          if (action === 'name') {
            const newName = await promptNewName(containerName)
            if (newName) {
              options.name = newName
            } else {
              return
            }
          } else if (action === 'port') {
            const newPort = await promptNewPort(config.port)
            if (newPort) {
              options.port = newPort
            } else {
              return
            }
          } else if (action === 'relocate') {
            const newLocation = await promptNewLocation(
              config.database,
              config.engine as Engine.SQLite | Engine.DuckDB,
            )
            if (newLocation) {
              options.relocate = newLocation
            } else {
              return
            }
          } else if (action === 'config') {
            const configSetting = await promptConfigSetting()
            if (configSetting) {
              options.setConfig = `${configSetting.key}=${configSetting.value}`
            } else {
              return
            }
          }
        }

        if (options.name) {
          if (!isValidName(options.name)) {
            console.error(
              uiError(
                '名称必须以字母开头，仅包含字母、数字、连字符和下划线',
              ),
            )
            process.exit(1)
          }

          const exists = await containerManager.exists(options.name, {
            engine: config.engine,
          })
          if (exists) {
            console.error(uiError(`容器 "${options.name}" 已存在`))
            process.exit(1)
          }

          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (running) {
            console.error(
              uiError(
                `容器 "${containerName}" 正在运行。请先停止后再重命名。`,
              ),
            )
            process.exit(1)
          }

          const spinner = createSpinner(
            `正在将 "${containerName}" 重命名为 "${options.name}"...`,
          )
          spinner.start()

          await containerManager.rename(containerName, options.name)

          spinner.succeed(`已将 "${containerName}" 重命名为 "${options.name}"`)

          changes.renamed = { from: containerName, to: options.name }
          containerName = options.name
        }

        if (options.port !== undefined) {
          if (options.port < 1 || options.port > 65535) {
            console.error(uiError('端口必须在 1 到 65535 之间'))
            process.exit(1)
          }

          const portAvailable = await portManager.isPortAvailable(options.port)
          if (!portAvailable) {
            console.log(
              uiWarning(
                `端口 ${options.port} 当前已被占用。容器下次启动时将使用此端口。`,
              ),
            )
          }

          const spinner = createSpinner(`正在更改端口为 ${options.port}...`)
          spinner.start()

          await containerManager.updateConfig(containerName, {
            port: options.port,
          })

          spinner.succeed(`端口已更改为 ${options.port}`)
          changes.port = { from: config.port, to: options.port }
          if (!options.json) {
            console.log(
              chalk.gray(
                '  注意：端口更改将在下次容器启动时生效。',
              ),
            )
          }
        }

        // 处理基于文件的引擎重定位
        if (options.relocate) {
          if (!isFileBasedEngine(config.engine)) {
            console.error(
              uiError(
                '重定位仅适用于基于文件的容器（SQLite, DuckDB）',
              ),
            )
            process.exit(1)
          }

          // 将 ~ 展开为主目录
          let expandedPath = options.relocate
          if (options.relocate === '~') {
            expandedPath = homedir()
          } else if (options.relocate.startsWith('~/')) {
            expandedPath = join(homedir(), options.relocate.slice(2))
          }

          // 将相对路径转换为绝对路径
          if (!expandedPath.startsWith('/')) {
            expandedPath = resolve(process.cwd(), expandedPath)
          }

          // 检查路径是否看起来像文件（有 db 扩展名）或目录
          const hasDbExtension = FILE_BASED_EXTENSION_REGEX.test(expandedPath)

          // 如果满足以下条件则视为目录：
          // - 以 / 结尾
          // - 存在且是目录
          // - 没有数据库文件扩展名
          const isDirectory =
            expandedPath.endsWith('/') ||
            (existsSync(expandedPath) &&
              statSync(expandedPath).isDirectory()) ||
            !hasDbExtension

          let newPath: string
          if (isDirectory) {
            const dirPath = expandedPath.endsWith('/')
              ? expandedPath.slice(0, -1)
              : expandedPath
            const currentFileName = basename(config.database)
            newPath = join(dirPath, currentFileName)
          } else {
            newPath = expandedPath
          }

          // 检查源文件是否存在
          if (!existsSync(config.database)) {
            console.error(
              uiError(`源数据库文件未找到：${config.database}`),
            )
            process.exit(1)
          }

          // 检查目标是否已存在
          if (existsSync(newPath)) {
            if (options.overwrite) {
              // 移动前删除现有文件
              unlinkSync(newPath)
              console.log(uiWarning(`正在覆盖现有文件：${newPath}`))
            } else {
              console.error(
                uiError(`目标文件已存在：${newPath}`),
              )
              console.log(
                uiInfo('使用 --overwrite 替换现有文件'),
              )
              process.exit(1)
            }
          }

          // 确保目标目录存在
          const targetDir = dirname(newPath)
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true })
            console.log(uiInfo(`已创建目录：${targetDir}`))
          }

          const spinner = createSpinner(`正在将数据库移动到 ${newPath}...`)
          spinner.start()

          try {
            // 跟踪注册表更新后是否需要删除源文件
            // （用于跨设备移动，重命名无法工作的情况）
            let needsSourceCleanup = false
            const originalPath = config.database

            // 首先尝试重命名（快速，同一文件系统）
            try {
              renameSync(config.database, newPath)
            } catch (renameErr) {
              const e = renameErr as NodeJS.ErrnoException
              // EXDEV = 跨设备链接，需要复制+删除
              if (e.code === 'EXDEV') {
                try {
                  // 复制文件，保留模式/权限
                  copyFileSync(config.database, newPath)
                  // 暂不删除源文件 - 等待注册表更新成功
                  needsSourceCleanup = true
                } catch (copyErr) {
                  // 失败时清理部分目标文件
                  if (existsSync(newPath)) {
                    try {
                      unlinkSync(newPath)
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

            // 更新容器配置和基于文件的注册表
            await containerManager.updateConfig(containerName, {
              database: newPath,
            })
            await getRegistryForEngine(config.engine).update(containerName, {
              filePath: newPath,
            })

            // 现在可以安全地删除跨设备移动的源文件
            if (needsSourceCleanup && existsSync(originalPath)) {
              unlinkSync(originalPath)
            }

            spinner.succeed(`数据库已重定位到 ${newPath}`)
            changes.relocated = { from: originalPath, to: newPath }
          } catch (error) {
            spinner.fail('重定位数据库失败')
            throw error
          }
        }

        // 处理配置更改
        if (options.setConfig) {
          // 目前仅 PostgreSQL 支持配置编辑
          if (config.engine !== Engine.PostgreSQL) {
            console.error(
              uiError(
                `配置编辑仅支持 PostgreSQL 容器`,
              ),
            )
            process.exit(1)
          }

          // 解析设置（key=value 格式）
          const match = options.setConfig.match(/^([a-z_]+)=(.+)$/)
          if (!match) {
            console.error(
              uiError(
                '无效的配置格式。使用：--set-config key=value（例如：max_connections=200）',
              ),
            )
            process.exit(1)
          }

          const [, configKey, configValue] = match

          // 获取 PostgreSQL 引擎以更新配置
          const engine = getEngine(config.engine)
          const dataDir = paths.getContainerDataPath(containerName, {
            engine: config.engine,
          })

          const spinner = createSpinner(
            `正在设置 ${configKey} = ${configValue}...`,
          )
          spinner.start()

          // 使用 PostgreSQL 引擎的 setConfigValue 方法
          if ('setConfigValue' in engine) {
            await (
              engine as {
                setConfigValue: (
                  dataDir: string,
                  key: string,
                  value: string,
                ) => Promise<void>
              }
            ).setConfigValue(dataDir, configKey, configValue)
            spinner.succeed(`已设置 ${configKey} = ${configValue}`)
            changes.config = { key: configKey, value: configValue }
          } else {
            spinner.fail('此引擎不支持配置编辑')
            process.exit(1)
          }

          // 检查容器是否正在运行并警告需要重启
          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (!options.json) {
            if (running) {
              console.log(
                uiInfo(
                  '  注意：重启容器以使更改生效。',
                ),
              )
              console.log(
                chalk.gray(
                  `    spindb stop ${containerName} && spindb start ${containerName}`,
                ),
              )
            } else {
              console.log(
                chalk.gray(
                  '  配置更改将在下次容器启动时生效。',
                ),
              )
            }
          }
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              container: containerName,
              changes,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess('容器更新成功'))
        }
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
