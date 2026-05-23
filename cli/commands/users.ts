import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { generatePassword } from '../../core/credential-generator'
import {
  saveCredentials,
  listCredentials,
  credentialsExist,
  getDefaultUsername,
} from '../../core/credential-manager'
import {
  assertValidUsername,
  UnsupportedOperationError,
} from '../../core/error-handler'
import { platformService } from '../../core/platform-service'
import { isFileBasedEngine } from '../../types'
import { uiError, uiSuccess, uiWarning } from '../ui/theme'

function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }))
  } else {
    console.error(uiError(message))
  }
  process.exit(1)
}

export const usersCommand = new Command('users').description(
  '管理数据库用户和凭据',
)

usersCommand
  .command('create')
  .description('创建数据库用户')
  .argument('<container>', '容器名称')
  .argument('[username]', '要创建的用户名')
  .option('-p, --password <password>', '使用指定密码')
  .option('-d, --database <database>', '授权的目标数据库')
  .option('-c, --copy', '将连接字符串复制到剪贴板')
  .option('-j, --json', '以 JSON 格式输出')
  .option('--no-save', '不将凭据保存到磁盘')
  .option('--force', '覆盖现有凭据文件')
  .action(
    async (
      containerName: string,
      username: string | undefined,
      options: {
        password?: string
        database?: string
        copy?: boolean
        json?: boolean
        save: boolean
        force?: boolean
      },
    ) => {
      try {
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          exitWithError(
            `未找到容器 "${containerName}"。请运行 "spindb list" 查看可用容器。`,
            options.json,
          )
        }

        const engineName = config.engine

        // 检查容器是否运行（基于文件的引擎跳过）
        if (!isFileBasedEngine(engineName)) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            exitWithError(
              `容器 "${containerName}" 未运行。请先启动：spindb start ${containerName}`,
              options.json,
            )
          }
        }

        // 如果未提供则使用默认用户名
        const resolvedUsername = username || getDefaultUsername(config.engine)

        assertValidUsername(resolvedUsername)

        const engine = getEngine(engineName)

        // 生成或使用提供的密码
        const password =
          options.password ||
          generatePassword({ length: 20, alphanumericOnly: true })

        const database = options.database || config.database

        // 检查凭据文件是否已存在
        if (
          options.save &&
          !options.force &&
          credentialsExist(containerName, engineName, resolvedUsername)
        ) {
          exitWithError(
            `"${containerName}" 中 "${resolvedUsername}" 的凭据文件已存在。使用 --force 覆盖。`,
            options.json,
          )
        }

        // 在数据库中创建用户
        const credentials = await engine.createUser(config, {
          username: resolvedUsername,
          password,
          database,
        })

        // 将凭据保存到磁盘（非致命 — 凭据已创建）
        let credentialFile: string | undefined
        if (options.save) {
          try {
            credentialFile = await saveCredentials(
              containerName,
              engineName,
              credentials,
            )
          } catch (error) {
            if (!options.json) {
              console.error(
                uiWarning(
                  `无法将凭据保存到磁盘：${(error as Error).message}`,
                ),
              )
            }
            process.exitCode = 1
          }
        }

        // 在输出前复制到剪贴板，以便 JSON 包含状态
        let clipboardCopied: boolean | undefined
        if (options.copy) {
          const textToCopy = credentials.apiKey || credentials.connectionString
          if (textToCopy) {
            clipboardCopied = await platformService.copyToClipboard(textToCopy)
          }
        }

        // 输出结果
        if (options.json) {
          const result: Record<string, unknown> = {
            username: credentials.username,
            password: credentials.password,
            ...(credentials.database != null && {
              database: credentials.database,
            }),
            connectionString: credentials.connectionString,
            ...(credentials.apiKey != null && { apiKey: credentials.apiKey }),
            ...(credentialFile != null && {
              credentialFile,
            }),
            ...(clipboardCopied !== undefined && { clipboardCopied }),
          }
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log()
          console.log(uiSuccess(`已创建用户 "${resolvedUsername}"`))
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
              console.log(
                `  ${chalk.gray('数据库：')}  ${credentials.database}`,
              )
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

          // 在人类可读输出中显示剪贴板状态
          if (clipboardCopied !== undefined) {
            if (clipboardCopied) {
              console.log(
                uiSuccess(
                  credentials.apiKey
                    ? 'API 密钥已复制到剪贴板'
                    : '连接字符串已复制到剪贴板',
                ),
              )
            } else {
              console.log(uiWarning('无法复制到剪贴板'))
            }
          }
        }
      } catch (error) {
        if (error instanceof UnsupportedOperationError) {
          exitWithError(
            '此引擎不支持用户管理',
            options.json,
          )
        }
        exitWithError((error as Error).message, options.json)
      }
    },
  )

usersCommand
  .command('list')
  .description('列出容器的已保存凭据')
  .argument('<container>', '容器名称')
  .option('-j, --json', '以 JSON 格式输出')
  .action(async (containerName: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(containerName)
      if (!config) {
        exitWithError(`未找到容器 "${containerName}"`, options.json)
      }

      const usernames = await listCredentials(containerName, config.engine)

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              container: containerName,
              engine: config.engine,
              users: usernames,
            },
            null,
            2,
          ),
        )
      } else {
        if (usernames.length === 0) {
          console.log()
          console.log(chalk.gray(`"${containerName}" 没有已保存的凭据`))
          console.log(
            chalk.gray(
              `  使用以下命令创建：spindb users create ${containerName} <username>`,
            ),
          )
          console.log()
        } else {
          console.log()
          console.log(chalk.bold(`"${containerName}" 的已保存凭据：`))
          for (const user of usernames) {
            console.log(`  ${chalk.cyan(user)}`)
          }
          console.log()
        }
      }
    } catch (error) {
      exitWithError((error as Error).message, options.json)
    }
  })
