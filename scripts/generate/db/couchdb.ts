#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 CouchDB 数据库。
 *
 * 用法:
 *   pnpm generate:db couchdb [容器名称] [--port <端口>]
 *
 * 注意: CouchDB 使用 REST API，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'couchdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const DB_NAME = 'testdb'
const AUTH = 'admin:admin' // CouchDB 默认凭据

const TEST_DATA = [
  {
    _id: 'user:1',
    type: 'user',
    name: 'Alice Johnson',
    email: 'alice@example.com',
  },
  { _id: 'user:2', type: 'user', name: 'Bob Smith', email: 'bob@example.com' },
  {
    _id: 'user:3',
    type: 'user',
    name: 'Charlie Brown',
    email: 'charlie@example.com',
  },
  {
    _id: 'user:4',
    type: 'user',
    name: 'Diana Ross',
    email: 'diana@example.com',
  },
  { _id: 'user:5', type: 'user', name: 'Eve Wilson', email: 'eve@example.com' },
]

async function couchRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://${AUTH}@127.0.0.1:${port}${path}`
  const options: RequestInit = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('CouchDB 数据库生成器')
  console.log('=====================\n')

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

  console.log('等待 CouchDB 就绪...')
  const isReady = await waitForHttpReady(config.port, '/')

  if (!isReady) {
    console.error('错误: CouchDB 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('CouchDB 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  // 如果数据库存在则删除
  await couchRequest(config.port, 'DELETE', `/${DB_NAME}`)

  // 创建数据库
  const createResponse = await couchRequest(config.port, 'PUT', `/${DB_NAME}`)

  if (!createResponse.ok && createResponse.status !== 412) {
    const error = await createResponse.text()
    console.error(`创建数据库时出错: ${error}`)
    process.exit(1)
  }

  // 使用批量文档插入数据
  const bulkResponse = await couchRequest(
    config.port,
    'POST',
    `/${DB_NAME}/_bulk_docs`,
    { docs: TEST_DATA },
  )

  if (!bulkResponse.ok) {
    const error = await bulkResponse.text()
    console.error(`插入文档时出错: ${error}`)
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  try {
    const infoResponse = await couchRequest(config.port, 'GET', `/${DB_NAME}`)
    if (!infoResponse.ok) {
      const error = await infoResponse.text()
      console.error(`获取数据库信息时出错: ${error}`)
      process.exit(1)
    }
    const info = (await infoResponse.json()) as { doc_count?: number }
    if (typeof info.doc_count !== 'number') {
      console.warn('警告: 无法从响应中验证文档数量')
    } else {
      console.log(
        `已验证: ${DB_NAME} 数据库中有 ${info.doc_count} 个文档`,
      )
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
  console.log(
    `  pnpm start connect ${containerName}  # 打开 Fauxton 仪表板`,
  )
  console.log(`\n默认凭据: admin / admin`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
