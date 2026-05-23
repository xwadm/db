#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 SurrealDB 数据库。
 *
 * 用法:
 *   pnpm generate:db surrealdb [容器名称] [--port <端口>]
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'surrealdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.surql')

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('SurrealDB 数据库生成器')
  console.log('=======================\n')

  if (!existsSync(SEED_FILE)) {
    console.error(`错误: 种子文件未找到: ${SEED_FILE}`)
    process.exit(1)
  }

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

  console.log('等待 SurrealDB 就绪...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('错误: SurrealDB 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('SurrealDB 已就绪。\n')

  console.log('正在用示例数据填充数据库...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  const seedResult = runContainerCommand(containerName, ['-c', seedContent])

  if (seedResult.status !== 0) {
    console.error('填充数据库时出错:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  const verifyResult = runContainerCommand(containerName, [
    '-c',
    'SELECT count() FROM test_user GROUP ALL',
  ])

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.match(/(\d+)/)
    if (match) {
      console.log(`已验证: test_user 表中有 ${match[1]} 个用户`)
    } else {
      console.warn(
        '警告: 无法从输出验证用户数量:',
        verifyResult.stdout.trim() || '(空)',
      )
    }
  } else {
    console.warn('警告: 验证查询失败:', verifyResult.stderr)
  }

  console.log('\n完成!')
  console.log(`\n容器 "${containerName}" 已准备就绪，包含示例数据。`)
  console.log(`\n连接信息:`)
  console.log(`  pnpm start url ${containerName}`)
  console.log(`  pnpm start connect ${containerName}`)
}

main().catch((error) => {
  console.error('错误:', error)
  process.exit(1)
})
