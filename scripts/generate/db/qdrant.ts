#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 Qdrant 数据库。
 *
 * 用法:
 *   pnpm generate:db qdrant [容器名称] [--port <端口>]
 *
 * 注意: Qdrant 使用 REST API，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'qdrant'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const COLLECTION_NAME = 'test_vectors'

const TEST_DATA = {
  vectors: { size: 4, distance: 'Cosine' },
  points: [
    {
      id: 1,
      vector: [0.1, 0.2, 0.3, 0.4],
      payload: { name: 'Alice', city: 'NYC' },
    },
    {
      id: 2,
      vector: [0.2, 0.3, 0.4, 0.5],
      payload: { name: 'Bob', city: 'LA' },
    },
    {
      id: 3,
      vector: [0.9, 0.8, 0.7, 0.6],
      payload: { name: 'Charlie', city: 'SF' },
    },
  ],
}

async function qdrantRequest(
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

  console.log('Qdrant 数据库生成器')
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

  console.log('等待 Qdrant 就绪...')
  const isReady = await waitForHttpReady(config.port, '/healthz')

  if (!isReady) {
    console.error('错误: Qdrant 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('Qdrant 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  // 如果集合存在则删除 (如果集合不存在则返回 404 是正常的)
  const encodedName = encodeURIComponent(COLLECTION_NAME)
  try {
    const deleteResponse = await qdrantRequest(
      config.port,
      'DELETE',
      `/collections/${encodedName}`,
    )
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const error = await deleteResponse.text()
      throw new Error(
        `删除集合 "${COLLECTION_NAME}" 失败: ${error}`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('删除')) {
      throw error
    }
    // 网络错误 - 带上下文重新抛出
    throw new Error(
      `删除集合 "${COLLECTION_NAME}" 时网络错误: ${error instanceof Error ? error.message : error}`,
    )
  }

  // 创建集合
  const createResponse = await qdrantRequest(
    config.port,
    'PUT',
    `/collections/${encodedName}`,
    { vectors: TEST_DATA.vectors },
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`创建集合时出错: ${error}`)
    process.exit(1)
  }

  // 插入测试点
  const insertResponse = await qdrantRequest(
    config.port,
    'PUT',
    `/collections/${encodedName}/points`,
    { points: TEST_DATA.points },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`插入点时出错: ${error}`)
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  try {
    const infoResponse = await qdrantRequest(
      config.port,
      'GET',
      `/collections/${encodedName}`,
    )
    if (!infoResponse.ok) {
      const error = await infoResponse.text()
      console.error(
        `获取集合 "${COLLECTION_NAME}" 信息时出错: ${error}`,
      )
      process.exit(1)
    }
    const info = (await infoResponse.json()) as {
      result?: { points_count?: number }
    }
    if (typeof info.result?.points_count !== 'number') {
      console.warn(
        `警告: 无法验证 "${COLLECTION_NAME}" 的点数量`,
      )
    } else {
      console.log(
        `已验证: ${COLLECTION_NAME} 集合中有 ${info.result.points_count} 个点`,
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
  console.log(`  pnpm start connect ${containerName}  # 打开仪表板`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
