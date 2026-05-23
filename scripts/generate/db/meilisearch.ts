#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 Meilisearch 数据库。
 *
 * 用法:
 *   pnpm generate:db meilisearch [容器名称] [--port <端口>]
 *
 * 注意: Meilisearch 使用 REST API，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'meilisearch'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const INDEX_NAME = 'test_users'

const TEST_DATA = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com', city: 'NYC' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com', city: 'LA' },
  { id: 3, name: 'Charlie Brown', email: 'charlie@example.com', city: 'SF' },
  { id: 4, name: 'Diana Ross', email: 'diana@example.com', city: 'Chicago' },
  { id: 5, name: 'Eve Wilson', email: 'eve@example.com', city: 'Boston' },
]

async function meiliRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`
  const options: RequestInit = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function waitForTask(port: number, taskUid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const response = await meiliRequest(port, 'GET', `/tasks/${taskUid}`)
    const task = (await response.json()) as { status: string }

    if (task.status === 'succeeded') {
      return true
    }
    if (task.status === 'failed') {
      return false
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Meilisearch 数据库生成器')
  console.log('=========================\n')

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

  console.log('等待 Meilisearch 就绪...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('错误: Meilisearch 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('Meilisearch 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  // 如果索引存在则删除并等待任务完成
  const deleteResponse = await meiliRequest(
    config.port,
    'DELETE',
    `/indexes/${INDEX_NAME}`,
  )
  if (deleteResponse.ok) {
    const deleteTask = (await deleteResponse.json()) as { taskUid: number }
    const deleteSuccess = await waitForTask(config.port, deleteTask.taskUid)
    if (!deleteSuccess) {
      // 删除失败不是致命错误 - 索引可能不存在
      console.log(`注意: 无法删除现有索引 "${INDEX_NAME}"`)
    }
  }

  // 创建索引
  const createResponse = await meiliRequest(config.port, 'POST', '/indexes', {
    uid: INDEX_NAME,
    primaryKey: 'id',
  })

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`创建索引时出错: ${error}`)
    process.exit(1)
  }

  const createTask = (await createResponse.json()) as { taskUid: number }
  const indexCreated = await waitForTask(config.port, createTask.taskUid)

  if (!indexCreated) {
    console.error(`错误: 索引 "${INDEX_NAME}" 创建任务失败`)
    process.exit(1)
  }

  // 插入文档
  const insertResponse = await meiliRequest(
    config.port,
    'POST',
    `/indexes/${INDEX_NAME}/documents`,
    TEST_DATA,
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`插入文档时出错: ${error}`)
    process.exit(1)
  }

  const insertTask = (await insertResponse.json()) as { taskUid: number }
  const success = await waitForTask(config.port, insertTask.taskUid)

  if (!success) {
    console.error('错误: 文档插入任务失败')
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  const statsResponse = await meiliRequest(
    config.port,
    'GET',
    `/indexes/${INDEX_NAME}/stats`,
  )
  if (!statsResponse.ok) {
    const error = await statsResponse.text()
    console.error(`获取索引统计信息时出错: ${error}`)
    process.exit(1)
  }
  const stats = (await statsResponse.json()) as { numberOfDocuments?: number }
  if (typeof stats.numberOfDocuments !== 'number') {
    console.warn(`警告: 无法验证 "${INDEX_NAME}" 的文档数量`)
  } else {
    console.log(
      `已验证: ${INDEX_NAME} 索引中有 ${stats.numberOfDocuments} 个文档`,
    )
  }

  console.log('\n完成!')
  console.log(`\n容器 "${containerName}" 已准备就绪，包含示例数据。`)
  console.log(`\n连接信息:`)
  console.log(`  pnpm start url ${containerName}`)
  console.log(`  pnpm start connect ${containerName}  # 打开仪表板`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
