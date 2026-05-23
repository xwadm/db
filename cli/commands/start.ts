import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { startWithRetry } from '../../core/start-with-retry'
import { getEngine } from '../../engines'
import { postgresqlEngine } from '../../engines/postgresql'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiWarning, uiInfo } from '../ui/theme'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'
import { exitWithError, logDebug } from '../../core/error-handler'
import { isShorthandVersion } from '../../core/version-utils'
import { getEngineMetadata } from '../helpers'
import { isV1 as isFerretDBv1 } from '../../engines/ferretdb/version-maps'

export const startCommand = new Command('start')
  .description('启动容器')
  .argument('[name]', '容器名称')
  .option('-j, --json', '以 JSON 格式输出结果')
  .option('-f, --force', '跳过确认提示（如二进制下载）')
  .option(
    '--bind <address>',
    '绑定地址（默认：127.0.0.1）。持久化保存用于后续启动。',
  )
  .option(
    '--auth',
    '启用认证（MongoDB：--auth 标志，FerretDB v2：SCRAM）。持久化保存。',
  )
  .option(
    '--no-auth',
    '禁用认证（FerretDB v2：传递 --no-auth）。持久化保存。',
  )
  .action(
    async (
      name: string | undefined,
      options: {
        json?: boolean
        force?: boolean
        bind?: string
        auth?: boolean
      },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          // JSON 模式需要容器名称参数
          if (options.json) {
            return exitWithError({
              message: '容器名称是必需的',
              json: true,
            })
          }

          const containers = await containerManager.list()
          const stopped = containers.filter(
            (c) => c.status !== 'running' && c.status !== 'linked',
          )

          if (stopped.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  '未找到容器。请使用以下命令创建：spindb create',
                ),
              )
            } else {
              console.log(uiWarning('所有容器已在运行中'))
            }
            return
          }

          const selected = await promptContainerSelect(
            stopped,
            '选择要启动的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          return exitWithError({
            message: `未找到容器 "${containerName}"`,
            json: options.json,
          })
        }

        const { engine: engineName } = config

        // 远程容器由外部管理
        if (isRemoteContainer(config)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: true,
                name: containerName,
                status: 'linked',
                message: `"${containerName}" 是链接的远程数据库 — 由外部管理。`,
              }),
            )
          } else {
            console.log(
              uiWarning(
                `"${containerName}" 是链接的远程数据库 — 由外部管理。`,
              ),
            )
          }
          return
        }

        // 自动迁移简写版本 → 完整版本（A9 前向兼容）。
        // 旧版 spindb 创建的容器存储简写版本如 'version: 17'；
        // 新版 spindb 存储 'version: 17.10.0'。在新版 spindb 下首次启动时，
        // 我们静默升级持久化的值，使后续启动不受默认值块漂移影响。
        // 跳过基于文件的引擎（SQLite/DuckDB 不按数据文件固定二进制版本）
        // 以及远程/'unknown'。
        if (
          !isFileBasedEngine(engineName) &&
          config.version &&
          config.version !== 'unknown' &&
          isShorthandVersion(config.version)
        ) {
          const dbEngine = getEngine(engineName)
          const fullVersion = dbEngine.resolveFullVersion(config.version)
          if (fullVersion !== config.version) {
            if (!options.json) {
              console.log(
                uiInfo(
                  `将 ${containerName} 固定到 ${dbEngine.displayName} ${fullVersion}（原为 ${config.version}）`,
                ),
              )
            }
            await containerManager.updateConfig(containerName, {
              version: fullVersion,
            })
            config.version = fullVersion
          }
        }

        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (running) {
          if (options.json) {
            return exitWithError({
              message: `容器 "${containerName}" 已在运行中`,
              json: true,
            })
          }
          console.log(
            uiWarning(`容器 "${containerName}" 已在运行中`),
          )
          return
        }

        // 如果提供了绑定地址则持久化保存
        if (options.bind) {
          await containerManager.updateConfig(containerName, {
            bindAddress: options.bind,
          })
          config.bindAddress = options.bind
        }

        // 如果提供了 --auth 或 --no-auth 则持久化保存认证模式
        // Commander 将 --no-auth 解析为 options.auth === false
        if (options.auth !== undefined) {
          const isFerretV1 =
            engineName === Engine.FerretDB && isFerretDBv1(config.version)
          const authSupported =
            engineName === Engine.MongoDB ||
            (engineName === Engine.FerretDB && !isFerretV1)
          if (!authSupported) {
            if (!options.json) {
              const reason = isFerretV1
                ? 'FerretDB v1 不支持 --auth/--no-auth'
                : `${engineName} 不支持 --auth/--no-auth`
              console.log(uiWarning(reason))
            }
          } else {
            await containerManager.updateConfig(containerName, {
              authEnabled: options.auth,
            })
            config.authEnabled = options.auth
          }
        }

        const engineDefaults = getEngineDefaults(engineName)
        const engine = getEngine(engineName)

        // 对于 PostgreSQL，检查是否有兼容的二进制文件可用
        // engine.start() 中的自愈逻辑将处理版本解析
        if (engineName === Engine.PostgreSQL) {
          const hasCompatible = postgresqlEngine.hasCompatibleBinaries(
            config.version,
          )
          if (!hasCompatible) {
            const majorVersion = config.version.split('.')[0]

            if (options.json || options.force) {
              // JSON/强制模式下自动下载（无提示）
              await engine.ensureBinaries(majorVersion)
            } else {
              console.log(
                uiWarning(
                  `未找到 PostgreSQL ${majorVersion}.x 二进制文件（"${containerName}" 需要）`,
                ),
              )
              const confirmed = await promptConfirm(
                `现在下载 PostgreSQL ${majorVersion}？`,
                true,
              )
              if (!confirmed) {
                console.log(
                  chalk.gray(
                    `  运行 "spindb engines download postgresql ${majorVersion}" 手动下载。`,
                  ),
                )
                return
              }

              const downloadSpinner = createSpinner(
                `正在下载 PostgreSQL ${majorVersion}...`,
              )
              downloadSpinner.start()

              try {
                await engine.ensureBinaries(
                  majorVersion,
                  ({ stage, message }) => {
                    if (stage === 'cached') {
                      downloadSpinner.text = `PostgreSQL ${majorVersion} 就绪`
                    } else {
                      downloadSpinner.text = message
                    }
                  },
                )
                downloadSpinner.succeed(`PostgreSQL ${majorVersion} 已下载`)
              } catch (downloadError) {
                downloadSpinner.fail(
                  `无法为 "${containerName}" 下载 PostgreSQL ${majorVersion}`,
                )
                throw downloadError
              }
            }
          }
        }

        const spinner = options.json
          ? null
          : createSpinner(`正在启动 ${containerName}...`)
        spinner?.start()

        const result = await startWithRetry({
          engine,
          config,
          onPortChange: (oldPort, newPort) => {
            if (spinner) {
              spinner.text = `端口 ${oldPort} 被占用，正在尝试端口 ${newPort}...`
            }
          },
        })

        if (!result.success) {
          spinner?.fail(`启动 "${containerName}" 失败`)
          return exitWithError({
            message: result.error?.message || '未知错误',
            json: options.json,
          })
        }

        await containerManager.updateConfig(containerName, {
          status: 'running',
        })

        if (result.retriesUsed > 0) {
          spinner?.warn(
            `容器 "${containerName}" 已在端口 ${result.finalPort} 启动（原端口被占用）`,
          )
        } else {
          spinner?.succeed(`容器 "${containerName}" 已启动`)
        }

        // 确保用户数据库存在（可能已存在，这没问题）
        const defaultDb = engineDefaults.superuser
        if (config.database && config.database !== defaultDb) {
          const dbSpinner = options.json
            ? null
            : createSpinner(`正在确保数据库 "${config.database}" 存在...`)
          dbSpinner?.start()
          try {
            await engine.createDatabase(config, config.database)
            dbSpinner?.succeed(`数据库 "${config.database}" 就绪`)
          } catch (error) {
            const msg = (error as Error).message ?? ''
            if (/already exists/i.test(msg)) {
              dbSpinner?.succeed(`数据库 "${config.database}" 就绪`)
            } else {
              dbSpinner?.fail(`创建数据库 "${config.database}" 失败`)
              logDebug(`createDatabase 错误：${msg}`)
            }
          }
        }

        // 同步数据库注册表与实际服务器状态（静默，非阻塞）
        if (!isFileBasedEngine(config.engine)) {
          try {
            await containerManager.syncDatabases(containerName)
          } catch (syncError) {
            // 如果同步失败不中断启动 - 仅记录调试日志
            logDebug(
              `同步 ${containerName} 的数据库失败：${syncError}`,
            )
          }
        }

        const connectionString = engine.getConnectionString(config)

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(
            JSON.stringify({
              success: true,
              name: containerName,
              engine: config.engine,
              port: result.finalPort,
              connectionString,
              portChanged: result.retriesUsed > 0,
              ...metadata,
            }),
          )
        } else {
          console.log()
          console.log(chalk.gray('  连接字符串：'))
          console.log(chalk.cyan(`  ${connectionString}`))
          console.log()
          console.log(chalk.gray('  使用以下命令连接：'))
          console.log(chalk.cyan(`  spindb connect ${containerName}`))
          console.log()
        }
      } catch (error) {
        const e = error as Error
        return exitWithError({ message: e.message, json: options.json })
      }
    },
  )
