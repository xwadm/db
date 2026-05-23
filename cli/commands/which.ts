/**
 * Which 命令
 *
 * 根据端口号或连接 URL 查找 SpinDB 容器。
 * 适用于需要查找匹配 DATABASE_URL 或端口的容器的脚本场景。
 *
 * 用法：
 *   spindb which --port 5432           # 查找端口 5432 上的容器
 *   spindb which --url "$DATABASE_URL" # 查找匹配 URL 的容器
 *   spindb which --port 5432 --json    # JSON 格式输出用于脚本
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { uiError } from '../ui/theme'
import { Engine, type ContainerConfig } from '../../types'

export type WhichSelectCriteria = {
  targetPort?: number
  targetEngine?: Engine
  targetDatabase?: string
  runningOnly?: boolean
}

/**
 * 根据条件选择最佳匹配的容器。
 *
 * 多个容器可能合法地共享一个端口（例如，一个运行中，其他是早期实验的已停止容器）。
 * 优先选择运行中的容器，如果调用者传递了数据库名称，优先选择实际托管该数据库的容器。
 * 稳定排序 — 得分相同的容器保持原始顺序。
 */
export function selectContainerForWhich(
  containers: ContainerConfig[],
  criteria: WhichSelectCriteria,
): ContainerConfig | null {
  const { targetPort, targetEngine, targetDatabase, runningOnly } = criteria

  const candidates = containers.filter((c) => {
    if (targetPort !== undefined && c.port !== targetPort) return false
    if (targetEngine && c.engine !== targetEngine) return false
    if (runningOnly && c.status !== 'running') return false
    return true
  })

  function score(c: ContainerConfig): number {
    let s = 0
    if (c.status === 'running') s += 4
    if (targetDatabase) {
      const hostsTarget =
        c.database === targetDatabase ||
        (c.databases?.includes(targetDatabase) ?? false)
      if (hostsTarget) s += 2
    }
    return s
  }

  // 装饰-排序-去装饰以保持排序稳定
  const ranked = candidates
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)

  return ranked[0]?.c ?? null
}

/**
 * 解析数据库连接 URL 并提取主机、端口和引擎类型。
 * 对于无效 URL 或无法推断默认端口的不支持协议返回 null。
 */
function parseConnectionUrl(url: string): {
  host: string
  port: number
  database?: string
  engine?: Engine
  unsupportedProtocol?: string
} | null {
  try {
    const parsed = new URL(url)
    const database = parsed.pathname.replace(/^\//, '').split('?')[0] || undefined

    // 如果 URL 有明确的端口，使用它
    if (parsed.port) {
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10),
        database,
        engine: getEngineFromProtocol(parsed.protocol),
      }
    }

    // 没有明确端口 - 需要识别协议以推断默认端口
    const defaultPort = getDefaultPort(parsed.protocol)
    if (defaultPort === undefined) {
      // 返回标志表示不支持的协议
      return {
        host: parsed.hostname,
        port: 0, // 将被调用者捕获
        database,
        unsupportedProtocol: parsed.protocol.replace(/:$/, ''),
      }
    }

    return {
      host: parsed.hostname,
      port: defaultPort,
      database,
      engine: getEngineFromProtocol(parsed.protocol),
    }
  } catch {
    return null
  }
}

/**
 * 获取数据库协议的默认端口。
 * 对于无法识别的协议返回 undefined。
 */
function getDefaultPort(protocol: string): number | undefined {
  const defaults: Record<string, number> = {
    'postgresql:': 5432,
    'postgres:': 5432,
    'mysql:': 3306,
    'mongodb:': 27017,
    'redis:': 6379,
  }
  return defaults[protocol]
}

/**
 * 从 URL 协议获取引擎类型
 */
function getEngineFromProtocol(protocol: string): Engine | undefined {
  const mapping: Record<string, Engine> = {
    'postgresql:': Engine.PostgreSQL,
    'postgres:': Engine.PostgreSQL,
    'mysql:': Engine.MySQL,
    'mongodb:': Engine.MongoDB,
    'redis:': Engine.Redis,
  }
  return mapping[protocol]
}

