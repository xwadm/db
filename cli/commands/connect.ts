import { Command } from 'commander'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  isLitecliInstalled,
  isIredisInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  installLitecli,
  installIredis,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
  getLitecliManualInstructions,
  getIredisManualInstructions,
} from '../../core/dependency-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect } from '../ui/prompts'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../ui/theme'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'
import { configManager } from '../../core/config-manager'
import { loadCredentials } from '../../core/credential-manager'
import {
  redactConnectionString,
  parseConnectionString,
} from '../../core/remote-container'
import { DBLAB_ENGINES, getDblabArgs } from '../../core/dblab-utils'
import { downloadDblabCli } from './menu/shell-handlers'

export const connectCommand = new Command('connect')
  .alias('shell')
  .description('使用数据库客户端连接到容器')
  .argument('[name]', '容器名称')
  .option('-d, --database <name>', '数据库名称')
  .option('--tui', '使用 usql 获得增强的 Shell 体验')
  .option('--install-tui', '如未安装则安装 usql，然后连接')
  .option(
    '--pgcli',
    '使用 pgcli 获得增强的 PostgreSQL Shell（下拉自动补全）',
  )
  .option('--install-pgcli', '如未安装则安装 pgcli，然后连接')
  .option(
    '--mycli',
    '使用 mycli 获得增强的 MySQL Shell（下拉自动补全）',
  )
  .option('--install-mycli', '如未安装则安装 mycli，然后连接')
  .option(
    '--litecli',
    '使用 litecli 获得增强的 SQLite Shell（自动补全、语法高亮）',
  )
  .option('--install-litecli', '如未安装则安装 litecli，然后连接')
  .option(
    '--iredis',
    '使用 iredis 获得增强的 Redis Shell（自动补全、语法高亮）',
  )
  .option('--install-iredis', '如未安装则安装 iredis，然后连接')
  .option('--dblab', '使用 dblab 可视化 TUI（表浏览器、查询编辑器）')
  .option('--install-dblab', '如未安装则下载 dblab，然后连接')
  .option('--ui', '打开内置 Web UI（仅 DuckDB）')
  .action(
    async (
      name: string | undefined,
      options: {
        database?: string
        tui?: boolean
        installTui?: boolean
        pgcli?: boolean
        installPgcli?: boolean
        mycli?: boolean
        installMycli?: boolean
        litecli?: boolean
        installLitecli?: boolean
        iredis?: boolean
        installIredis?: boolean
        dblab?: boolean
        installDblab?: boolean
        ui?: boolean
      },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()
          // 远程容器始终可连接，基于文件的引擎需要文件存在，服务器引擎需要运行中
          const connectable = containers.filter((c) => {
            if (isRemoteContainer(c)) return true
            if (isFileBasedEngine(c.engine)) {
              return existsSync(c.database)
            }
            return c.status === 'running'
          })

          if (connectable.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  '未找到容器。请使用以下命令创建：spindb create',
                ),
              )
            } else {
              console.log(
                uiWarning(
                  '没有运行中的容器。请先启动：spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            connectable,
            '选择要连接的容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`未找到容器 "${containerName}"`))
          process.exit(1)
        }

        const { engine: engineName } = config
        const engineDefaults = getEngineDefaults(engineName)

        const database =
          options.database ?? config.database ?? engineDefaults.superuser

        // 远程容器：跳过运行检查，使用存储的连接字符串
        const isRemote = isRemoteContainer(config)

        if (!isRemote) {
          // 基于文件的引擎：检查文件是否存在而非运行状态
          if (isFileBasedEngine(engineName)) {
            if (!existsSync(config.database)) {
              console.error(
                uiError(`数据库文件未找到：${config.database}`),
              )
              process.exit(1)
            }
          } else {
            // 服务器数据库需要处于运行状态
            const running = await processManager.isRunning(containerName, {
              engine: engineName,
            })
            if (!running) {
              console.error(
                uiError(
                  `容器 "${containerName}" 未运行。请先启动。`,
                ),
              )
              process.exit(1)
            }
          }
        }

        const engine = getEngine(engineName)

        // 对于远程容器，从凭据中检索完整连接字符串
        let connectionString: string
        if (isRemote) {
          const creds = await loadCredentials(
            containerName,
            config.engine,
            'remote',
          )
          if (creds) {
            connectionString = creds.connectionString
          } else {
            // 回退：使用配置中的已编辑 URL（密码将为 ***）
            connectionString = config.remote?.connectionString ?? ''
            if (!connectionString) {
              console.error(
                uiError(
                  '未找到此链接容器的连接字符串。请重新链接：spindb link <url>',
                ),
              )
              process.exit(1)
            }
          }
        } else {
          connectionString = engine.getConnectionString(config, database)
        }

        const useUsql = options.tui || options.installTui
        if (useUsql) {
          const usqlInstalled = await isUsqlInstalled()

          if (!usqlInstalled) {
            if (options.installTui) {
              console.log(
                uiInfo('正在安装 usql 以获得增强的 Shell 体验...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installUsql(pm)
                if (result.success) {
                  console.log(uiSuccess('usql 安装成功！'))
                  console.log()
                } else {
                  console.error(
                    uiError(`安装 usql 失败：${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('手动安装：'))
                  for (const instruction of getUsqlManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('未找到支持的包管理器'))
                console.log()
                console.log(chalk.gray('手动安装：'))
                for (const instruction of getUsqlManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('usql 未安装'))
              console.log()
              console.log(
                chalk.gray('安装 usql 以获得增强的 Shell 体验：'),
              )
              console.log(chalk.cyan('  spindb connect --install-tui'))
              console.log()
              console.log(chalk.gray('或手动安装：'))
              for (const instruction of getUsqlManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const usePgcli = options.pgcli || options.installPgcli
        if (usePgcli) {
          if (engineName !== 'postgresql') {
            console.error(
              uiError('pgcli 仅适用于 PostgreSQL 容器'),
            )
            console.log(chalk.gray('对于 MySQL，请使用：spindb connect --mycli'))
            process.exit(1)
          }

          const pgcliInstalled = await isPgcliInstalled()

          if (!pgcliInstalled) {
            if (options.installPgcli) {
              console.log(
                uiInfo('正在安装 pgcli 以获得增强的 PostgreSQL Shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installPgcli(pm)
                if (result.success) {
                  console.log(uiSuccess('pgcli 安装成功！'))
                  console.log()
                } else {
                  console.error(
                    uiError(`安装 pgcli 失败：${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('手动安装：'))
                  for (const instruction of getPgcliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('未找到支持的包管理器'))
                console.log()
                console.log(chalk.gray('手动安装：'))
                for (const instruction of getPgcliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('pgcli 未安装'))
              console.log()
              console.log(
                chalk.gray('安装 pgcli 以获得增强的 PostgreSQL Shell：'),
              )
              console.log(chalk.cyan('  spindb connect --install-pgcli'))
              console.log()
              console.log(chalk.gray('或手动安装：'))
              for (const instruction of getPgcliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useMycli = options.mycli || options.installMycli
        if (useMycli) {
          if (engineName !== 'mysql') {
            console.error(
              uiError('mycli 仅适用于 MySQL 容器'),
            )
            console.log(
              chalk.gray('对于 PostgreSQL，请使用：spindb connect --pgcli'),
            )
            process.exit(1)
          }

          const mycliInstalled = await isMycliInstalled()

          if (!mycliInstalled) {
            if (options.installMycli) {
              console.log(
                uiInfo('正在安装 mycli 以获得增强的 MySQL Shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installMycli(pm)
                if (result.success) {
                  console.log(uiSuccess('mycli 安装成功！'))
                  console.log()
                } else {
                  console.error(
                    uiError(`安装 mycli 失败：${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('手动安装：'))
                  for (const instruction of getMycliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('未找到支持的包管理器'))
                console.log()
                console.log(chalk.gray('手动安装：'))
                for (const instruction of getMycliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('mycli 未安装'))
              console.log()
              console.log(chalk.gray('安装 mycli 以获得增强的 MySQL Shell：'))
              console.log(chalk.cyan('  spindb connect --install-mycli'))
              console.log()
              console.log(chalk.gray('或手动安装：'))
              for (const instruction of getMycliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useLitecli = options.litecli || options.installLitecli
        if (useLitecli) {
          if (engineName !== Engine.SQLite) {
            console.error(
              uiError('litecli 仅适用于 SQLite 容器'),
            )
            if (engineName === 'postgresql') {
              console.log(
                chalk.gray('对于 PostgreSQL，请使用：spindb connect --pgcli'),
              )
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('对于 MySQL，请使用：spindb connect --mycli'))
            }
            process.exit(1)
          }

          const litecliInstalled = await isLitecliInstalled()

          if (!litecliInstalled) {
            if (options.installLitecli) {
              console.log(
                uiInfo('正在安装 litecli 以获得增强的 SQLite Shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installLitecli(pm)
                if (result.success) {
                  console.log(uiSuccess('litecli 安装成功！'))
                  console.log()
                } else {
                  console.error(
                    uiError(`安装 litecli 失败：${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('手动安装：'))
                  for (const instruction of getLitecliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('未找到支持的包管理器'))
                console.log()
                console.log(chalk.gray('手动安装：'))
                for (const instruction of getLitecliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('litecli 未安装'))
              console.log()
              console.log(
                chalk.gray('安装 litecli 以获得增强的 SQLite Shell：'),
              )
              console.log(chalk.cyan('  spindb connect --install-litecli'))
              console.log()
              console.log(chalk.gray('或手动安装：'))
              for (const instruction of getLitecliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useIredis = options.iredis || options.installIredis
        if (useIredis) {
          if (engineName !== Engine.Redis) {
            console.error(
              uiError('iredis 仅适用于 Redis 容器'),
            )
            if (engineName === 'postgresql') {
              console.log(
                chalk.gray('对于 PostgreSQL，请使用：spindb connect --pgcli'),
              )
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('对于 MySQL，请使用：spindb connect --mycli'))
            } else if (engineName === Engine.SQLite) {
              console.log(
                chalk.gray('对于 SQLite，请使用：spindb connect --litecli'),
              )
            }
            process.exit(1)
          }

          const iredisInstalled = await isIredisInstalled()

          if (!iredisInstalled) {
            if (options.installIredis) {
              console.log(
                uiInfo('正在安装 iredis 以获得增强的 Redis Shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installIredis(pm)
                if (result.success) {
                  console.log(uiSuccess('iredis 安装成功！'))
                  console.log()
                } else {
                  console.error(
                    uiError(`安装 iredis 失败：${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('手动安装：'))
                  for (const instruction of getIredisManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('未找到支持的包管理器'))
                console.log()
                console.log(chalk.gray('手动安装：'))
                for (const instruction of getIredisManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('iredis 未安装'))
              console.log()
              console.log(
                chalk.gray('安装 iredis 以获得增强的 Redis Shell：'),
              )
              console.log(chalk.cyan('  spindb connect --install-iredis'))
              console.log()
              console.log(chalk.gray('或手动安装：'))
              for (const instruction of getIredisManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useDblab = options.dblab || options.installDblab
        if (useDblab) {
          if (!DBLAB_ENGINES.has(engineName)) {
            console.error(
              uiError(`dblab 不支持 ${engineName} 容器`),
            )
            process.exit(1)
          }

          let dblabPath = await configManager.getBinaryPath('dblab')

          if (!dblabPath) {
            if (options.installDblab) {
              dblabPath = await downloadDblabCli()
              if (!dblabPath) {
                process.exit(1)
              }
            } else {
              console.error(uiError('dblab 未安装'))
              console.log()
              console.log(chalk.gray('下载 dblab：'))
              console.log(chalk.cyan('  spindb connect --install-dblab'))
              console.log()
              console.log(chalk.gray('或从以下地址手动下载：'))
              console.log(
                chalk.cyan('  https://github.com/danvergara/dblab/releases'),
              )
              process.exit(1)
            }
          }

          const dblabArgs = getDblabArgs(config, database)
          const dblabProcess = spawn(dblabPath, dblabArgs, {
            stdio: 'inherit',
          })

          await new Promise<void>((resolve) => {
            dblabProcess.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT') {
                console.log(uiWarning('未找到 dblab。'))
                console.log(chalk.gray('  使用以下命令下载：'))
                console.log(chalk.cyan('  spindb connect --install-dblab'))
              } else {
                console.error(uiError(err.message))
              }
              resolve()
            })
            dblabProcess.on('close', () => resolve())
          })

          return
        }

        if (options.ui) {
          if (engineName !== Engine.DuckDB) {
            console.error(
              uiError('--ui 仅适用于 DuckDB 容器'),
            )
            process.exit(1)
          }

          const duckdbPath = await configManager.getBinaryPath('duckdb')
          if (!duckdbPath) {
            console.error(
              uiError(
                '未找到 DuckDB 二进制文件。使用以下命令下载：spindb engines download duckdb',
              ),
            )
            process.exit(1)
          }

          const uiProcess = spawn(duckdbPath, [config.database, '-ui'], {
            stdio: 'inherit',
          })

          await new Promise<void>((resolve) => {
            uiProcess.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT') {
                console.log(uiWarning('未找到 DuckDB 二进制文件。'))
              } else {
                console.error(uiError(err.message))
              }
              resolve()
            })
            uiProcess.on('close', () => resolve())
          })

          return
        }

        console.log(uiInfo(`正在连接到 ${containerName}:${database}...`))
        console.log()

        // 对于远程容器，从连接字符串解析主机/端口/密码/用户名
        // 以便原生客户端（redis-cli, mysql 等）连接到远程主机
        const remoteHost = isRemote
          ? (config.remote?.host ?? '127.0.0.1')
          : '127.0.0.1'
        const remotePort = isRemote ? config.port || 0 : config.port
        let remotePassword = ''
        let remoteUsername = ''
        if (isRemote) {
          try {
            const parsed = parseConnectionString(connectionString)
            remotePassword = parsed.password
            remoteUsername = parsed.username
          } catch {
            // 如果解析失败，继续不使用密码/用户名参数
          }
        }

        let clientCmd: string
        let clientArgs: string[]

        if (useLitecli) {
          clientCmd = 'litecli'
          clientArgs = [config.database]
        } else if (useIredis) {
          clientCmd = 'iredis'
          clientArgs = [
            '-h',
            remoteHost,
            '-p',
            String(remotePort),
            '-n',
            database,
          ]
          if (isRemote && remotePassword) {
            clientArgs.push('-a', remotePassword)
          }
        } else if (usePgcli) {
          clientCmd = 'pgcli'
          clientArgs = [connectionString]
        } else if (useMycli) {
          clientCmd = 'mycli'
          if (isRemote) {
            // mycli 支持连接字符串
            clientArgs = [connectionString]
          } else {
            clientArgs = [
              '-h',
              '127.0.0.1',
              '-P',
              String(config.port),
              '-u',
              engineDefaults.superuser,
              database,
            ]
          }
        } else if (useUsql) {
          clientCmd = 'usql'
          clientArgs = [connectionString]
        } else if (engineName === Engine.SQLite) {
          clientCmd = 'sqlite3'
          clientArgs = [config.database]
        } else if (engineName === Engine.Redis) {
          clientCmd = 'redis-cli'
          clientArgs = [
            '-h',
            remoteHost,
            '-p',
            String(remotePort),
            '-n',
            database,
          ]
          if (isRemote && remotePassword) {
            clientArgs.push('-a', remotePassword)
          }
        } else if (engineName === 'mysql') {
          clientCmd = 'mysql'
          if (isRemote) {
            clientArgs = [
              '-h',
              remoteHost,
              '-P',
              String(remotePort),
              '-u',
              remoteUsername || engineDefaults.superuser,
              database,
            ]
            if (remotePassword) {
              clientArgs.push(`-p${remotePassword}`)
            }
          } else {
            clientArgs = [
              '-h',
              '127.0.0.1',
              '-P',
              String(config.port),
              '-u',
              engineDefaults.superuser,
              database,
            ]
          }
        } else {
          clientCmd = 'psql'
          clientArgs = [connectionString]
        }

        const clientProcess = spawn(clientCmd, clientArgs, {
          stdio: 'inherit',
        })

        clientProcess.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            console.log(uiWarning(`系统上未找到 ${clientCmd}。`))
            console.log()
            console.log(
              chalk.gray('  安装客户端工具或手动连接：'),
            )
            console.log(
              chalk.cyan(
                `  ${isRemote ? redactConnectionString(connectionString) : connectionString}`,
              ),
            )
            console.log()

            if (clientCmd === 'usql') {
              console.log(chalk.gray('  安装 usql：'))
              console.log(
                chalk.cyan('  brew tap xo/xo && brew install xo/xo/usql'),
              )
            } else if (clientCmd === 'pgcli') {
              console.log(chalk.gray('  安装 pgcli：'))
              console.log(chalk.cyan('  brew install pgcli'))
            } else if (clientCmd === 'mycli') {
              console.log(chalk.gray('  安装 mycli：'))
              console.log(chalk.cyan('  brew install mycli'))
            } else if (clientCmd === 'litecli') {
              console.log(chalk.gray('  安装 litecli：'))
              console.log(chalk.cyan('  brew install litecli'))
            } else if (clientCmd === 'iredis') {
              console.log(chalk.gray('  安装 iredis：'))
              console.log(chalk.cyan('  pip install iredis'))
            } else if (clientCmd === 'redis-cli') {
              console.log(chalk.gray('  安装 Redis：'))
              console.log(chalk.cyan('  brew install redis'))
            } else if (clientCmd === 'sqlite3') {
              console.log(chalk.gray('  sqlite3 随 macOS 自带。'))
              console.log(chalk.gray('  如果不可用，请检查您的 PATH。'))
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('  在 macOS 上使用 Homebrew：'))
              console.log(chalk.cyan('  brew install mysql-client'))
            } else {
              console.log(chalk.gray('  在 macOS 上使用 Homebrew：'))
              console.log(
                chalk.cyan('  brew install libpq && brew link --force libpq'),
              )
            }
            console.log()
          } else {
            console.error(uiError(err.message))
          }
        })

        await new Promise<void>((resolve) => {
          clientProcess.on('close', () => resolve())
        })
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
