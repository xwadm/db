import { Command } from 'commander'
import { mkdir } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import {
  parseConnectionString,
  detectEngineFromConnectionString,
  detectProvider,
  generateRemoteContainerName,
  redactConnectionString,
  buildRemoteConfig,
  getDefaultPortForEngine,
  isLocalhost,
} from '../../core/remote-container'
import { saveCredentials } from '../../core/credential-manager'
import { paths } from '../../config/paths'
import { uiSuccess, uiWarning } from '../ui/theme'
import { exitWithError, logDebug } from '../../core/error-handler'
import { getEngineMetadata } from '../helpers'
import { Engine } from '../../types'
import type { ContainerConfig } from '../../types'

/**
 * 验证提供的引擎字符串是否为有效的 Engine 枚举值。
 */
function resolveEngine(engineStr: string): Engine | null {
  const normalized = engineStr.toLowerCase()
  const values = Object.values(Engine) as string[]
  if (values.includes(normalized)) {
    return normalized as Engine
  }
  // 常见别名
  const aliases: Record<string, Engine> = {
    pg: Engine.PostgreSQL,
    postgres: Engine.PostgreSQL,
    mongo: Engine.MongoDB,
    mariadb: Engine.MariaDB,
    cockroach: Engine.CockroachDB,
    surreal: Engine.SurrealDB,
  }
  return aliases[normalized] ?? null
}

export const linkCommand = new Command('link')
  .description('将外部数据库链接到 SpinDB')
  .argument('<connection-string>', '数据库连接字符串（URL 格式）')
  .argument('[name]', '容器名称（省略则自动生成）')
  .option('--engine <engine>', '引擎类型（从 URL 方案自动检测）')
  .option('-d, --database <name>', '数据库名称（从 URL 提取）')
  .option('--provider <name>', '提供商提示（从主机名自动检测）')
  .option('--provider-id <id>', '此数据库的提供商标识符')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      connectionString: string,
      nameArg: string | undefined,
      options: {
        engine?: string
        database?: string
        provider?: string
        providerId?: string
        json?: boolean
      },
    ) => {
      try {
        // 解析连接字符串
        let parsed
        try {
          parsed = parseConnectionString(connectionString)
        } catch (error) {
          return exitWithError({
            message: (error as Error).message,
            json: options.json,
          })
        }

        // 检测或验证引擎
        let engine: Engine
        if (options.engine) {
          const resolved = resolveEngine(options.engine)
          if (!resolved) {
            return exitWithError({
              message: `未知引擎："${options.engine}"。请使用：postgresql, mysql, mongodb, redis 等。`,
              json: options.json,
            })
          }
          engine = resolved
        } else {
          const detected = detectEngineFromConnectionString(connectionString)
          if (!detected) {
            return exitWithError({
              message:
                '无法从连接字符串方案检测引擎。请使用 --engine 指定。',
              json: options.json,
            })
          }
          engine = detected
        }

        // 提取连接详情
        const host = parsed.host
        const port = parsed.port ?? getDefaultPortForEngine(engine)
        const database = options.database || parsed.database || 'default'

        // 检测提供商
        const provider = options.provider ?? detectProvider(host)

        // SpinDB 对 localhost 连接的冲突检查
        if (isLocalhost(host) && port > 0) {
          const containers = await containerManager.list()
          const conflicting = containers.find(
            (c) =>
              c.engine === engine && c.port === port && c.status !== 'linked',
          )
          if (conflicting) {
            return exitWithError({
              message: `端口 ${port} 已由 SpinDB 容器 "${conflicting.name}" 管理。请使用 "spindb connect ${conflicting.name}" 替代。`,
              json: options.json,
            })
          }
        }

        // 生成或验证容器名称
        const containerName =
          nameArg ??
          generateRemoteContainerName({
            engine,
            host,
            database,
            provider,
          })

        // 验证名称格式
        if (!containerManager.isValidName(containerName)) {
          return exitWithError({
            message: `无效的容器名称："${containerName}"。必须以字母开头，仅包含字母、数字、连字符和下划线。`,
            json: options.json,
          })
        }

        // 检查引擎命名空间内的唯一性
        if (await containerManager.exists(containerName, { engine })) {
          return exitWithError({
            message: `引擎 ${engine} 的容器 "${containerName}" 已存在。请选择其他名称。`,
            json: options.json,
          })
        }

        // 版本检测占位符（需要引擎特定的客户端二进制文件）
        const detectedVersion = ''

        // 创建容器目录
        const containerPath = paths.getContainerPath(containerName, {
          engine,
        })
        await mkdir(containerPath, { recursive: true })

        // 构建远程配置
        const remoteConfig = buildRemoteConfig({
          host,
          connectionString,
          provider,
          providerId: options.providerId,
        })

        // 创建带有 'linked' 状态的容器配置
        const config: ContainerConfig = {
          name: containerName,
          engine,
          version: detectedVersion || 'unknown',
          port,
          database,
          databases: [database],
          created: new Date().toISOString(),
          status: 'linked',
          remote: remoteConfig,
        }

        await containerManager.saveConfig(containerName, { engine }, config)

        // 通过凭据管理器保存完整连接字符串
        // 链接容器始终使用 'remote' 作为凭据键。
        // 实际的数据库用户名存储在文件内容中（DB_USER 字段）。
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
          // 凭据保存失败 — 警告，因为完整连接字符串将无法恢复
          if (!options.json) {
            console.log(
              uiWarning(
                '无法保存凭据。完整连接字符串可能无法检索。',
              ),
            )
          }
          logDebug(`凭据保存失败：${(credError as Error).message}`)
        }

        // 输出
        if (options.json) {
          const metadata = await getEngineMetadata(engine)
          console.log(
            JSON.stringify(
              {
                success: true,
                name: containerName,
                engine,
                host,
                port,
                database,
                status: 'linked',
                origin: remoteConfig.origin,
                provider: provider ?? undefined,
                providerId: remoteConfig.providerId,
                ssl: remoteConfig.ssl,
                connectionString: redactConnectionString(connectionString),
                ...metadata,
              },
              null,
              2,
            ),
          )
        } else {
          console.log()
          console.log(uiSuccess(`已将远程数据库链接为 "${containerName}"`))
          console.log()
          console.log(
            chalk.gray('  ') +
              chalk.white('引擎：'.padEnd(14)) +
              chalk.cyan(engine),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('主机：'.padEnd(14)) +
              chalk.cyan(host),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('端口：'.padEnd(14)) +
              chalk.green(String(port)),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('数据库：'.padEnd(14)) +
              chalk.yellow(database),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('来源：'.padEnd(14)) +
              (remoteConfig.origin === 'layerbase-cloud'
                ? chalk.cyan('Layerbase Cloud')
                : chalk.magenta('外部')),
          )
          if (provider) {
            console.log(
              chalk.gray('  ') +
                chalk.white('提供商：'.padEnd(14)) +
                chalk.magenta(provider),
            )
          }
          if (remoteConfig.providerId) {
            console.log(
              chalk.gray('  ') +
                chalk.white('提供商 ID：'.padEnd(14)) +
                chalk.magenta(remoteConfig.providerId),
            )
          }
          console.log(
            chalk.gray('  ') +
              chalk.white('SSL：'.padEnd(14)) +
              (remoteConfig.ssl ? chalk.green('是') : chalk.gray('否')),
          )
          console.log()
          console.log(chalk.gray('  连接字符串（已编辑）：'))
          console.log(
            chalk.cyan(`  ${redactConnectionString(connectionString)}`),
          )
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