export const whichCommand = new Command('which')
  .description('根据端口或连接 URL 查找容器')
  .option('-p, --port <port>', '根据端口号查找容器')
  .option('-u, --url <url>', '根据连接 URL 查找容器')
  .option(
    '-e, --engine <engine>',
    '按引擎类型筛选（postgresql, mysql 等）',
  )
  .option('-r, --running', '仅匹配运行中的容器')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (options: {
      port?: string
      url?: string
      engine?: string
      running?: boolean
      json?: boolean
    }) => {
      try {
        // 必须指定 --port 或 --url
        if (!options.port && !options.url) {
          const errorMsg = '必须指定 --port 或 --url'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
            console.log(chalk.dim('  用法：spindb which --port 5432'))
            console.log(
              chalk.dim('         spindb which --url "$DATABASE_URL"'),
            )
          }
          process.exit(1)
        }

        // 解析端口/URL 以确定查找目标
        let targetPort: number | undefined
        let targetEngine: Engine | undefined
        let targetDatabase: string | undefined

        if (options.url) {
          const parsed = parseConnectionUrl(options.url)
          if (!parsed) {
            const errorMsg = `无效的连接 URL：${options.url}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          // 检查不支持的协议
          if (parsed.unsupportedProtocol) {
            const errorMsg = `不支持的协议 "${parsed.unsupportedProtocol}"。支持：postgresql, mysql, mongodb, redis（或明确指定端口）`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          // 仅匹配 localhost URL
          if (parsed.host !== 'localhost' && parsed.host !== '127.0.0.1') {
            const errorMsg = `URL 必须指向 localhost，当前为：${parsed.host}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          targetPort = parsed.port
          targetEngine = parsed.engine
          targetDatabase = parsed.database
        } else if (options.port) {
          targetPort = parseInt(options.port, 10)
          if (isNaN(targetPort)) {
            const errorMsg = `无效的端口号：${options.port}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // 如果明确指定，覆盖引擎
        if (options.engine) {
          const engineLower = options.engine.toLowerCase()
          const engineMap: Record<string, Engine> = {
            postgresql: Engine.PostgreSQL,
            postgres: Engine.PostgreSQL,
            pg: Engine.PostgreSQL,
            mysql: Engine.MySQL,
            mariadb: Engine.MariaDB,
            mongodb: Engine.MongoDB,
            mongo: Engine.MongoDB,
            redis: Engine.Redis,
            valkey: Engine.Valkey,
            clickhouse: Engine.ClickHouse,
            qdrant: Engine.Qdrant,
            meilisearch: Engine.Meilisearch,
            couchdb: Engine.CouchDB,
            cockroachdb: Engine.CockroachDB,
            crdb: Engine.CockroachDB,
            surrealdb: Engine.SurrealDB,
            surreal: Engine.SurrealDB,
            questdb: Engine.QuestDB,
            quest: Engine.QuestDB,
            ferretdb: Engine.FerretDB,
            ferret: Engine.FerretDB,
          }
          targetEngine = engineMap[engineLower]
          if (!targetEngine) {
            const validEngines = [
              ...new Set(Object.keys(engineMap).sort()),
            ].join(', ')
            const errorMsg = `无效的引擎 "${options.engine}"。有效选项：${validEngines}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const containers = await containerManager.list()
        const match = selectContainerForWhich(containers, {
          targetPort,
          targetEngine,
          targetDatabase,
          runningOnly: options.running,
        })

        if (!match) {
          const criteria: string[] = []
          if (targetPort) criteria.push(`端口 ${targetPort}`)
          if (targetEngine) criteria.push(`引擎 ${targetEngine}`)
          if (options.running) criteria.push('运行中')

          const errorMsg = `未找到匹配条件的容器：${criteria.join('，')}`
          if (options.json) {
            console.log(
              JSON.stringify({ error: errorMsg, found: false }, null, 2),
            )
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // 输出结果
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                found: true,
                name: match.name,
                engine: match.engine,
                version: match.version,
                port: match.port,
                status: match.status,
                database: match.database,
              },
              null,
              2,
            ),
          )
        } else {
          // 简单输出：仅容器名称（适用于 $() 替换）
          console.log(match.name)
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
