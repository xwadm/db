import { Command } from 'commander'
import { join, resolve } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { platformService } from '../../core/platform-service'
import {
  exportToDocker,
  getExportBackupPath,
  dockerExportExists,
  getDockerConnectionString,
  getDockerCredentials,
  getDefaultDockerExportPath,
} from '../../core/docker-exporter'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning, box, formatBytes } from '../ui/theme'
import { isFileBasedEngine, isRemoteContainer } from '../../types'
import { getDefaultFormat } from '../../config/backup-formats'
import { getEngineDefaults } from '../../config/engine-defaults'
import { paths } from '../../config/paths'
import { stat, rm, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import inquirer from 'inquirer'

export const exportCommand = new Command('export')
  .description('将容器导出为各种格式')
  .addCommand(
    new Command('docker')
      .description('将容器导出为 Docker 就绪包')
      .argument('[container]', '容器名称')
      .option(
        '-o, --output <dir>',
        '输出目录（默认：~/.spindb/containers/{engine}/{name}/docker）',
      )
      .option('-p, --port <number>', '覆盖外部端口', parseInt)
      .option('--no-data', '跳过数据库备份')
      .option('--no-tls', '跳过 TLS 证书生成')
      .option('-f, --force', '覆盖现有输出目录')
      .option('-c, --copy', '将密码复制到剪贴板')
      .option('-j, --json', '以 JSON 格式输出结果')
      .action(
        async (
          containerArg: string | undefined,
          options: {
            output?: string
            port?: number
            data?: boolean
            tls?: boolean
            force?: boolean
            copy?: boolean
            json?: boolean
          },
        ) => {
          try {
            let containerName = containerArg
            // 跟踪是否处于交互模式（无容器参数 = 用户将选择）
            const isInteractive = !containerArg && !options.json

            // 如果未提供，选择容器
            if (!containerName) {
              if (options.json) {
                console.log(
                  JSON.stringify({ error: '容器名称是必需的' }),
                )
                process.exit(1)
              }

              const containers = await containerManager.list()

              if (containers.length === 0) {
                console.log(
                  uiWarning(
                    '未找到容器。请使用以下命令创建：spindb create',
                  ),
                )
                return
              }

              const selected = await promptContainerSelect(
                containers,
                '选择要导出的容器：',
              )
              if (!selected) return
              containerName = selected
            }

            // 获取容器配置
            const config = await containerManager.getConfig(containerName)
            if (!config) {
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: `未找到容器 "${containerName}"`,
                  }),
                )
              } else {
                console.error(uiError(`未找到容器 "${containerName}"`))
              }
              process.exit(1)
            }

            // 阻止远程容器的导出
            if (isRemoteContainer(config)) {
              const errorMsg = `导出功能不适用于链接的远程容器。`
              if (options.json) {
                console.log(JSON.stringify({ error: errorMsg }))
              } else {
                console.error(uiError(errorMsg))
              }
              process.exit(1)
            }

            const { engine: engineName, version, database, port } = config
            const engine = getEngine(engineName)
            const engineDefaultPort = getEngineDefaults(engineName).defaultPort

            // 默认输出目录：~/.spindb/containers/{engine}/{name}/docker
            const defaultOutputDir = join(
              paths.getContainerPath(containerName, { engine: engineName }),
              'docker',
            )
            const outputDir = options.output
              ? resolve(options.output)
              : defaultOutputDir
            const includeData = options.data !== false
            const skipTLS = options.tls === false

            // 确定目标端口：
            // 1. 如果用户明确传递了 -p，使用该端口
            // 2. 如果本地端口与引擎默认端口匹配，使用它
            // 3. 如果交互模式（无容器参数）且端口不同，提示用户
            // 4. CLI 模式或 JSON 模式：默认为引擎的标准端口
            let targetPort: number
            if (options.port !== undefined) {
              // 用户明确指定了端口
              targetPort = options.port
            } else if (port === engineDefaultPort) {
              // 本地端口与引擎默认端口匹配，无需决策
              targetPort = engineDefaultPort
            } else if (isInteractive) {
              // 仅交互模式：提示用户在本地端口和默认端口之间选择
              console.log()
              console.log(
                chalk.yellow(
                  `本地容器使用端口 ${chalk.cyan(String(port))}，但 ${engine.displayName} 的标准端口是 ${chalk.cyan(String(engineDefaultPort))}。`,
                ),
              )
              const { selectedPort } = await inquirer.prompt<{
                selectedPort: number
              }>([
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
                      name: `${port} ${chalk.gray('（与本地容器相同）')}`,
                      value: port,
                    },
                  ],
                  default: engineDefaultPort,
                },
              ])
              targetPort = selectedPort
            } else {
              // CLI 模式或 JSON 模式：默认为标准端口
              targetPort = engineDefaultPort
            }

            // 检查输出目录是否已存在
            if (existsSync(outputDir)) {
              let shouldOverwrite = options.force

              if (!shouldOverwrite && !options.json) {
                // 交互式提示确认覆盖
                console.log()
                console.log(
                  uiWarning(`输出目录已存在：${outputDir}`),
                )
                shouldOverwrite = await promptConfirm(
                  '您要覆盖它吗？',
                  false, // 默认为否以确保安全
                )
              }

              if (shouldOverwrite) {
                // 删除现有目录
                await rm(outputDir, { recursive: true, force: true })
              } else {
                if (options.json) {
                  console.log(
                    JSON.stringify({
                      error: `输出目录已存在：${outputDir}`,
                    }),
                  )
                } else {
                  console.log(
                    uiError(
                      '导出已取消。使用 --force 覆盖或 --output 指定不同的路径。',
                    ),
                  )
                }
                process.exit(1)
              }
            }

            // 对于带数据的服务器引擎，检查容器是否正在运行
            let backupPath: string | undefined
            if (includeData && !isFileBasedEngine(engineName)) {
              const running = await processManager.isRunning(containerName, {
                engine: engineName,
              })

              if (!running) {
                if (options.json) {
                  console.log(
                    JSON.stringify({
                      error: `容器 "${containerName}" 未运行。请先启动以导出数据。`,
                    }),
                  )
                } else {
                  console.error(
                    uiError(
                      `容器 "${containerName}" 未运行。\n请先使用以下命令启动：spindb start ${containerName}`,
                    ),
                  )
                }
                process.exit(1)
              }
            }

            if (!options.json) {
              console.log()
              console.log(
                chalk.bold(
                  `正在将 ${chalk.cyan(containerName)} 导出到 Docker...`,
                ),
              )
              console.log()
            }

            // 步骤 1：如果包含数据，创建备份
            if (includeData) {
              const backupSpinner = options.json
                ? null
                : createSpinner('正在创建数据库备份...')
              backupSpinner?.start()

              try {
                // 创建临时备份
                const tempBackupPath = getExportBackupPath(
                  outputDir,
                  containerName,
                  database,
                  engineName,
                )

                // 为备份创建父目录
                await mkdir(join(outputDir, 'data'), { recursive: true })

                // 使用引擎的备份方法创建备份
                const format = getDefaultFormat(engineName)
                const result = await engine.backup(config, tempBackupPath, {
                  database,
                  format,
                })

                backupPath = result.path

                const backupStat = await stat(result.path)
                backupSpinner?.succeed(
                  `备份已创建（${formatBytes(backupStat.size)}）`,
                )
              } catch (error) {
                const e = error as Error
                backupSpinner?.fail('备份失败')

                if (options.json) {
                  console.log(JSON.stringify({ error: e.message }))
                } else {
                  console.error(uiError(e.message))
                }
                process.exit(1)
              }
            }

            // 步骤 2：生成 Docker 构件
            const exportSpinner = options.json
              ? null
              : createSpinner('正在生成 Docker 构件...')
            exportSpinner?.start()

            const result = await exportToDocker(config, {
              outputDir,
              port: targetPort,
              includeData,
              backupPath,
              skipTLS,
            })

            exportSpinner?.succeed('Docker 构件已生成')

            // 如果请求，将密码复制到剪贴板
            if (options.copy) {
              const copied = await platformService.copyToClipboard(
                result.credentials.password,
              )
              if (copied && !options.json) {
                console.log(uiSuccess('密码已复制到剪贴板'))
              }
            }

            // 输出结果
            if (options.json) {
              console.log(
                JSON.stringify({
                  success: true,
                  outputDir: result.outputDir,
                  engine: result.engine,
                  version: result.version,
                  port: result.port,
                  database: result.database,
                  username: result.credentials.username,
                  password: result.credentials.password,
                  files: result.files,
                }),
              )
            } else {
              console.log()
              console.log(
                uiSuccess(`已将 ${chalk.cyan(containerName)} 导出到 Docker`),
              )
              console.log()

              // 显示摘要框
              const lines = [
                `${chalk.bold(engine.displayName)} ${version}`,
                `端口：${chalk.green(String(targetPort))}`,
                `数据库：${chalk.cyan(database)}`,
                '',
                chalk.bold('生成的凭据'),
                chalk.gray('────────────────────────'),
                `用户名：${chalk.white(result.credentials.username)}`,
                `密码：${chalk.white(result.credentials.password)}`,
                chalk.gray('────────────────────────'),
                '',
                chalk.yellow('立即保存这些凭据 - 存储在 .env 中'),
              ]

              console.log(box(lines))
              console.log()
              console.log(chalk.gray('  输出：'), chalk.cyan(result.outputDir))
              console.log()
              console.log(chalk.bold('  运行方式：'))
              console.log(
                chalk.cyan(
                  `    cd "${result.outputDir}" && docker compose up -d`,
                ),
              )
              console.log()
            }
          } catch (error) {
            const e = error as Error

            if (options.json) {
              console.log(JSON.stringify({ error: e.message }))
            } else {
              console.error(uiError(e.message))
            }
            process.exit(1)
          }
        },
      ),
  )
  .addCommand(
    new Command('docker-url')
      .description('获取现有 Docker 导出的连接字符串')
      .argument('[container]', '容器名称')
      .option('-c, --copy', '将连接字符串复制到剪贴板')
      .option('-j, --json', '以 JSON 格式输出结果')
      .option(
        '--host <hostname>',
        '覆盖连接字符串中的主机名',
        'localhost',
      )
      .action(
        async (
          containerArg: string | undefined,
          options: {
            copy?: boolean
            json?: boolean
            host?: string
          },
        ) => {
          try {
            let containerName = containerArg

            // 如果未提供，选择容器
            if (!containerName) {
              if (options.json) {
                console.log(
                  JSON.stringify({ error: '容器名称是必需的' }),
                )
                process.exit(1)
              }

              const containers = await containerManager.list()

              if (containers.length === 0) {
                console.log(
                  uiWarning(
                    '未找到容器。请使用以下命令创建：spindb create',
                  ),
                )
                return
              }

              // 筛选有 Docker 导出的容器
              const containersWithExports = containers.filter((c) =>
                dockerExportExists(c.name, c.engine),
              )

              if (containersWithExports.length === 0) {
                console.log(
                  uiWarning(
                    '未找到 Docker 导出。请先使用以下命令导出容器：spindb export docker <container>',
                  ),
                )
                return
              }

              const selected = await promptContainerSelect(
                containersWithExports,
                '选择容器：',
              )
              if (!selected) return
              containerName = selected
            }

            // 获取容器配置
            const config = await containerManager.getConfig(containerName)
            if (!config) {
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: `未找到容器 "${containerName}"`,
                  }),
                )
              } else {
                console.error(uiError(`未找到容器 "${containerName}"`))
              }
              process.exit(1)
            }

            // 检查 Docker 导出是否存在
            if (!dockerExportExists(containerName, config.engine)) {
              const exportPath = getDefaultDockerExportPath(
                containerName,
                config.engine,
              )
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: `未找到 "${containerName}" 的 Docker 导出。请先使用以下命令导出：spindb export docker ${containerName}`,
                    exportPath,
                  }),
                )
              } else {
                console.error(
                  uiError(
                    `未找到 "${containerName}" 的 Docker 导出。\n请先使用以下命令导出：spindb export docker ${containerName}`,
                  ),
                )
              }
              process.exit(1)
            }

            // 获取凭据和连接字符串
            const credentials = await getDockerCredentials(
              containerName,
              config.engine,
            )
            const connectionString = await getDockerConnectionString(
              containerName,
              config.engine,
              { host: options.host },
            )

            if (!connectionString || !credentials) {
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: '无法读取 Docker 导出凭据',
                  }),
                )
              } else {
                console.error(
                  uiError('无法读取 Docker 导出凭据'),
                )
              }
              process.exit(1)
            }

            // 如果请求，复制到剪贴板
            if (options.copy) {
              const copied =
                await platformService.copyToClipboard(connectionString)
              if (!options.json) {
                if (copied) {
                  console.log(
                    uiSuccess('连接字符串已复制到剪贴板'),
                  )
                } else {
                  console.log(uiWarning('无法复制到剪贴板'))
                }
              }
            }

            // 输出
            if (options.json) {
              console.log(
                JSON.stringify({
                  connectionString,
                  username: credentials.username,
                  password: credentials.password,
                  host: options.host || 'localhost',
                  port: credentials.port,
                  database: credentials.database,
                  engine: credentials.engine,
                  version: credentials.version,
                }),
              )
            } else if (!options.copy) {
              // 仅在不复制时打印连接字符串（以允许管道传输）
              console.log(connectionString)
            }
          } catch (error) {
            const e = error as Error

            if (options.json) {
              console.log(JSON.stringify({ error: e.message }))
            } else {
              console.error(uiError(e.message))
            }
            process.exit(1)
          }
        },
      ),
  )
