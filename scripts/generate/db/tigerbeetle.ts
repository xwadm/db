#!/usr/bin/env tsx
/**
 * 生成 TigerBeetle 数据库容器。
 *
 * TigerBeetle 使用自定义二进制协议，没有 SQL/REST API，
 * 因此此脚本仅创建并启动容器。数据填充必须通过 TigerBeetle REPL 或客户端库完成。
 *
 * 用法:
 *   pnpm generate:db tigerbeetle [容器名称] [--port <端口>]
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
} from './_shared.js'

const ENGINE = 'tigerbeetle'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('TigerBeetle 数据库生成器')
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

  console.log('完成!')
  console.log(`\n容器 "${containerName}" 已准备就绪。`)
  console.log('\nTigerBeetle 使用自定义二进制协议。')
  console.log('要与之交互，请使用 REPL:')
  console.log(`  pnpm start connect ${containerName}`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
