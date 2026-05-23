#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 Weaviate 数据库。
 *
 * 用法:
 *   pnpm generate:db weaviate [容器名称] [--port <端口>]
 *
 * 注意: Weaviate 使用 REST API，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'weaviate'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const CLASS_NAME = 'TestVectors'

const TEST_DATA = {
  classConfig: {
    class: CLASS_NAME,
    vectorizer: 'none',
    properties: [
      { name: 'name', dataType: ['text'] },
      { name: 'city', dataType: ['text'] },
    ],
  },
  objects: [
    {
      class: CLASS_NAME,
      properties: { name: 'Alice', city: 'NYC' },
      vector: [0.1, 0.2, 0.3, 0.4],
    },
    {
      class: CLASS_NAME,
      properties: { name: 'Bob', city: 'LA' },
      vector: [0.2, 0.3, 0.4, 0.5],
    },
    {
      class: CLASS_NAME,
      properties: { name: 'Charlie', city: 'SF' },
      vector: [0.9, 0.8, 0.7, 0.6],
    },
  ],
}

async function weaviateRequest(
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

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Weaviate 数据库生成器')
  console.log('======================\n')

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

  console.log('等待 Weaviate 就绪...')
  const isReady = await waitForHttpReady(config.port, '/v1/.well-known/ready')

  if (!isReady) {
    console.error('错误: Weaviate 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('Weaviate 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  // 如果类存在则删除 (如果类不存在则返回 404 是正常的)
  try {
    const deleteResponse = await weaviateRequest(
      config.port,
      'DELETE',
      `/v1/schema/${CLASS_NAME}`,
    )
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const error = await deleteResponse.text()
      throw new Error(`删除类 "${CLASS_NAME}" 失败: ${error}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('删除')) {
      throw error
    }
    // 网络错误 - 带上下文重新抛出
    throw new Error(
      `删除类 "${CLASS_NAME}" 时网络错误: ${error instanceof Error ? error.message : error}`,
    )
  }

  // 创建类
  const createResponse = await weaviateRequest(
    config.port,
    'POST',
    '/v1/schema',
    TEST_DATA.classConfig,
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`创建类时出错: ${error}`)
    process.exit(1)
  }

  // 通过批量 API 插入测试对象
  const insertResponse = await weaviateRequest(
    config.port,
    'POST',
    '/v1/batch/objects',
    { objects: TEST_DATA.objects },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`插入对象时出错: ${error}`)
    process.exit(1)
  }

  // Weaviate 批量 API 即使单个对象失败也返回 200 —
  // 错误嵌套在每个对象的结果中
  const batchResults = (await insertResponse.json()) as Array<{
    result?: {
      status?: string
      errors?: { error?: Array<{ message?: string }> }
    }
  }>
  const failures = batchResults.filter((r) => r.result?.status === 'FAILED')
  if (failures.length > 0) {
    console.error(
      `错误: ${failures.length}/${batchResults.length} 个对象插入失败:`,
    )
    for (const f of failures) {
      const msgs = f.result?.errors?.error?.map((e) => e.message).join(', ')
      console.error(`  - ${msgs || '未知错误'}`)
    }
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  try {
    const schemaResponse = await weaviateRequest(
      config.port,
      'GET',
      '/v1/schema',
    )
    if (!schemaResponse.ok) {
      const error = await schemaResponse.text()
      console.error(`获取 schema 时出错: ${error}`)
      process.exit(1)
    }
    const schema = (await schemaResponse.json()) as {
      classes?: Array<{ class?: string }>
    }
    const classCount = schema.classes?.length || 0
    console.log(`已验证: schema 中有 ${classCount} 个类`)

    const classInfo = schema.classes?.find((c) => c.class === CLASS_NAME)
    if (classInfo) {
      console.log(`  - ${CLASS_NAME} 类已找到`)
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
  console.log(`  pnpm start connect ${containerName}  # 打开仪表板`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
