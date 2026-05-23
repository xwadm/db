#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 InfluxDB 数据库。
 *
 * 用法:
 *   pnpm generate:db influxdb [容器名称] [--port <端口>]
 *
 * 注意: InfluxDB 使用 REST API，因此数据通过 HTTP 请求插入。
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'influxdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const DB_NAME = 'testdb'

const TEST_DATA_LINE_PROTOCOL = [
  'test_user,id=1 name="Alice Johnson",email="alice@example.com"',
  'test_user,id=2 name="Bob Smith",email="bob@example.com"',
  'test_user,id=3 name="Charlie Brown",email="charlie@example.com"',
  'test_user,id=4 name="Diana Ross",email="diana@example.com"',
  'test_user,id=5 name="Eve Wilson",email="eve@example.com"',
].join('\n')

async function influxRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`
  const headers: Record<string, string> = {}
  if (contentType) {
    headers['Content-Type'] = contentType
  } else if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json'
  }
  const options: RequestInit = {
    method,
    headers,
    body:
      typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('InfluxDB 数据库生成器')
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

  console.log('等待 InfluxDB 就绪...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('错误: InfluxDB 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('InfluxDB 已就绪。\n')

  console.log('正在用示例数据填充数据库...')

  // 使用行协议写入测试数据 (隐式创建数据库)
  const writeResponse = await influxRequest(
    config.port,
    'POST',
    `/api/v3/write_lp?db=${encodeURIComponent(DB_NAME)}`,
    TEST_DATA_LINE_PROTOCOL,
    'text/plain',
  )

  if (!writeResponse.ok) {
    const error = await writeResponse.text()
    console.error(`写入数据时出错: ${error}`)
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  try {
    const queryResponse = await influxRequest(
      config.port,
      'POST',
      '/api/v3/query_sql',
      {
        db: DB_NAME,
        q: 'SELECT COUNT(*) as count FROM test_user',
        format: 'json',
      },
    )
    if (!queryResponse.ok) {
      const error = await queryResponse.text()
      console.error(`查询数据时出错: ${error}`)
      process.exit(1)
    }
    const data = (await queryResponse.json()) as Array<{ count?: number }>
    const count = data?.[0]?.count
    if (typeof count !== 'number') {
      console.warn('警告: 无法从响应中验证记录数量')
    } else {
      console.log(`已验证: ${DB_NAME} 数据库中有 ${count} 条记录`)
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
    `  pnpm start connect ${containerName}  # 显示 REST API 端点`,
  )
  console.log(`\nREST API: http://127.0.0.1:${config.port}`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
