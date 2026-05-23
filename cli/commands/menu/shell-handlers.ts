import chalk from 'chalk'
import inquirer from 'inquirer'
import { spawn } from 'child_process'
import { escapeablePrompt } from '../../ui/prompts'
import { getPageSize } from '../../constants'
import { existsSync } from 'fs'
import { chmod, mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname, resolve, sep } from 'path'
import { containerManager } from '../../../core/container-manager'
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
} from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { configManager } from '../../../core/config-manager'
import {
  getPgwebStatus,
  stopPgweb,
  PGWEB_VERSION,
} from '../../../core/pgweb-utils'
import {
  DBLAB_ENGINES,
  DBLAB_VERSION,
  getDblabArgs,
  getDblabPlatformSuffix,
} from '../../../core/dblab-utils'
import { getEngine } from '../../../engines'
import { isRemoteContainer } from '../../../types'
import { loadCredentials } from '../../../core/credential-manager'
import {
  redactConnectionString,
  parseConnectionString,
} from '../../../core/remote-container'
import { createSpinner } from '../../ui/spinner'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { logDebug } from '../../../core/error-handler'
import { pressEnterToContinue } from './shared'
import { paths } from '../../../config/paths'
import { getEngineConfig } from '../../../config/engines-registry'
import { getConsoleBaseArgs } from '../../../engines/typedb/cli-utils'

/**
 * 在系统默认浏览器中打开 URL
 */
function openInBrowser(url: string): void {
  const platform = process.platform
  let cmd: string
  let args: string[]

  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    // Linux 及其他
    cmd = 'xdg-open'
    args = [url]
  }

  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}

export async function handleCopyConnectionString(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)

  // 远程容器：使用存储的连接字符串（从凭据中获取完整字符串）
  let connectionString: string
  let displayString: string
  if (isRemoteContainer(config)) {
    const creds = await loadCredentials(config.name, config.engine, 'remote')
    connectionString =
      creds?.connectionString ?? config.remote?.connectionString ?? ''
    displayString = redactConnectionString(connectionString)
  } else {
    connectionString = engine.getConnectionString(config, database)
    displayString = connectionString
  }

  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(uiSuccess('连接字符串已复制到剪贴板'))
    console.log(chalk.gray(`  ${displayString}`))
  } else {
    console.log(uiWarning('无法复制到剪贴板。连接字符串：'))
    console.log(chalk.cyan(`  ${displayString}`))
  }
  console.log()

  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('按 Enter 键继续...'),
    },
  ])
}

