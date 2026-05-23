import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getPgwebStatus } from '../../core/pgweb-utils'
import { uiError, uiInfo } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine, type ContainerConfig } from '../../types'
import { loadEnginesJson } from '../../config/engines-registry'

/**
 * 获取辅助端口
 * 根据引擎类型返回额外的端口信息
 */
function getSecondaryPorts(
  config: ContainerConfig,
): Array<{ port: number; label: string }> {
  const ports: Array<{ port: number; label: string }> = []
  switch (config.engine) {
    case 'cockroachdb':
      ports.push({ port: config.port + 1, label: 'HTTP UI' })
      break
    case 'clickhouse':
      ports.push({ port: config.port + 1, label: 'HTTP' })
      break
    case 'qdrant':
      ports.push({ port: config.port + 1, label: 'gRPC' })
      break
    case 'typedb':
      ports.push({ port: config.port + 6271, label: 'HTTP' })
      break
    case 'questdb':
      ports.push({ port: config.port + 188, label: 'HTTP 控制台' })
      ports.push({ port: config.port + 197, label: 'ILP' })
      break
    case 'ferretdb':
      if (config.backendPort) {
        ports.push({ port: config.backendPort, label: 'PostgreSQL 后端' })
      }
      break
  }
  return ports
}

export type PortEntry = { port: number; label: string }

/**
 * 获取容器端口信息
 */
export async function getContainerPorts(config: ContainerConfig): Promise<{
  status: 'running' | 'stopped' | 'available' | 'missing'
  ports: PortEntry[]
}> {
  const isFileBasedDB =
    config.engine === Engine.SQLite || config.engine === Engine.DuckDB

  if (isFileBasedDB) {
    const fileExists = existsSync(config.database)
    return {
      status: fileExists ? 'available' : 'missing',
      ports: [],
    }
  }

  const isRunning = await processManager.isRunning(config.name, {
    engine: config.engine,
  })

  const enginesJson = await loadEnginesJson()
  const engineConfig = enginesJson.engines[config.engine]
  const displayName = engineConfig?.displayName || config.engine

  const ports: PortEntry[] = [{ port: config.port, label: displayName }]

  // 添加辅助端口
  ports.push(...getSecondaryPorts(config))

  // 检查 pgweb（仅 PG-wire-protocol 引擎）
  if (
    config.engine === 'postgresql' ||
    config.engine === 'cockroachdb' ||
    config.engine === 'ferretdb'
  ) {
    const pgweb = await getPgwebStatus(config.name, config.engine)
    if (pgweb.running && pgweb.port) {
      ports.push({ port: pgweb.port, label: 'pgweb' })
    }
  }

  return {
    status: isRunning ? 'running' : 'stopped',
    ports,
  }
}

export const portsCommand = new Command('ports')
  .description('显示容器使用的端口')
  .argument('[name]', '容器名称（省略则显示全部）')
  .option('--json', '以 JSON 格式输出')
  .option('--running', '仅显示运行中的容器')
  .action(
    async (
      name: string | undefined,
      options: { json?: boolean; running?: boolean },
    ) => {
      try {
        let containers: ContainerConfig[]

        if (name) {
          const config = await containerManager.getConfig(name)
          if (!config) {
            if (options.json) {
              console.log(
                JSON.stringify({ error: `未找到容器 "${name}"` }),
              )
            } else {
              console.error(uiError(`未找到容器 "${name}"`))
            }
            process.exit(1)
          }
          containers = [config]
        } else {
          containers = await containerManager.list()
        }

        // 收集所有容器的端口信息
        const results = await Promise.all(
          containers.map(async (config) => {
            const { status, ports } = await getContainerPorts(config)
            return { config, status, ports }
          }),
        )

        // 如果请求，筛选为仅运行中的容器
        const filtered = options.running
          ? results.filter((r) => r.status === 'running')
          : results

        if (options.json) {
          const jsonOutput = filtered.map((r) => ({
            name: r.config.name,
            engine: r.config.engine,
            status: r.status,
            ports: r.ports,
          }))
          console.log(JSON.stringify(jsonOutput, null, 2))
          return
        }

        if (filtered.length === 0) {
          console.log(
            uiInfo(
              options.running
                ? '未找到运行中的容器。'
                : '未找到容器。请使用以下命令创建：spindb create',
            ),
          )
          return
        }

        console.log()
        console.log(
          chalk.gray('  ') +
            chalk.bold.white('名称'.padEnd(22)) +
            chalk.bold.white('引擎'.padEnd(18)) +
            chalk.bold.white('状态'.padEnd(12)) +
            chalk.bold.white('端口'),
        )
        console.log(chalk.gray('  ' + '─'.repeat(78)))

        for (const { config, status, ports } of filtered) {
          const engineIcon = getEngineIcon(config.engine)
          const engineName = config.engine.padEnd(13)

          const statusDisplay =
            status === 'running'
              ? chalk.green('● 运行中'.padEnd(12))
              : status === 'available'
                ? chalk.blue('● 可用'.padEnd(12))
                : status === 'missing'
                  ? chalk.gray('○ 缺失'.padEnd(12))
                  : chalk.gray('○ 已停止'.padEnd(12))

          let portDisplay: string
          if (ports.length === 0) {
            portDisplay = chalk.gray('—')
          } else {
            const parts = ports.map((p, i) =>
              i === 0
                ? String(p.port)
                : `${p.port} ${chalk.gray(`(${p.label})`)}`,
            )
            portDisplay = parts.join(chalk.gray(', '))
          }

          console.log(
            chalk.gray('  ') +
              chalk.cyan(config.name.padEnd(22)) +
              engineIcon +
              chalk.white(engineName) +
              statusDisplay +
              portDisplay,
          )
        }

        console.log()
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
