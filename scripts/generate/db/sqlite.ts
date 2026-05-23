#!/usr/bin/env tsx
/**
 * 生成包含示例数据的 SQLite 数据库。
 *
 * 用法:
 *   pnpm generate:db sqlite [容器名称]
 *
 * 注意: SQLite 是基于文件的，因此 --port 不适用。
 */

import { existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import {
  parseArgs,
  runSpindb,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'
import { join } from 'path'

function getDemoDir(): string {
  const dir = join(homedir(), '.spindb', 'demo')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

const ENGINE = 'sqlite'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.sql')

async function getFileBasedConfig(
  name: string,
): Promise<{ name: string; database: string } | null> {
  // 使用 os.homedir() 实现跨平台兼容，如果不可用则退出
  const homeDir = homedir()
  if (!homeDir) {
    return null
  }

  const configPath = join(homeDir, '.spindb', 'config.json')

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content) as {
      sqlite?: Record<string, { path: string }>
    }
    const entry = config.sqlite?.[name]
    if (entry) {
      return { name, database: entry.path }
    }
    return null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const { containerName } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('SQLite 数据库生成器')
  console.log('====================\n')

  if (!existsSync(SEED_FILE)) {
    console.error(`错误: 种子文件未找到: ${SEED_FILE}`)
    process.exit(1)
  }

  console.log(`检查容器 "${containerName}"...`)
  let config = await getFileBasedConfig(containerName)

  if (!config) {
    console.log(`容器未找到。正在创建 "${containerName}"...`)

    // 在 ~/.spindb/demo/ 中创建，避免污染当前工作目录
    const dbPath = join(getDemoDir(), `${containerName}.sqlite`)
    const createResult = runSpindb([
      'create',
      containerName,
      '--engine',
      ENGINE,
      '--path',
      dbPath,
    ])

    if (!createResult.success) {
      console.error('创建容器时出错:')
      console.error(createResult.output)
      process.exit(1)
    }

    console.log('容器创建成功。')
    config = await getFileBasedConfig(containerName)

    if (!config) {
      // SQLite 可能未在配置中注册，使用预期路径
      config = { name: containerName, database: dbPath }
    }
  } else {
    console.log(`找到现有容器: ${config.database}`)
  }

  console.log(`数据库文件: ${config.database}\n`)

  console.log('正在用示例数据填充数据库...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  const seedResult = runContainerCommand(containerName, ['-cmd', seedContent])

  if (seedResult.status !== 0) {
    console.error('填充数据库时出错:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('数据库填充成功!\n')

  console.log('正在验证数据...')
  const verifyResult = runContainerCommand(containerName, [
    '-cmd',
    'SELECT COUNT(*) FROM test_user;',
  ])

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.match(/(\d+)/)
    if (match) {
      console.log(`已验证: test_user 表中有 ${match[1]} 个用户`)
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
