#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 libSQL 数据库。
 *
 * 用法:
 *   pnpm generate:db libsql [容器名称] [--port <端口>]
 *
 * 注意: libSQL 使用 REST API (Hrana over HTTP)，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'libsql'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`

const SEED_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS test_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Alice Johnson', 'alice@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Bob Smith', 'bob@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Charlie Brown', 'charlie@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Diana Ross', 'diana@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Eve Wilson', 'eve@example.com')`,
]

async function libsqlQuery(port: number, sql: string): Promise<unknown> {
  const url = `http://127.0.0.1:${port}/v2/pipeline`
  const body = {
    requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`libSQL API 请求失败 (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    results: Array<{
      type: string
      response?: { type: string; result?: unknown }
      error?: { message: string }
    }>
  }

  const firstResult = data.results[0]
  if (firstResult?.type === 'error') {
    throw new Error(
      `libSQL 查询错误: ${firstResult.error?.message ?? '未知错误'}`,
    )
  }

  return firstResult?.response?.result
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('libSQL 数据库生成器')
  console.log('====================\n')

  console.log(`检查容器 "${containerName}"...`)
  let config = await getContainerConfig(ENGINE, containerName)

  if (!config) {
    console.log(`容器未找到。正在创建 "${containerName}"...`)
    const createArgs = ['create', containerName, '--engine', ENGINE]
    if (port) {
      createArgs.push('--port', port.toString())
    }
    const createResult = runSpindb(createArgs)

    if (!createResult.success) {
      console.error('创建容器时出错:')
      console.error(createResult.output)
      process.exit(1)
    }

    console.log('容器创建成功。')
    config = await getContainerConfig(ENGINE, containerName)

    if (!config) {
      console.error('错误: 创建后无法读取容器配置')
      process.exit(1)
    }
  } else {
    console.log(`找到现有容器，端口为 ${config.port}`)
  }

  if (config.status !== 'running') {
    console.log(`正在启动 "${containerName}"...`)
    const startCode = await runSpindbStreaming(['start', containerName])

    if (startCode !== 0) {
      console.error('启动容器时出错')
      process.exit(1)
    }

    config = await getContainerConfig(ENGINE, containerName)
    if (!config) {
      console.error('错误: 启动后无法读取容器配置')
      process.exit(1)
    }
  }

  console.log(`容器运行在端口 ${config.port}\n`)

  console.log('等待 libSQL 就绪...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('错误: libSQL 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('libSQL 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  for (const sql of SEED_STATEMENTS) {
    try {
      await libsqlQuery(config.port, sql)
    } catch (error) {
      console.error(
        `执行 SQL 时出错: ${error instanceof Error ? error.message : error}`,
      )
      process.exit(1)
    }
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  try {
    const result = await libsqlQuery(
      config.port,
      'SELECT COUNT(*) as count FROM test_user',
    )

    const typedResult = result as {
      cols?: Array<{ name: string }>
      rows?: Array<Array<{ type: string; value?: string | number }>>
    }

    if (
      !Array.isArray(typedResult?.rows) ||
      !Array.isArray(typedResult.rows[0]) ||
      typedResult.rows[0][0] == null
    ) {
      console.warn(
        '警告: COUNT 查询返回的结果格式异常:',
        JSON.stringify(result),
      )
    } else {
      const cell = typedResult.rows[0][0]
      const count = cell.value !== undefined ? Number(cell.value) : undefined
      if (count !== undefined && !isNaN(count)) {
        console.log(`已验证: test_user 表中有 ${count} 个用户`)
      } else {
        console.warn(
          '警告: 无法从以下数据解析行数:',
          JSON.stringify(cell),
        )
      }
    }
  } catch (error) {
    console.error(
      `验证数据时出错: ${error instanceof Error ? error.message : error}`,
    )
    process.exit(1)
  }

  console.log('\n完成!')
  console.log(`\n容器 "${containerName}" 已准备就绪，包含示例数据。`)
  console.log(`\n连接信息:`)
  console.log(`  pnpm start url ${containerName}`)
  console.log(`  pnpm start connect ${containerName}  # 显示 HTTP API 信息`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
