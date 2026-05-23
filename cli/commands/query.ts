import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptInstallDependencies } from '../ui/prompts'
import { uiError, uiWarning } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import {
  Engine,
  isFileBasedEngine,
  isRemoteContainer,
  type QueryOptions,
  type QueryResult,
} from '../../types'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { parseConnectionString } from '../../core/remote-container'

/**
 * 将 QueryResult 格式化为终端输出的表格
 */
function formatTable(result: QueryResult): string {
  if (result.columns.length === 0 || result.rows.length === 0) {
    return '(0 行)'
  }

  // 计算列宽
  const widths: number[] = result.columns.map((col) => col.length)

  for (const row of result.rows) {
    for (let i = 0; i < result.columns.length; i++) {
      const col = result.columns[i]
      const value = formatValue(row[col])
      widths[i] = Math.max(widths[i], value.length)
    }
  }

  // 构建表头
  const header = result.columns
    .map((col, i) => col.padEnd(widths[i]))
    .join(' | ')

  // 构建分隔线
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')

  // 构建数据行
  const rows = result.rows.map((row) =>
    result.columns
      .map((col, i) => formatValue(row[col]).padEnd(widths[i]))
      .join(' | '),
  )

  // 组合输出
  const lines = [header, separator, ...rows]

  // 添加行数统计
  const countMsg =
    result.rowCount === 1 ? '(1 行)' : `(${result.rowCount} 行)`
  lines.push('')
  lines.push(countMsg)

  return lines.join('\n')
}

/**
 * 格式化值以供显示
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export const queryCommand = new Command('query')
  .description('执行查询并返回结果')
  .argument('<name>', '容器名称')
  .argument('<query>', '要执行的查询')
  .option('-d, --database <name>', '目标数据库（默认为主数据库）')
  .option('-n, --namespace <name>', '目标命名空间（SurrealDB）')
  .option('--json', '以 JSON 格式输出结果')
  .action(
    async (
      name: string,
      query: string,
      options: { database?: string; namespace?: string; json?: boolean },
    ) => {
      try {
        const containerName = name

        let config = await containerManager.getConfig(containerName)
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

        const { engine: engineName } = config

        // 如果是链接容器，构建远程查询选项
        let remoteQueryOptions: QueryOptions | undefined
        if (isRemoteContainer(config)) {
          const creds = await loadCredentials(
            containerName,
            engineName,
            'remote',
          )
          if (!creds?.connectionString) {
            const errorMsg = `未找到远程容器 "${containerName}" 的凭据。请尝试重新链接：spindb link`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          const parsed = parseConnectionString(creds.connectionString)
          remoteQueryOptions = {
            host: parsed.host,
            password: parsed.password,
            username: parsed.username,
            ssl: config.remote?.ssl,
            scheme: parsed.scheme,
          }
          // 如果连接字符串指定了端口，则覆盖端口
          if (parsed.port) {
            config = { ...config, port: parsed.port }
          }
        } else if (isFileBasedEngine(engineName)) {
          // 基于文件的数据库：检查文件是否存在而非运行状态
          if (!existsSync(config.database)) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `数据库文件未找到：${config.database}`,
                }),
              )
            } else {
              console.error(
                uiError(`数据库文件未找到：${config.database}`),
              )
            }
            process.exit(1)
          }
        } else {
          // 服务器数据库需要处于运行状态
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `容器 "${containerName}" 未运行`,
                }),
              )
            } else {
              console.error(
                uiError(
                  `容器 "${containerName}" 未运行。请先启动：spindb start ${containerName}`,
                ),
              )
            }
            process.exit(1)
          }
        }

        // 对于本地服务器容器，加载存储的凭据用于认证
        if (!remoteQueryOptions && !isFileBasedEngine(engineName)) {
          const defaultUsername = getDefaultUsername(engineName)
          const creds = await loadCredentials(
            containerName,
            engineName,
            defaultUsername,
          )
          if (creds) {
            remoteQueryOptions = {
              password: creds.apiKey || creds.password,
              username: creds.username,
            }
          }
        }

        const engine = getEngine(engineName)

        let missingDeps = await getMissingDependencies(engineName)
        if (missingDeps.length > 0) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
              }),
            )
            process.exit(1)
          }

          console.log(
            uiWarning(
              `缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
            ),
          )

          // 安装所有缺失的依赖
          for (const dep of missingDeps) {
            const installed = await promptInstallDependencies(
              dep.binary,
              engineName,
            )

            if (!installed) {
              process.exit(1)
            }
          }

          missingDeps = await getMissingDependencies(engineName)
          if (missingDeps.length > 0) {
            console.error(
              uiError(
                `仍然缺失工具：${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ 所有必需工具现已可用'))
          console.log()
        }

        const database = options.database || config.database

        // 执行查询
        const result = await engine.executeQuery(config, query, {
          database,
          namespace: options.namespace,
          ...remoteQueryOptions,
        })

        // 输出结果
        if (options.json) {
          // JSON 模式：输出完整的结果对象
          const output: Record<string, unknown> = {
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
          }
          if (result.commandTag) {
            output.commandTag = result.commandTag
          }
          if (result.executionTimeMs !== undefined) {
            output.executionTimeMs = result.executionTimeMs
          }
          console.log(JSON.stringify(output, null, 2))
        } else {
          // 表格模式
          console.log(formatTable(result))
        }
      } catch (error) {
        const e = error as Error

        // 工具模式到引擎的映射
        const toolPatternToEngine: Record<string, Engine> = {
          'psql not found': Engine.PostgreSQL,
          'mysql not found': Engine.MySQL,
          'mysql client not found': Engine.MySQL,
          'redis-cli not found': Engine.Redis,
          'mongosh not found': Engine.MongoDB,
          'sqlite3 not found': Engine.SQLite,
        }

        const matchingPattern = Object.keys(toolPatternToEngine).find((p) =>
          e.message.toLowerCase().includes(p.toLowerCase()),
        )

        if (matchingPattern && !options.json) {
          const missingTool = matchingPattern
            .replace(' not found', '')
            .replace(' client', '')
          const toolEngine = toolPatternToEngine[matchingPattern]
          const installed = await promptInstallDependencies(
            missingTool,
            toolEngine,
          )
          if (installed) {
            console.log(
              chalk.yellow('  请重新运行命令以继续。'),
            )
          }
          process.exit(1)
        }

        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
