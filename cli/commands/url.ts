import { Command } from 'commander'
import { containerManager } from '../../core/container-manager'
import { platformService } from '../../core/platform-service'
import { getEngine } from '../../engines'
import { promptContainerSelect } from '../ui/prompts'
import { uiError, uiWarning, uiSuccess } from '../ui/theme'
import { getEngineMetadata } from '../helpers'
import { isRemoteContainer } from '../../types'
import { loadCredentials } from '../../core/credential-manager'

export const urlCommand = new Command('url')
  .alias('connection-string')
  .description('输出容器的连接字符串')
  .argument('[name]', '容器名称')
  .option('-c, --copy', '复制到剪贴板')
  .option('-d, --database <database>', '使用不同的数据库名称')
  .option(
    '-p, --password',
    '显示包含密码的完整连接字符串（用于远程容器）',
  )
  .option('--json', '以 JSON 格式输出（包含额外连接信息）')
  .action(
    async (
      name: string | undefined,
      options: {
        copy?: boolean
        database?: string
        password?: boolean
        json?: boolean
      },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          if (options.json) {
            console.log(JSON.stringify({ error: '容器名称是必需的' }))
            process.exit(1)
          }

          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('未找到容器'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            '选择容器：',
          )
          if (!selected) return
          containerName = selected
        }

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

        const databaseName = options.database || config.database

        // 远程容器：使用存储的连接字符串
        let connectionString: string
        if (isRemoteContainer(config)) {
          if (options.password) {
            // 从凭据中获取完整的未编辑 URL
            const creds = await loadCredentials(
              config.name,
              config.engine,
              'remote',
            )
            connectionString =
              creds?.connectionString ?? config.remote?.connectionString ?? ''
          } else {
            // 从容器配置中获取已编辑的 URL
            connectionString = config.remote?.connectionString ?? ''
          }
        } else {
          const engine = getEngine(config.engine)
          connectionString = engine.getConnectionString(config, databaseName)
        }

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          const jsonOutput = isRemoteContainer(config)
            ? {
                connectionString,
                host: config.remote?.host,
                port: config.port,
                database: databaseName,
                engine: config.engine,
                container: config.name,
                status: 'linked',
                provider: config.remote?.provider,
                ssl: config.remote?.ssl,
                ...metadata,
              }
            : config.engine === 'sqlite'
              ? {
                  connectionString,
                  path: databaseName,
                  engine: config.engine,
                  container: config.name,
                  ...metadata,
                }
              : {
                  connectionString,
                  host: '127.0.0.1',
                  port: config.port,
                  database: databaseName,
                  user: config.engine === 'postgresql' ? 'postgres' : 'root',
                  engine: config.engine,
                  container: config.name,
                  ...metadata,
                }
          console.log(JSON.stringify(jsonOutput, null, 2))
          return
        }

        if (options.copy) {
          const copied = await platformService.copyToClipboard(connectionString)
          if (copied) {
            console.log(connectionString)
            console.error(uiSuccess('已复制到剪贴板'))
          } else {
            console.log(connectionString)
            console.error(uiWarning('无法复制到剪贴板'))
          }
        } else {
          process.stdout.write(connectionString)
          if (process.stdout.isTTY) {
            console.log()
          }
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
  )
