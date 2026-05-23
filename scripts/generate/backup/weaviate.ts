#!/usr/bin/env tsx
/**
 * 生成用于测试的 Weaviate 备份固件。
 *
 * 用法：
 *   pnpm generate:backup weaviate [名称]
 *
 * 参数：
 *   name - 可选的备份名称（默认："test_vectors"）
 *
 * 示例：
 *   pnpm generate:backup weaviate                    # 创建 test_vectors/ 备份目录
 *   pnpm generate:backup weaviate my-backup          # 创建 my-backup/ 备份目录
 *
 * 此脚本的功能：
 * 1. 找到一个正在运行的 Weaviate 容器（或使用第一个可用的容器）
 * 2. 创建一个包含示例数据的测试类
 * 3. 生成一个文件系统备份（目录，而非单个文件）
 * 4. 将备份目录复制到适当的位置
 *
 * 输出位置：
 * - 如果从 spindb 项目运行：tests/fixtures/weaviate/snapshots/{名称}/
 * - 如果从其他位置运行：当前工作目录下的 ./{名称}/
 *
 * 注意：Weaviate 备份是目录（而非像 Qdrant .snapshot 那样的单个文件）。
 * 目录名必须与 backup_config.json 中的内部备份 ID 匹配。
 */

import { existsSync, mkdirSync } from 'fs'
import { readFile, cp } from 'fs/promises'
import { join } from 'path'

const CLASS_NAME = 'TestVectors'
const DEFAULT_SNAPSHOT_NAME = 'test_vectors'

// 从命令行参数获取备份名称，或使用默认值
function getBackupName(): string {
  const arg = process.argv[2]
  if (arg && !arg.startsWith('-')) {
    return arg
  }
  return DEFAULT_SNAPSHOT_NAME
}

const BACKUP_NAME = getBackupName()

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

async function findWeaviateContainer(): Promise<{
  name: string
  port: number
} | null> {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const weaviateContainersDir = join(
      homeDir,
      '.spindb',
      'containers',
      'weaviate',
    )

    if (!existsSync(weaviateContainersDir)) {
      return null
    }

    const { readdir } = await import('fs/promises')
    const containerDirs = await readdir(weaviateContainersDir, {
      withFileTypes: true,
    })

    type ContainerConfig = {
      name: string
      engine: string
      port: number
      status: string
    }

    const containers: ContainerConfig[] = []

    for (const dir of containerDirs) {
      if (!dir.isDirectory()) continue

      const containerJsonPath = join(
        weaviateContainersDir,
        dir.name,
        'container.json',
      )
      if (!existsSync(containerJsonPath)) continue

      try {
        const content = await readFile(containerJsonPath, 'utf-8')
        const config = JSON.parse(content) as ContainerConfig
        containers.push(config)
      } catch {
        // 跳过无效的容器配置
      }
    }

    // 查找第一个正在运行的 Weaviate 容器
    const runningContainer = containers.find((c) => c.status === 'running')
    if (runningContainer) {
      return { name: runningContainer.name, port: runningContainer.port }
    }

    // 如果没有运行中的容器，尝试使用任意一个 Weaviate 容器
    if (containers.length > 0) {
      return { name: containers[0].name, port: containers[0].port }
    }

    return null
  } catch {
    return null
  }
}

async function checkWeaviateHealth(port: number): Promise<boolean> {
  try {
    const response = await weaviateRequest(port, 'GET', '/v1/.well-known/ready')
    return response.ok
  } catch {
    return false
  }
}

async function getOutputPath(): Promise<string> {
  const cwd = process.cwd()
  const packageJsonPath = join(cwd, 'package.json')

  try {
    if (existsSync(packageJsonPath)) {
      const packageJsonContent = await readFile(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent) as { name: string }

      if (packageJson.name === 'spindb') {
        // 从 spindb 项目运行 - 保存到固件目录
        const fixturesDir = join(
          cwd,
          'tests',
          'fixtures',
          'weaviate',
          'snapshots',
        )
        if (!existsSync(fixturesDir)) {
          mkdirSync(fixturesDir, { recursive: true })
        }
        return join(fixturesDir, BACKUP_NAME)
      }
    }
  } catch (error) {
    console.warn('警告：无法读取 package.json：', error)
  }

  // 默认：保存到当前目录
  return join(cwd, BACKUP_NAME)
}