export async function handleOpenShell(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)
  const isRemote = isRemoteContainer(config)
  // 使用提供的数据库名或回退到容器默认数据库
  const activeDatabase = database || config.database

  // 对于远程容器，使用存储的远程连接字符串
  let connectionString: string
  if (isRemote) {
    const creds = await loadCredentials(config.name, config.engine, 'remote')
    connectionString =
      creds?.connectionString ?? config.remote?.connectionString ?? ''
  } else {
    connectionString = engine.getConnectionString(config, activeDatabase)
  }

  const shellCheckSpinner = createSpinner('正在检查可用的 Shell...')
  shellCheckSpinner.start()

  const [
    usqlInstalled,
    pgcliInstalled,
    mycliInstalled,
    litecliInstalled,
    iredisInstalled,
  ] = await Promise.all([
    isUsqlInstalled(),
    isPgcliInstalled(),
    isMycliInstalled(),
    isLitecliInstalled(),
    isIredisInstalled(),
  ])

  shellCheckSpinner.stop()
  // 清除 spinner 行
  process.stdout.write('\x1b[1A\x1b[2K')

  // 远程 REST API 引擎无法通过控制台使用
  if (
    isRemote &&
    [
      'qdrant',
      'meilisearch',
      'influxdb',
      'weaviate',
      'couchdb',
      'libsql',
    ].includes(config.engine)
  ) {
    console.log()
    console.log(uiInfo('链接的远程 REST API 数据库不支持此控制台功能。'))
    console.log(chalk.gray('  请直接使用服务商提供的 Web 仪表盘或 API 工具。'))
    console.log()
    await pressEnterToContinue()
    return
  }

  type ShellChoice =
    | 'default'
    | 'browser'
    | 'api-info'
    | 'install-webui'
    | 'pgweb'
    | 'install-pgweb'
    | 'stop-pgweb'
    | 'dblab'
    | 'install-dblab'
    | 'duckdb-ui'
    | 'usql'
    | 'install-usql'
    | 'pgcli'
    | 'install-pgcli'
    | 'mycli'
    | 'install-mycli'
    | 'litecli'
    | 'install-litecli'
    | 'iredis'
    | 'install-iredis'
    | 'back'

  // 各引擎对应的 Shell 名称
  let defaultShellName: string
  let engineSpecificCli: string | null
  let engineSpecificInstalled: boolean
  let engineSpecificValue: ShellChoice | null
  let engineSpecificInstallValue: ShellChoice | null

  if (config.engine === 'sqlite') {
    defaultShellName = 'sqlite3'
    engineSpecificCli = 'litecli'
    engineSpecificInstalled = litecliInstalled
    engineSpecificValue = 'litecli'
    engineSpecificInstallValue = 'install-litecli'
  } else if (config.engine === 'duckdb') {
    defaultShellName = 'duckdb'
    // DuckDB 没有单独的增强型 CLI 工具
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'mysql') {
    defaultShellName = 'mysql'
    engineSpecificCli = 'mycli'
    engineSpecificInstalled = mycliInstalled
    engineSpecificValue = 'mycli'
    engineSpecificInstallValue = 'install-mycli'
  } else if (config.engine === 'mariadb') {
    defaultShellName = 'mariadb'
    engineSpecificCli = 'mycli'
    engineSpecificInstalled = mycliInstalled
    engineSpecificValue = 'mycli'
    engineSpecificInstallValue = 'install-mycli'
  } else if (config.engine === 'mongodb' || config.engine === 'ferretdb') {
    defaultShellName = 'mongosh'
    // mongosh 就是 MongoDB/FerretDB 的增强 Shell（无独立的增强 CLI 如 pgcli/mycli）
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'redis') {
    defaultShellName = 'redis-cli'
    engineSpecificCli = 'iredis'
    engineSpecificInstalled = iredisInstalled
    engineSpecificValue = 'iredis'
    engineSpecificInstallValue = 'install-iredis'
  } else if (config.engine === 'valkey') {
    defaultShellName = 'valkey-cli'
    engineSpecificCli = 'iredis' // iredis 协议兼容 Valkey
    engineSpecificInstalled = iredisInstalled
    engineSpecificValue = 'iredis'
    engineSpecificInstallValue = 'install-iredis'
  } else if (config.engine === 'clickhouse') {
    defaultShellName = 'clickhouse client'
    // ClickHouse 客户端已捆绑，无独立增强 CLI
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'qdrant') {
    // Qdrant 使用 REST API，在浏览器中打开仪表盘
    defaultShellName = 'Web 仪表盘'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'meilisearch') {
    // Meilisearch 使用 REST API，在浏览器中打开仪表盘
    defaultShellName = 'Web 仪表盘'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'influxdb') {
    // InfluxDB 使用 influxdb3 query 子命令（与服务器同一二进制文件）
    defaultShellName = 'influxdb3 query'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'weaviate') {
    // Weaviate 使用 REST API，在浏览器中打开 Web 仪表盘
    defaultShellName = 'REST API'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'couchdb') {
    // CouchDB 使用 REST API，在浏览器中打开 Fauxton 仪表盘
    defaultShellName = 'Fauxton 仪表盘'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'libsql') {
    // libSQL 使用 REST API (Hrana 协议)，无 CLI Shell
    defaultShellName = 'REST API'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'surrealdb') {
    // SurrealDB 使用 surreal sql 命令
    defaultShellName = 'surreal sql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'questdb') {
    // QuestDB 使用 PostgreSQL 有线协议，可用 psql 或 Web 控制台
    // 注意：不建议为 QuestDB 推荐 pgcli，因为 pgcli 使用了 QuestDB 不支持的 PostgreSQL 函数如 unnest()，会导致自动补全错误
    defaultShellName = 'psql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'cockroachdb') {
    // CockroachDB 使用 cockroach sql 命令
    defaultShellName = 'cockroach sql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'typedb') {
    // TypeDB 使用 typedb console
    defaultShellName = 'typedb console'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'tigerbeetle') {
    // TigerBeetle 使用 tigerbeetle repl 命令
    defaultShellName = 'tigerbeetle repl'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else {
    defaultShellName = 'psql'
    engineSpecificCli = 'pgcli'
    engineSpecificInstalled = pgcliInstalled
    engineSpecificValue = 'pgcli'
    engineSpecificInstallValue = 'install-pgcli'
  }

  // 检查 Qdrant Web UI 是否已安装（通过验证实际 Web UI 文件是否存在，而不仅仅是空的 static 目录）
  let qdrantWebUiInstalled = false
  if (config.engine === 'qdrant') {
    const containerDir = paths.getContainerPath(config.name, {
      engine: 'qdrant',
    })
    const staticDir = join(containerDir, 'static')
    // 检查 index.html，它在有效的 Web UI 安装中始终存在
    qdrantWebUiInstalled = existsSync(join(staticDir, 'index.html'))
  }

  const choices: Array<
    { name: string; value: ShellChoice } | inquirer.Separator
  > = []

  // 对于 Qdrant：根据安装状态显示“打开 Web UI”或“下载 Web UI”
  if (config.engine === 'qdrant') {
    if (qdrantWebUiInstalled) {
      choices.push({
        name: `◎ 在浏览器中打开 Web UI`,
        value: 'default',
      })
    } else {
      choices.push({
        name: `↓ 下载 Web UI（启用仪表盘）`,
        value: 'install-webui',
      })
    }
    // 始终显示 API 信息选项
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else if (config.engine === 'meilisearch') {
    // Meilisearch：仪表盘内置于根 URL
    choices.push({
      name: `◎ 在浏览器中打开仪表盘`,
      value: 'default',
    })
    // 始终显示 API 信息选项
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else if (config.engine === 'influxdb') {
    // InfluxDB：influxdb3 query CLI + API 信息
    choices.push({
      name: `▸ 使用默认 Shell（influxdb3 query）`,
      value: 'default',
    })
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else if (config.engine === 'weaviate') {
    // Weaviate：REST API 仪表盘 + API 信息
    choices.push({
      name: `◎ 在浏览器中打开仪表盘`,
      value: 'default',
    })
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else if (config.engine === 'couchdb') {
    // CouchDB：Fauxton 仪表盘内置于 /_utils
    choices.push({
      name: `◎ 在浏览器中打开 Fauxton 仪表盘`,
      value: 'default',
    })
    // 始终显示 API 信息选项
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else if (config.engine === 'libsql') {
    // libSQL：仅 REST API，显示 API 信息
    choices.push({
      name: `ℹ 显示 API 信息`,
      value: 'api-info',
    })
  } else {
    // 非 REST API 引擎：显示默认 Shell 选项
    choices.push({
      name: `▸ 使用默认 Shell（${defaultShellName}）`,
      value: 'default',
    })
  }

  // 仅当存在引擎特定 CLI 时才显示（MongoDB 的 mongosh 即为默认，无需额外显示）
  if (engineSpecificCli !== null) {
    if (engineSpecificInstalled) {
      choices.push({
        name: `★ 使用 ${engineSpecificCli}（增强功能，推荐）`,
        value: engineSpecificValue!,
      })
    } else {
      choices.push({
        name: `↓ 安装 ${engineSpecificCli}（增强功能，推荐）`,
        value: engineSpecificInstallValue!,
      })
    }
  }

  // usql 支持 SQL 数据库 - 对非 SQL 引擎跳过
  const engineConfig = await getEngineConfig(config.engine)
  if (engineConfig.queryLanguage === 'sql') {
    if (usqlInstalled) {
      choices.push({
        name: '★ 使用 usql（通用 SQL 客户端）',
        value: 'usql',
      })
    } else {
      choices.push({
        name: '↓ 安装 usql（通用 SQL 客户端）',
        value: 'install-usql',
      })
    }
  }

  // dblab 可视化 TUI（支持 PostgreSQL、MySQL、MariaDB、CockroachDB、SQLite、QuestDB）
  // 对远程容器不可用（硬编码本地连接）
  if (DBLAB_ENGINES.has(config.engine) && !isRemote) {
    const dblabPath = await configManager.getBinaryPath('dblab')
    if (dblabPath) {
      choices.push({
        name: '★ 使用 dblab（可视化 TUI）',
        value: 'dblab',
      })
    } else {
      choices.push({
        name: '↓ 下载 dblab（可视化 TUI）',
        value: 'install-dblab',
      })
    }
  }

  // 针对支持浏览器 UI 的引擎（仅限本地）
  if (config.engine === 'clickhouse' && !isRemote) {
    const httpPort = config.port + 1
    choices.push(new inquirer.Separator(chalk.gray(`───── Web 面板 ─────`)))
    choices.push({
      name: `◎ 打开 Play UI（端口 ${httpPort}）`,
      value: 'browser',
    })
  }

  if (config.engine === 'questdb' && !isRemote) {
    const httpPort = config.port + 188
    choices.push(new inquirer.Separator(chalk.gray(`───── Web 面板 ─────`)))
    choices.push({
      name: `◎ 打开 Web 控制台（端口 ${httpPort}）`,
      value: 'browser',
    })
  }

  if (config.engine === 'duckdb' && !isRemote) {
    choices.push(new inquirer.Separator(chalk.gray(`───── Web 面板 ─────`)))
    choices.push({
      name: `◎ 打开 Web UI（内建，端口 4213）`,
      value: 'duckdb-ui',
    })
  }

  if (
    !isRemote &&
    (config.engine === 'postgresql' ||
      config.engine === 'cockroachdb' ||
      config.engine === 'ferretdb')
  ) {
    choices.push(new inquirer.Separator(chalk.gray(`───── Web 面板 ─────`)))
    const pgwebPath = await configManager.getBinaryPath('pgweb')
    if (pgwebPath) {
      const pgwebStatus = await getPgwebStatus(containerName, config.engine)
      if (pgwebStatus.running) {
        choices.push({
          name: `◎ 打开 pgweb（端口 ${pgwebStatus.port}）`,
          value: 'pgweb',
        })
        choices.push({
          name: `■ 停止 pgweb`,
          value: 'stop-pgweb',
        })
      } else {
        choices.push({
          name: `◎ 打开 pgweb`,
          value: 'pgweb',
        })
      }
    } else {
      choices.push({
        name: `↓ 下载 pgweb`,
        value: 'install-pgweb',
      })
    }
  }

  choices.push(new inquirer.Separator())
  choices.push({
    name: `${chalk.blue('←')} 返回`,
    value: 'back',
  })

  const { shellChoice } = await escapeablePrompt<{ shellChoice: ShellChoice }>([
    {
      type: 'list',
      name: 'shellChoice',
      message: '选择控制台选项：',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (shellChoice === 'back') {
    return
  }

  // 处理 ClickHouse Play UI 的浏览器选项
  if (shellChoice === 'browser') {
    if (config.engine === 'clickhouse') {
      // ClickHouse HTTP 端口为原生端口 +1（例如 9000 -> 9001）
      const httpPort = config.port + 1
      const playUrl = `http://127.0.0.1:${httpPort}/play`
      console.log()
      console.log(uiInfo(`正在浏览器中打开 ClickHouse Play UI...`))
      console.log(chalk.gray(`  ${playUrl}`))
      console.log()
      openInBrowser(playUrl)
      await pressEnterToContinue()
    } else if (config.engine === 'questdb') {
      // QuestDB Web 控制台在 HTTP 端口（PG 端口 +188）
      const httpPort = config.port + 188
      const consoleUrl = `http://127.0.0.1:${httpPort}`
      console.log()
      console.log(uiInfo(`正在浏览器中打开 QuestDB Web 控制台...`))
      console.log(chalk.gray(`  ${consoleUrl}`))
      console.log()
      openInBrowser(consoleUrl)
      await pressEnterToContinue()
    }
    return
  }

  // 处理 DuckDB 内建 Web UI（duckdb -ui）
  if (shellChoice === 'duckdb-ui') {
    const duckdbPath = await configManager.getBinaryPath('duckdb')
    if (!duckdbPath) {
      console.error(
        uiError(
          '未找到 DuckDB 二进制文件。请使用以下命令下载：spindb engines download duckdb',
        ),
      )
      await pressEnterToContinue()
      return
    }

    console.log()
    console.log(uiInfo('正在启动 DuckDB Web UI...'))
    console.log(chalk.gray('  http://localhost:4213'))
    console.log()

    const uiProcess = spawn(duckdbPath, [config.database, '-ui'], {
      stdio: 'inherit',
    })

    await new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      uiProcess.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.log(uiWarning('未找到 DuckDB 二进制文件。'))
        } else {
          console.log(uiError(`启动 DuckDB UI 失败：${err.message}`))
        }
        settle()
      })

      uiProcess.on('close', () => {
        if (process.stdout.isTTY) {
          process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        }
        settle()
      })
    })
    return
  }

  // 处理 Qdrant/Meilisearch 的 API 信息显示
  if (shellChoice === 'api-info') {
    console.log()
    if (config.engine === 'qdrant') {
      console.log(chalk.cyan('Qdrant REST API：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log(chalk.white(`  gRPC：127.0.0.1:${config.port + 1}`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(
        chalk.gray(`  curl http://127.0.0.1:${config.port}/collections`),
      )
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/healthz`))
    } else if (config.engine === 'meilisearch') {
      console.log(chalk.cyan('Meilisearch REST API：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/indexes`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/health`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/stats`))
    } else if (config.engine === 'influxdb') {
      console.log(chalk.cyan('InfluxDB REST API：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/health`))
      console.log(
        chalk.gray(
          `  curl -H "Content-Type: application/json" http://127.0.0.1:${config.port}/api/v3/query_sql -d '{"db":"mydb","q":"SELECT 1"}'`,
        ),
      )
    } else if (config.engine === 'weaviate') {
      console.log(chalk.cyan('Weaviate REST API：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log(chalk.white(`  gRPC：127.0.0.1:${config.port + 1}`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(
        chalk.gray(
          `  curl http://127.0.0.1:${config.port}/v1/.well-known/ready`,
        ),
      )
      console.log(
        chalk.gray(`  curl http://127.0.0.1:${config.port}/v1/schema`),
      )
    } else if (config.engine === 'libsql') {
      console.log(chalk.cyan('libSQL REST API（Hrana 协议）：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/health`))
      console.log(
        chalk.gray(
          `  curl -H "Content-Type: application/json" http://127.0.0.1:${config.port}/v2/pipeline -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}'`,
        ),
      )
    } else if (config.engine === 'couchdb') {
      console.log(chalk.cyan('CouchDB REST API：'))
      console.log(chalk.white(`  HTTP：http://127.0.0.1:${config.port}`))
      console.log(
        chalk.white(`  Fauxton：http://127.0.0.1:${config.port}/_utils`),
      )
      console.log()
      console.log(chalk.cyan('凭据：'))
      console.log(chalk.white(`  用户名：admin`))
      console.log(chalk.white(`  密码：admin`))
      console.log()
      console.log(chalk.gray('示例 curl 命令：'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/_all_dbs`))
      console.log(
        chalk.gray(`  curl -X PUT http://127.0.0.1:${config.port}/mydb`),
      )
    }
    console.log()
    await pressEnterToContinue()
    return
  }

  if (shellChoice === 'install-pgcli') {
    console.log()
    console.log(uiInfo('正在安装 pgcli 以获得增强的 PostgreSQL Shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installPgcli(pm)
      if (result.success) {
        console.log(uiSuccess('pgcli 安装成功！'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'pgcli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`安装 pgcli 失败：${result.error}`))
        console.log()
        console.log(chalk.gray('手动安装：'))
        for (const instruction of getPgcliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('未找到支持的包管理器'))
      console.log()
      console.log(chalk.gray('手动安装：'))
      for (const instruction of getPgcliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-mycli') {
    console.log()
    console.log(uiInfo('正在安装 mycli 以获得增强的 MySQL Shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installMycli(pm)
      if (result.success) {
        console.log(uiSuccess('mycli 安装成功！'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'mycli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`安装 mycli 失败：${result.error}`))
        console.log()
        console.log(chalk.gray('手动安装：'))
        for (const instruction of getMycliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('未找到支持的包管理器'))
      console.log()
      console.log(chalk.gray('手动安装：'))
      for (const instruction of getMycliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-usql') {
    console.log()
    console.log(uiInfo('正在安装 usql 以获得增强的 Shell 体验...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installUsql(pm)
      if (result.success) {
        console.log(uiSuccess('usql 安装成功！'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'usql',
          activeDatabase,
        )
      } else {
        console.error(uiError(`安装 usql 失败：${result.error}`))
        console.log()
        console.log(chalk.gray('手动安装：'))
        for (const instruction of getUsqlManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('未找到支持的包管理器'))
      console.log()
      console.log(chalk.gray('手动安装：'))
      for (const instruction of getUsqlManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-litecli') {
    console.log()
    console.log(uiInfo('正在安装 litecli 以获得增强的 SQLite Shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installLitecli(pm)
      if (result.success) {
        console.log(uiSuccess('litecli 安装成功！'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'litecli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`安装 litecli 失败：${result.error}`))
        console.log()
        console.log(chalk.gray('手动安装：'))
        for (const instruction of getLitecliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('未找到支持的包管理器'))
      console.log()
      console.log(chalk.gray('手动安装：'))
      for (const instruction of getLitecliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-iredis') {
    console.log()
    console.log(uiInfo('正在安装 iredis 以获得增强的 Redis Shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installIredis(pm)
      if (result.success) {
        console.log(uiSuccess('iredis 安装成功！'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'iredis',
          activeDatabase,
        )
      } else {
        console.error(uiError(`安装 iredis 失败：${result.error}`))
        console.log()
        console.log(chalk.gray('手动安装：'))
        for (const instruction of getIredisManualInstructions(
          platformService.getPlatformInfo().platform,
        )) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('未找到支持的包管理器'))
      console.log()
      console.log(chalk.gray('手动安装：'))
      for (const instruction of getIredisManualInstructions(
        platformService.getPlatformInfo().platform,
      )) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  // 处理 dblab 下载 → 安装后立即启动
  if (shellChoice === 'install-dblab') {
    const dblabBinaryPath = await downloadDblabCli()
    if (dblabBinaryPath) {
      await launchDblab(config, activeDatabase)
    }
    return
  }

  // 处理 dblab 启动
  if (shellChoice === 'dblab') {
    await launchDblab(config, activeDatabase)
    return
  }

  // 处理 pgweb 下载 → 安装后立即启动
  if (shellChoice === 'install-pgweb') {
    const pgwebBinaryPath = await downloadPgweb()
    if (pgwebBinaryPath) {
      await launchPgweb(containerName, config, activeDatabase)
    }
    return
  }

  // 处理 pgweb 启动
  if (shellChoice === 'pgweb') {
    await launchPgweb(containerName, config, activeDatabase)
    return
  }

  // 处理 pgweb 停止
  if (shellChoice === 'stop-pgweb') {
    await stopPgwebProcess(containerName, config.engine)
    return
  }

  // 处理 Qdrant 的安装 Web UI 选项
  if (shellChoice === 'install-webui') {
    if (config.engine === 'qdrant') {
      await downloadQdrantWebUI(config.name)
    }
    return
  }

  await launchShell(
    containerName,
    config,
    connectionString,
    shellChoice,
    activeDatabase,
  )
}

/**
 * 从 GitHub releases 下载并安装 Qdrant Web UI
 */
async function downloadQdrantWebUI(containerName: string): Promise<void> {
  console.log()
  const spinner = createSpinner('正在下载 Qdrant Web UI...')
  spinner.start()

  try {
    // 获取最新版本信息
    const releaseUrl =
      'https://api.github.com/repos/qdrant/qdrant-web-ui/releases/latest'
    const releaseResponse = await fetch(releaseUrl, {
      headers: { 'User-Agent': 'spindb' },
    })

    if (!releaseResponse.ok) {
      throw new Error(`获取发布信息失败：${releaseResponse.status}`)
    }

    const releaseData = (await releaseResponse.json()) as {
      assets: Array<{ name: string; browser_download_url: string }>
      tag_name: string
    }

    // 查找 dist-qdrant.zip 资源
    const zipAsset = releaseData.assets.find(
      (a) => a.name === 'dist-qdrant.zip',
    )
    if (!zipAsset) {
      throw new Error('未在最新版本中找到 dist-qdrant.zip')
    }

    spinner.text = `正在下载 Qdrant Web UI ${releaseData.tag_name}...`

    // 下载 zip 文件
    const downloadResponse = await fetch(zipAsset.browser_download_url)
    if (!downloadResponse.ok || !downloadResponse.body) {
      throw new Error(`下载失败：${downloadResponse.status}`)
    }

    // 获取容器目录并创建 static 文件夹
    const containerDir = paths.getContainerPath(containerName, {
      engine: 'qdrant',
    })
    const staticDir = join(containerDir, 'static')

    // 如果存在，删除现有 static 目录
    await rm(staticDir, { recursive: true, force: true })
    await mkdir(staticDir, { recursive: true })

    spinner.text = '正在解压 Web UI...'

    // 保存并解压 zip
    const tempZip = join(containerDir, 'webui-temp.zip')
    const buffer = Buffer.from(await downloadResponse.arrayBuffer())
    await writeFile(tempZip, buffer)

    try {
      // 解压 zip - zip 包内包含 'dist' 文件夹，我们需要其内容
      const unzipper = await import('unzipper')
      const directory = await unzipper.Open.file(tempZip)

      // 将 staticDir 解析为绝对路径以防止 zip 路径穿越
      const resolvedStaticDir = resolve(staticDir)

      for (const entry of directory.files) {
        // 跳过目录和不在 dist/ 下的文件
        if (entry.type === 'Directory') continue
        if (!entry.path.startsWith('dist/')) continue

        // 去除 'dist/' 前缀以获取相对路径
        const relativePath = entry.path.replace(/^dist\//, '')
        if (!relativePath) continue

        // 防止 zip 路径穿越：确保解析后的路径在 staticDir 内
        // 使用 path.sep 进行跨平台安全的比较（Windows 下反斜杠，Unix 下正斜杠）
        const targetPath = resolve(staticDir, relativePath)
        if (!targetPath.startsWith(resolvedStaticDir + sep)) {
          // 路径遍历尝试 - 跳过该项
          continue
        }

        const targetDir = dirname(targetPath)
        await mkdir(targetDir, { recursive: true })
        const content = await entry.buffer()
        await writeFile(targetPath, content)
      }
    } finally {
      // 即使解压失败也清理临时 zip
      await rm(tempZip, { force: true })
    }

    spinner.succeed(`Qdrant Web UI ${releaseData.tag_name} 安装完成`)
    console.log()
    console.log(uiWarning('请重启 Qdrant 以使 Web UI 生效：'))
    console.log(
      chalk.gray(
        `  spindb stop ${containerName} && spindb start ${containerName}`,
      ),
    )
    console.log()
  } catch (error) {
    spinner.fail('下载 Qdrant Web UI 失败')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('您可以从以下地址手动下载：'))
    console.log(
      chalk.cyan('  https://github.com/qdrant/qdrant-web-ui/releases'),
    )
    console.log(chalk.gray(`\n将 dist-qdrant.zip 内容解压到：`))
    console.log(
      chalk.cyan(
        `  ${paths.getContainerPath(containerName, { engine: 'qdrant' })}/static/`,
      ),
    )
    console.log()
  }

  await pressEnterToContinue()
}

/**
 * 停止容器正在运行的 pgweb 进程（包含 UI 反馈）
 */
export async function stopPgwebProcess(
  containerName: string,
  engine: string,
): Promise<void> {
  const stopped = await stopPgweb(containerName, engine)

  console.log()
  if (stopped) {
    console.log(uiSuccess('pgweb 已停止'))
  } else {
    console.log(uiInfo('pgweb 未在运行'))
  }
  console.log()
  await pressEnterToContinue()
}

/**
 * 从 GitHub releases 下载并安装 pgweb
 */
async function downloadPgweb(): Promise<string | null> {
  console.log()
  const spinner = createSpinner('正在下载 pgweb...')
  spinner.start()

  try {
    const platform = process.platform
    const arch = process.arch
    let suffix: string

    if (platform === 'darwin' && arch === 'arm64') {
      suffix = 'darwin_arm64'
    } else if (platform === 'darwin' && arch === 'x64') {
      suffix = 'darwin_amd64'
    } else if (platform === 'linux' && arch === 'arm64') {
      suffix = 'linux_arm64'
    } else if (platform === 'linux' && arch === 'x64') {
      suffix = 'linux_amd64'
    } else if (platform === 'win32' && arch === 'x64') {
      suffix = 'windows_amd64.exe'
    } else {
      throw new Error(`不支持的平台：${platform} ${arch}`)
    }

    const zipUrl = `https://github.com/sosedoff/pgweb/releases/download/v${PGWEB_VERSION}/pgweb_${suffix}.zip`

    spinner.text = `正在下载 pgweb v${PGWEB_VERSION}...`

    const response = await fetch(zipUrl)
    if (!response.ok || !response.body) {
      throw new Error(`下载失败：${response.status}`)
    }

    const isWin = platform === 'win32'
    const binaryName = isWin ? 'pgweb.exe' : 'pgweb'
    const platformArch = `${platform}-${arch}`
    const installDir = join(
      paths.bin,
      `pgweb-${PGWEB_VERSION}-${platformArch}`,
      'bin',
    )
    await mkdir(installDir, { recursive: true })

    const tempZip = join(paths.bin, 'pgweb-temp.zip')
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(tempZip, buffer)

    spinner.text = '正在解压 pgweb...'

    try {
      const unzipper = await import('unzipper')
      const directory = await unzipper.Open.file(tempZip)

      const resolvedInstallDir = resolve(installDir)
      let extracted = false

      for (const entry of directory.files) {
        if (entry.type === 'Directory') continue

        // 防止 zip 路径穿越
        const targetPath = resolve(installDir, binaryName)
        if (!targetPath.startsWith(resolvedInstallDir + sep)) {
          continue
        }

        // zip 包含二进制文件（可能命名为 pgweb_<platform>_<arch> 或 pgweb_<platform>_<arch>.exe）
        const content = await entry.buffer()
        await writeFile(targetPath, content)
        extracted = true
        break // zip 中只有一个文件
      }

      if (!extracted) {
        throw new Error('未在 zip 压缩包中找到 pgweb 二进制文件')
      }
    } finally {
      await rm(tempZip, { force: true })
    }

    const binaryPath = join(installDir, binaryName)

    // 在 Unix 系统上赋予执行权限
    if (!isWin) {
      await chmod(binaryPath, 0o755)
    }

    // 在配置中注册
    await configManager.setBinaryPath('pgweb', binaryPath, 'bundled')

    spinner.succeed(`pgweb v${PGWEB_VERSION} 安装完成`)
    console.log()

    return binaryPath
  } catch (error) {
    spinner.fail('下载 pgweb 失败')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('您可以从以下地址手动下载：'))
    console.log(chalk.cyan('  https://github.com/sosedoff/pgweb/releases'))
    console.log()
    await pressEnterToContinue()
    return null
  }
}

/**
 * 从 GitHub releases 下载并安装 dblab。
 * 导出为 downloadDblabCli，供 CLI connect 命令使用。
 */
export async function downloadDblabCli(): Promise<string | null> {
  console.log()
  const spinner = createSpinner('正在下载 dblab...')
  spinner.start()

  try {
    const suffix = getDblabPlatformSuffix()
    const tarUrl = `https://github.com/danvergara/dblab/releases/download/v${DBLAB_VERSION}/dblab_${DBLAB_VERSION}_${suffix}.tar.gz`

    spinner.text = `正在下载 dblab v${DBLAB_VERSION}...`

    const response = await fetch(tarUrl)
    if (!response.ok || !response.body) {
      throw new Error(`下载失败：${response.status}`)
    }

    const isWin = process.platform === 'win32'
    const binaryName = isWin ? 'dblab.exe' : 'dblab'
    const platformArch = `${process.platform}-${process.arch}`
    const installDir = join(
      paths.bin,
      `dblab-${DBLAB_VERSION}-${platformArch}`,
      'bin',
    )
    await mkdir(installDir, { recursive: true })

    const tempTar = join(paths.bin, 'dblab-temp.tar.gz')
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(tempTar, buffer)

    spinner.text = '正在解压 dblab...'

    try {
      const { spawnSync } = await import('child_process')
      const result = spawnSync('tar', ['-xzf', tempTar, '-C', installDir], {
        stdio: 'pipe',
      })
      if (result.status !== 0) {
        throw new Error(
          `tar 解压失败：${result.stderr?.toString() || '未知错误'}`,
        )
      }
    } finally {
      await rm(tempTar, { force: true })
    }

    const binaryPath = join(installDir, binaryName)

    if (!existsSync(binaryPath)) {
      throw new Error('解压后未找到 dblab 二进制文件')
    }

    // 在 Unix 系统上赋予执行权限
    if (!isWin) {
      await chmod(binaryPath, 0o755)
    }

    // 在配置中注册
    await configManager.setBinaryPath('dblab', binaryPath, 'bundled')

    spinner.succeed(`dblab v${DBLAB_VERSION} 安装完成`)
    console.log()

    return binaryPath
  } catch (error) {
    spinner.fail('下载 dblab 失败')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('您可以从以下地址手动下载：'))
    console.log(chalk.cyan('  https://github.com/danvergara/dblab/releases'))
    console.log()
    await pressEnterToContinue()
    return null
  }
}

/**
 * 为容器启动 dblab 可视化 TUI
 */
async function launchDblab(
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  database: string,
): Promise<void> {
  const dblabPath = await configManager.getBinaryPath('dblab')
  if (!dblabPath) {
    console.error(uiError('未找到 dblab。请先下载。'))
    await pressEnterToContinue()
    return
  }

  const args = getDblabArgs(config, database)

  console.log()
  console.log(chalk.gray('  dblab 快捷键：'))
  console.log(
    chalk.gray(
      '  Ctrl+Space：运行查询 | Ctrl+H/J/K/L：导航面板 | Ctrl+S：结构视图',
    ),
  )
  console.log()
  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('按 Enter 键启动 dblab...'),
    },
  ])

  const dblabProcess = spawn(dblabPath, args, {
    stdio: 'inherit',
  })

  await new Promise<void>((resolve) => {
    let settled = false

    const settle = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    dblabProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.log(uiWarning('未在系统中找到 dblab。'))
        console.log()
        console.log(chalk.gray('  使用以下命令下载：'))
        console.log(chalk.cyan('  spindb connect --install-dblab'))
      } else {
        console.log(uiError(`启动 dblab 失败：${err.message}`))
      }
      settle()
    })

    dblabProcess.on('close', () => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
      }
      settle()
    })
  })
}

/**
 * 为 PostgreSQL 兼容容器启动 pgweb
 */
async function launchPgweb(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  database: string,
): Promise<void> {
  const pgwebPath = await configManager.getBinaryPath('pgweb')
  if (!pgwebPath) {
    console.error(uiError('未找到 pgweb。请先下载。'))
    await pressEnterToContinue()
    return
  }

  const containerDir = paths.getContainerPath(containerName, {
    engine: config.engine,
  })
  const pidFile = join(containerDir, 'pgweb.pid')
  const portFile = join(containerDir, 'pgweb.port')

  // 检查是否已在运行 — 仅打开浏览器
  const status = await getPgwebStatus(containerName, config.engine)
  if (status.running && status.port) {
    const url = `http://127.0.0.1:${status.port}`
    console.log()
    console.log(uiInfo(`正在打开 pgweb`))
    console.log(chalk.gray(`  ${url}`))
    console.log()
    openInBrowser(url)
    await pressEnterToContinue()
    return
  }

  // 从 8081 开始查找可用端口
  let port = 8081
  while (!(await portManager.isPortAvailable(port)) && port < 8200) {
    port++
  }

  if (port >= 8200) {
    console.error(
      uiError(
        '无法为 pgweb 找到可用端口（已扫描 8081–8199）。' +
          '请检查是否有其他 pgweb 或服务器进程占用了这些端口。',
      ),
    )
    await pressEnterToContinue()
    return
  }

  // 构建连接 URL
  let connectionUrl: string
  if (config.engine === 'ferretdb') {
    // FerretDB 在后端端口上有一个 PostgreSQL 后端 — 始终连接到 'ferretdb' 数据库
    if (!config.backendPort) {
      console.log()
      console.error(uiError('未设置 PostgreSQL 后端端口 — 请先重启容器'))
      console.log()
      await pressEnterToContinue()
      return
    }
    connectionUrl = `postgresql://postgres@127.0.0.1:${config.backendPort}/ferretdb?sslmode=disable`
  } else if (config.engine === 'cockroachdb') {
    connectionUrl = `postgresql://root@127.0.0.1:${config.port}/${database}?sslmode=disable`
  } else {
    connectionUrl = `postgresql://postgres@127.0.0.1:${config.port}/${database}?sslmode=disable`
  }

  // 分离式启动 pgweb
  const pgwebProcess = spawn(
    pgwebPath,
    ['--url', connectionUrl, '--bind', '127.0.0.1', '--listen', String(port)],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    },
  )

  pgwebProcess.unref()

  // 写入 PID 和端口文件
  if (pgwebProcess.pid) {
    await writeFile(pidFile, String(pgwebProcess.pid))
    await writeFile(portFile, String(port))
  }

  // 等待短暂启动
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const url = `http://127.0.0.1:${port}`
  console.log()
  console.log(uiSuccess(`pgweb 已在 ${url} 上启动`))
  console.log(chalk.gray(`  PID：${pgwebProcess.pid}`))
  console.log()
  openInBrowser(url)
  await pressEnterToContinue()
}

async function launchShell(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  connectionString: string,
  shellType: 'default' | 'usql' | 'pgcli' | 'mycli' | 'litecli' | 'iredis',
  database: string,
): Promise<void> {
  console.log(uiInfo(`正在连接到 ${containerName}...`))
  console.log()

  const isRemote = isRemoteContainer(config)

  // 解析远程连接字符串以获取主机/端口/用户/密码
  let rHost = '127.0.0.1'
  let rPort = config.port
  let rUser = ''
  let rPass = ''
  if (isRemote) {
    try {
      const parsed = parseConnectionString(connectionString)
      rHost = parsed.host || config.remote?.host || '127.0.0.1'
      rPort = parsed.port || config.port
      rUser = parsed.username || ''
      rPass = parsed.password || ''
    } catch {
      /* 使用默认值 */
    }
  }

  let shellCmd: string
  let shellArgs: string[]
  let installHint: string
  let spawnCwd: string | undefined

  if (shellType === 'pgcli') {
    // pgcli 接受连接字符串
    shellCmd = 'pgcli'
    shellArgs = [connectionString]
    installHint = 'brew install pgcli'
  } else if (shellType === 'mycli') {
    // mycli 直接接受连接字符串
    shellCmd = 'mycli'
    if (isRemote) {
      shellArgs = [connectionString]
    } else {
      shellArgs = [
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        '-u',
        'root',
        database,
      ]
    }
    installHint = 'brew install mycli'
  } else if (shellType === 'litecli') {
    // litecli 直接接受数据库文件路径
    shellCmd = 'litecli'
    shellArgs = [config.database]
    installHint = 'brew install litecli'
  } else if (shellType === 'usql') {
    // usql 直接接受 PostgreSQL、MySQL 和 SQLite 的连接字符串
    shellCmd = 'usql'
    shellArgs = [connectionString]
    installHint = 'brew tap xo/xo && brew install xo/xo/usql'
  } else if (config.engine === 'sqlite') {
    // 默认 SQLite Shell
    shellCmd = 'sqlite3'
    shellArgs = [config.database]
    installHint = 'brew install sqlite3'
  } else if (config.engine === 'duckdb') {
    // DuckDB Shell
    const duckdbPath = await configManager.getBinaryPath('duckdb')
    shellCmd = duckdbPath || 'duckdb'
    shellArgs = [config.database]
    installHint = 'spindb engines download duckdb'
  } else if (config.engine === 'mysql') {
    // MySQL 使用下载的二进制文件 - 获取实际路径
    const mysqlPath = await configManager.getBinaryPath('mysql')
    shellCmd = mysqlPath || 'mysql'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-P', String(rPort), '-u', rUser || 'root']
      if (rPass) shellArgs.push(`-p${rPass}`)
      shellArgs.push(database)
    } else {
      shellArgs = [
        '-u',
        'root',
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        database,
      ]
    }
    installHint = 'spindb engines download mysql'
  } else if (config.engine === 'mariadb') {
    // MariaDB 使用下载的二进制文件，非系统 PATH - 获取实际路径
    const mariadbPath = await configManager.getBinaryPath('mariadb')
    shellCmd = mariadbPath || 'mariadb'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-P', String(rPort), '-u', rUser || 'root']
      if (rPass) shellArgs.push(`-p${rPass}`)
      shellArgs.push(database)
    } else {
      shellArgs = [
        '-u',
        'root',
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        database,
      ]
    }
    installHint = 'spindb engines download mariadb'
  } else if (config.engine === 'mongodb' || config.engine === 'ferretdb') {
    shellCmd = 'mongosh'
    shellArgs = [connectionString]
    installHint = 'brew install mongosh'
  } else if (shellType === 'iredis') {
    // iredis：增强的 Redis CLI
    shellCmd = 'iredis'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'brew install iredis'
  } else if (config.engine === 'redis') {
    // 默认 Redis Shell
    shellCmd = 'redis-cli'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'brew install redis'
  } else if (config.engine === 'valkey') {
    // 默认 Valkey Shell
    const valkeyCliPath = await configManager.getBinaryPath('valkey-cli')
    shellCmd = valkeyCliPath || 'valkey-cli'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'spindb engines download valkey'
  } else if (config.engine === 'clickhouse') {
    // ClickHouse 使用带子命令的统一二进制文件
    const clickhousePath = await configManager.getBinaryPath('clickhouse')
    shellCmd = clickhousePath || 'clickhouse'
    shellArgs = [
      'client',
      '--host',
      isRemote ? rHost : '127.0.0.1',
      '--port',
      String(isRemote ? rPort : config.port),
      '--database',
      database,
    ]
    if (isRemote && rUser) shellArgs.push('--user', rUser)
    if (isRemote && rPass) shellArgs.push('--password', rPass)
    installHint = 'spindb engines download clickhouse'
  } else if (config.engine === 'qdrant') {
    // Qdrant：在浏览器中打开 Web UI（仅在 Web UI 已安装时显示）
    const dashboardUrl = `http://127.0.0.1:${config.port}/dashboard`
    console.log(uiInfo(`正在浏览器中打开 Qdrant 仪表盘...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'meilisearch') {
    // Meilisearch：在浏览器中打开仪表盘（托管在根 URL）
    const dashboardUrl = `http://127.0.0.1:${config.port}`
    console.log(uiInfo(`正在浏览器中打开 Meilisearch 仪表盘...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'weaviate') {
    // Weaviate：在浏览器中打开 REST API 根路径
    const dashboardUrl = `http://127.0.0.1:${config.port}`
    console.log(uiInfo(`正在浏览器中打开 Weaviate...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'influxdb') {
    // InfluxDB：influxdb3 query 是一次性执行（无 REPL），使用交互式循环
    const engine = getEngine(config.engine)
    const influxdbPath = await engine
      .getInfluxDBPath(config.version)
      .catch(() => null)
    if (!influxdbPath) {
      console.log(
        uiWarning('未找到 influxdb3。请运行：spindb engines download influxdb'),
      )
      await pressEnterToContinue()
      return
    }
    // 从 REST API 查询可用数据库
    let db = database || config.name
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/v3/configure/database?format=json`,
      )
      if (resp.ok) {
        const databases = (await resp.json()) as Array<Record<string, string>>
        const dbNames = databases
          .map((d) => d['iox::database'] || d.name)
          .filter((n) => n && n !== '_internal')
        if (dbNames.length === 0) {
          console.log(
            uiWarning('尚不存在任何数据库。请先写入数据以创建数据库。'),
          )
          console.log(
            chalk.gray(
              `  curl -X POST "http://127.0.0.1:${config.port}/api/v3/write_lp?db=${db}" -H "Content-Type: text/plain" -d 'measurement,tag=value field=1'`,
            ),
          )
          console.log()
          await pressEnterToContinue()
          return
        }
        if (!dbNames.includes(db)) {
          if (dbNames.length === 1) {
            db = dbNames[0]
          } else {
            const { chosenDb } = await escapeablePrompt<{ chosenDb: string }>([
              {
                type: 'list',
                name: 'chosenDb',
                message: '选择数据库：',
                choices: dbNames,
              },
            ])
            db = chosenDb
          }
        }
      }
    } catch {
      // 服务器可能不支持此端点；使用默认数据库继续
    }
    console.log(chalk.cyan(`InfluxDB SQL 控制台（${db}）`))
    console.log(chalk.gray(`  输入 SQL 查询，或输入 "exit" 退出。\n`))
    let running = true
    while (running) {
      const { sql } = await escapeablePrompt<{ sql: string }>([
        {
          type: 'input',
          name: 'sql',
          message: chalk.blue('sql>'),
        },
      ])
      const trimmed = (sql || '').trim()
      if (
        trimmed.toLowerCase() === 'exit' ||
        trimmed.toLowerCase() === 'quit'
      ) {
        running = false
        break
      }
      if (!trimmed) {
        continue
      }
      const queryProcess = spawn(
        influxdbPath,
        [
          'query',
          '--host',
          `http://127.0.0.1:${config.port}`,
          '--database',
          db,
          '--',
          trimmed,
        ],
        { stdio: 'inherit' },
      )
      await new Promise<void>((resolve) => {
        queryProcess.on('error', (err) => {
          console.error(uiError(`查询失败：${err.message}`))
          resolve()
        })
        queryProcess.on('close', () => {
          logDebug('influxdb 查询进程已退出')
          resolve()
        })
      })
    }
    return
  } else if (config.engine === 'couchdb') {
    // CouchDB：在浏览器中打开 Fauxton 仪表盘（托管在 /_utils）
    const dashboardUrl = `http://127.0.0.1:${config.port}/_utils`
    console.log()
    console.log(chalk.cyan('CouchDB Fauxton 仪表盘'))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    console.log(chalk.cyan('凭据（如提示输入）：'))
    console.log(chalk.white(`  用户名：admin`))
    console.log(chalk.white(`  密码：admin`))
    console.log()

    // 在打开之前提示，以便用户能看到凭据
    await escapeablePrompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('按 Enter 键在浏览器中打开...'),
      },
    ])

    openInBrowser(dashboardUrl)
    return
  } else if (config.engine === 'surrealdb') {
    // SurrealDB 使用 surreal sql 命令
    const engine = getEngine(config.engine)
    const surrealPath = await engine
      .getSurrealPath(config.version)
      .catch(() => 'surreal')
    const namespace = config.name.replace(/-/g, '_')
    shellCmd = surrealPath
    if (isRemote) {
      shellArgs = [
        'sql',
        '--endpoint',
        `ws://${rHost}:${rPort}`,
        '--namespace',
        namespace,
        '--database',
        database || 'default',
      ]
      if (rUser) shellArgs.push('--username', rUser)
      if (rPass) shellArgs.push('--password', rPass)
    } else {
      shellArgs = [
        'sql',
        '--endpoint',
        `ws://127.0.0.1:${config.port}`,
        '--namespace',
        namespace,
        '--database',
        database || 'default',
        '--username',
        'root',
        '--password',
        'root',
      ]
    }
    installHint = 'spindb engines download surrealdb'
    // SurrealDB 将 history.txt 写入当前工作目录 - 使用容器目录
    spawnCwd = join(paths.containers, 'surrealdb', config.name)
  } else if (config.engine === 'cockroachdb') {
    // CockroachDB 使用 cockroach sql 命令
    const engine = getEngine(config.engine)
    const cockroachPath = await engine
      .getCockroachPath(config.version)
      .catch(() => 'cockroach')
    shellCmd = cockroachPath
    if (isRemote) {
      // 使用 --url 进行远程连接（支持完整连接字符串）
      shellArgs = ['sql', '--url', connectionString]
    } else {
      shellArgs = [
        'sql',
        '--insecure',
        '--host',
        `127.0.0.1:${config.port}`,
        '--database',
        database,
      ]
    }
    installHint = 'spindb engines download cockroachdb'
  } else if (config.engine === 'questdb') {
    // QuestDB 在端口 8812 上使用 PostgreSQL 有线协议
    shellCmd = 'psql'
    if (isRemote) {
      shellArgs = [connectionString]
    } else {
      // 默认凭据：admin/quest
      const db = database || 'qdb'
      const questDbConnStr = `postgresql://admin:quest@127.0.0.1:${config.port}/${db}`
      shellArgs = [questDbConnStr]
    }
    installHint = 'brew install libpq && brew link --force libpq'
  } else if (config.engine === 'typedb') {
    // TypeDB 使用 typedb console，带有地址和禁用 TLS 标志
    const engine = getEngine(config.engine)
    const consolePath = await engine
      .getTypeDBConsolePath(config.version)
      .catch(() => null)
    if (consolePath) {
      shellCmd = consolePath
      shellArgs = getConsoleBaseArgs(config.port)
    } else {
      // 回退：使用 typedb 启动器及 'console' 子命令
      shellCmd = 'typedb'
      shellArgs = ['console', ...getConsoleBaseArgs(config.port)]
    }
    installHint = 'spindb engines download typedb'
  } else if (config.engine === 'tigerbeetle') {
    // TigerBeetle 使用 tigerbeetle repl 命令
    const clusterId = 0
    const engine = getEngine(config.engine)
    const tigerbeetlePath = await engine
      .getTigerBeetlePath(config.version)
      .catch(() => null)
    shellCmd = tigerbeetlePath || 'tigerbeetle'
    shellArgs = [
      'repl',
      `--cluster=${clusterId}`,
      `--addresses=${isRemote ? rHost : '127.0.0.1'}:${isRemote ? rPort : config.port}`,
    ]
    installHint = 'spindb engines download tigerbeetle'
  } else {
    // PostgreSQL 默认 Shell - 查找下载的二进制文件路径
    const psqlPath = await configManager.getBinaryPath('psql')
    shellCmd = psqlPath || 'psql'
    shellArgs = [connectionString]
    installHint = 'spindb engines download postgresql'
  }

  const shellProcess = spawn(shellCmd, shellArgs, {
    stdio: 'inherit',
    cwd: spawnCwd,
  })

  await new Promise<void>((resolve) => {
    let settled = false

    const settle = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    shellProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.log(uiWarning(`未在系统中找到 ${shellCmd}。`))
        console.log()
        console.log(chalk.gray('  手动连接命令：'))
        console.log(chalk.cyan(`  ${connectionString}`))
        console.log()
        console.log(chalk.gray(`  安装 ${shellCmd}：`))
        console.log(chalk.cyan(`  ${installHint}`))
      } else {
        console.log(uiError(`启动 ${shellCmd} 失败：${err.message}`))
      }
      settle()
    })

    shellProcess.on('close', () => {
      // 清除终端，移除 Shell 可能残留的图形（如 usql 徽标）
      // 使用强力的 ANSI 序列：清屏 + 清除回滚缓冲区 + 重置光标
      // 仅当输出为 TTY 时发出 ANSI 转义码
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
      }
      settle()
    })
  })
}
