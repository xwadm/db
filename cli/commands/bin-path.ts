/**
 * 二进制路径命令
 *
 * 解析引擎二进制工具的绝对路径。
 * 专为脚本设计 — 仅输出路径，便于在 $() 中替换使用。
 *
 * 注意：工具解析是全局的，不限定版本。如果安装了引擎的多个版本，
 * 返回的路径是最近注册的版本（通常是最新下载的）。
 * 多个引擎共享的工具（例如 mongosh 同时用于 MongoDB 和 FerretDB）
 * 无论指定哪个引擎，都会解析到同一个二进制文件。
 *
 * 用法：
 *   spindb bin-path postgresql                   # 默认工具 (psql)
 *   spindb bin-path postgresql --tool pg_dump     # 指定工具
 *   spindb bin-path redis --tool redis-server     # 服务器二进制
 *   spindb bin-path postgresql --json             # 用于脚本的 JSON 输出
 */

import { Command } from 'commander'
import { Engine, ALL_ENGINES } from '../../types'
import { getEngineConfig } from '../../config/engines-registry'
import { findBinary } from '../../core/dependency-manager'
import { configManager } from '../../core/config-manager'
import { uiError } from '../ui/theme'

// 引擎别名映射，支持简写
const ENGINE_ALIASES: Record<string, Engine> = {
  pg: Engine.PostgreSQL,
  postgres: Engine.PostgreSQL,
  mysql: Engine.MySQL,
  maria: Engine.MariaDB,
  mongo: Engine.MongoDB,
  cockroach: Engine.CockroachDB,
  crdb: Engine.CockroachDB,
  surreal: Engine.SurrealDB,
  ferret: Engine.FerretDB,
  quest: Engine.QuestDB,
  meili: Engine.Meilisearch,
  couch: Engine.CouchDB,
  influx: Engine.InfluxDB,
  weav: Engine.Weaviate,
  tb: Engine.TigerBeetle,
  lsql: Engine.LibSQL,
}

// 将输入解析为标准引擎名称
function resolveEngine(input: string): Engine | null {
  const normalized = input.toLowerCase()
  const values = Object.values(Engine) as string[]
  if (values.includes(normalized)) {
    return normalized as Engine
  }
  return ENGINE_ALIASES[normalized] ?? null
}

// 统一错误输出并退出进程
function exitWithError(msg: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: msg }, null, 2))
  } else {
    console.error(uiError(msg))
  }
  process.exit(1)
}

export const binPathCommand = new Command('bin-path')
  .description('输出引擎二进制文件的绝对路径')
  .argument('<engine>', '引擎名称（如 postgresql、redis、mongodb）')
  .option('-t, --tool <tool>', '指定二进制工具（默认为第一个客户端工具）')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      engineInput: string,
      options: {
        tool?: string
        json?: boolean
      },
    ) => {
      try {
        const engine = resolveEngine(engineInput)
        if (!engine) {
          const validEngines = ALL_ENGINES.join(', ')
          exitWithError(
            `未知的引擎 "${engineInput}"，有效的引擎包括：${validEngines}`,
            options.json,
          )
        }

        const engineConfig = await getEngineConfig(engine)
        const toolName = options.tool ?? engineConfig.clientTools[0]

        if (!toolName) {
          exitWithError(
            `引擎 "${engine}" 没有注册的客户端工具。该引擎使用 REST API，请改用 spindb connect。`,
            options.json,
          )
        }

        // 验证请求的工具是否属于该引擎
        if (options.tool && !engineConfig.clientTools.includes(options.tool)) {
          const validTools = engineConfig.clientTools.join(', ')
          exitWithError(
            `工具 "${options.tool}" 不是 ${engine} 的已知工具。可用工具：${validTools}`,
            options.json,
          )
        }

        // 在查找前确保已注册打包的二进制文件
        await configManager.scanInstalledBinaries()

        const result = await findBinary(toolName)

        if (!result) {
          exitWithError(
            `未找到 ${toolName}，请运行：spindb engines download ${engine}`,
            options.json,
          )
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                engine,
                tool: toolName,
                path: result.path,
                version: result.version ?? null,
              },
              null,
              2,
            ),
          )
          return
        }

        // 纯文本输出：仅输出路径（便于在 $() 中替换）
        process.stdout.write(result.path)
        if (process.stdout.isTTY) {
          console.log()
        }
      } catch (error) {
        const e = error as Error
        exitWithError(e.message, options.json)
      }
    },
  )