async function main() {
  console.log('Weaviate 快照生成器')
  console.log('===========================\n')

  // 查找 Weaviate 容器
  console.log('正在查找 Weaviate 容器...')
  const container = await findWeaviateContainer()

  if (!container) {
    console.error(
      '错误：未找到 Weaviate 容器。\n' +
        '请先创建并启动一个 Weaviate 容器：\n' +
        '  spindb create my-weaviate --engine weaviate\n' +
        '  spindb start my-weaviate',
    )
    process.exit(1)
  }

  console.log(`找到容器：${container.name}（端口 ${container.port}）`)

  // 检查 Weaviate 是否响应
  console.log('正在检查 Weaviate 健康状态...')
  const isHealthy = await checkWeaviateHealth(container.port)

  if (!isHealthy) {
    console.error(
      `错误：Weaviate 在端口 ${container.port} 上无响应。\n` +
        '请确保容器正在运行：\n' +
        `  spindb start ${container.name}`,
    )
    process.exit(1)
  }

  console.log('Weaviate 健康\n')

  const port = container.port

  // 如果类存在，则删除
  console.log(`正在清理现有的 ${CLASS_NAME} 类...`)
  await weaviateRequest(port, 'DELETE', `/v1/schema/${CLASS_NAME}`)

  // 创建类
  console.log(`正在创建 ${CLASS_NAME} 类...`)
  const createResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/schema',
    TEST_DATA.classConfig,
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`创建类时出错：${error}`)
    process.exit(1)
  }

  // 插入测试对象
  console.log(`正在插入 ${TEST_DATA.objects.length} 个测试对象...`)
  const insertResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/batch/objects',
    { objects: TEST_DATA.objects },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`插入对象时出错：${error}`)
    process.exit(1)
  }

  // 验证数据
  const schemaResponse = await weaviateRequest(port, 'GET', '/v1/schema')
  const schema = (await schemaResponse.json()) as {
    classes?: Array<{ class?: string }>
  }
  const classCount = schema.classes?.length || 0
  console.log(`已验证：模式中有 ${classCount} 个类\n`)

  // 通过文件系统 API 创建备份
  const backupId = `backup-${Date.now()}`
  console.log('正在创建备份（这可能需要一些时间）...')

  // 备份路径通过服务器上的 BACKUP_FILESYSTEM_PATH 环境变量配置
  // 我们需要使用容器的数据目录
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const containerDir = join(
    homeDir,
    '.spindb',
    'containers',
    'weaviate',
    container.name,
  )
  const backupDir = join(containerDir, 'backups')
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true })
  }

  const backupResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/backups/filesystem',
    {
      id: backupId,
      include: [CLASS_NAME],
    },
  )

  if (!backupResponse.ok) {
    const error = await backupResponse.text()
    console.error(`创建备份时出错：${error}`)
    process.exit(1)
  }

  // 轮询等待备份完成
  console.log('正在等待备份完成...')
  let backupComplete = false
  for (let i = 0; i < 60; i++) {
    const statusResponse = await weaviateRequest(
      port,
      'GET',
      `/v1/backups/filesystem/${backupId}`,
    )

    if (statusResponse.ok) {
      const status = (await statusResponse.json()) as { status: string }
      if (status.status === 'SUCCESS') {
        backupComplete = true
        break
      } else if (status.status === 'FAILED') {
        console.error('备份失败')
        process.exit(1)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (!backupComplete) {
    console.error('备份超时')
    process.exit(1)
  }

  console.log('备份完成！\n')

  // 将备份复制到输出路径
  const outputPath = await getOutputPath()
  const backupSourceDir = join(backupDir, backupId)

  if (!existsSync(backupSourceDir)) {
    console.error(
      `错误：在 ${backupSourceDir} 中未找到备份目录\n` +
        `Weaviate 备份 API 报告成功，但该目录不存在。\n` +
        `请检查 BACKUP_FILESYSTEM_PATH 是否设置为：${backupDir}`,
    )
    process.exit(1)
  }

  console.log(`正在复制备份到：${outputPath}`)
  await cp(backupSourceDir, outputPath, { recursive: true })
  console.log('复制完成！\n')

  // 清理 - 删除类
  console.log(`正在清理 ${CLASS_NAME} 类...`)
  await weaviateRequest(port, 'DELETE', `/v1/schema/${CLASS_NAME}`)

  console.log('\n完成！')
  console.log(`备份已保存到：${outputPath}`)
  console.log('\n你可以使用此备份来测试 Weaviate 的还原功能：')
  console.log(`  spindb restore <容器名称> "${outputPath}"`)

  if (BACKUP_NAME !== DEFAULT_SNAPSHOT_NAME) {
    console.log(`\n注意：使用了自定义备份名称 "${BACKUP_NAME}"。`)
  }
}

main().catch((error) => {
  console.error('错误：', error)
  process.exit(1)
})
