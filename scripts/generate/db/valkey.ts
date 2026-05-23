#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 Valkey 数据库。
 *
 * 用法:
 *   pnpm generate:db valkey [容器名称] [--port <端口>]
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForReady,
  getSeedFile,
  parseQuotedCommand,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'valkey'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.valkey')

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Valkey 数据库生成器')
  console.log('====================\n')

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

  console.log('等待 Valkey 就绪...')
  const isReady = await waitForReady(containerName, ['--', 'PING'])

  if (!isReady) {
    console.error('错误: Valkey 在规定时间内未就绪')
    process.exit(1)
  }

  console.log('Valkey 已就绪。\n')

  console.log('正在用示例数据填充数据库...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  // 逐条执行 Valkey 命令 (支持 # 注释)
  const commands = seedContent
    .trim()
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))

  for (const command of commands) {
    const args = parseQuotedCommand(command)
    const result = runContainerCommand(containerName, args)

    if (result.status !== 0) {
      console.error(`执行出错: ${command}`)
      console.error(result.stderr)
      process.exit(1)
    }
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  const verifyResult = runContainerCommand(containerName, ['GET', 'user:count'])

  if (verifyResult.status === 0) {
    const count = verifyResult.stdout.trim().replace(/"/g, '')
    if (count) {
      console.log(`已验证: 存储了 ${count} 个用户`)
    }
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
