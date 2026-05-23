#!/usr/bin/env tsx
/**
 * 生成用于测试的 Qdrant 快照固件。
 *
 * 用法：
 *   pnpm generate:backup qdrant [名称]
 *
 * 参数：
 *   name - 可选的快照名称（默认："test_vectors"）
 *          扩展名 .snapshot 会自动添加
 *
 * 示例：
 *   pnpm generate:backup qdrant                    # 创建 test_vectors.snapshot
 *   pnpm generate:backup qdrant my-snapshot        # 创建 my-snapshot.snapshot
 *   pnpm generate:backup qdrant backup.snapshot    # 创建 backup.snapshot
 *
 * 此脚本的功能：
 * 1. 找到一个正在运行的 Qdrant 容器（或使用第一个可用的容器）
 * 2. 创建一个包含示例数据的测试集合
 * 3. 生成一个快照
 * 4. 将快照下载到适当的位置
 *
 * 输出位置：
 * - 如果从 spindb 项目运行：tests/fixtures/qdrant/snapshots/{名称}.snapshot
 * - 如果从其他位置运行：当前工作目录下的 ./{名称}.snapshot
 */

import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const COLLECTION_NAME = 'test_vectors'
const DEFAULT_SNAPSHOT_NAME = 'test_vectors'

// 从命令行参数获取快照名称，或使用默认值
function getSnapshotName(): string {
  const arg = process.argv[2]
  if (arg && !arg.startsWith('-')) {
    // 如果提供了扩展名，则移除 .snapshot
    return arg.replace(/\.snapshot$/, '')
  }
  return DEFAULT_SNAPSHOT_NAME
}

const SNAPSHOT_NAME = getSnapshotName()
const SNAPSHOT_FILENAME = `${SNAPSHOT_NAME}.snapshot`

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

/**
 * 对集合名称进行 URL 编码，以便在 REST API 路径中使用。
 * 处理可能导致路径问题的特殊字符。
 */
function encodeCollectionName(name: string): string {
  return encodeURIComponent(name)
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

async function findQdrantContainer(): Promise<{
  name: string
  port: number
} | null> {
  try {
    // 容器存储在 ~/.spindb/containers/{引擎}/{名称}/container.json
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const qdrantContainersDir = join(homeDir, '.spindb', 'containers', 'qdrant')

    if (!existsSync(qdrantContainersDir)) {
      return null
    }

    // 读取所有容器目录
    const { readdir } = await import('fs/promises')
    const containerDirs = await readdir(qdrantContainersDir, {
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
        qdrantContainersDir,
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

    // 查找第一个正在运行的 Qdrant 容器
    const runningContainer = containers.find((c) => c.status === 'running')
    if (runningContainer) {
      return { name: runningContainer.name, port: runningContainer.port }
    }

    // 如果没有运行中的容器，尝试使用任意一个 Qdrant 容器
    if (containers.length > 0) {
      return { name: containers[0].name, port: containers[0].port }
    }

    return null
  } catch {
    return null
  }
}

async function checkQdrantHealth(port: number): Promise<boolean> {
  try {
    const response = await qdrantRequest(port, 'GET', '/healthz')
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
          'qdrant',
          'snapshots',
        )
        if (!existsSync(fixturesDir)) {
          mkdirSync(fixturesDir, { recursive: true })
        }
        return join(fixturesDir, SNAPSHOT_FILENAME)
      }
    }
  } catch (error) {
    console.warn('警告：无法读取 package.json：', error)
  }

  // 默认：保存到当前目录
  return join(cwd, SNAPSHOT_FILENAME)
}

async function main() {
  console.log('Qdrant 快照生成器')
  console.log('=========================\n')

  // 查找 Qdrant 容器
  console.log('正在查找 Qdrant 容器...')
  const container = await findQdrantContainer()

  if (!container) {
    console.error(
      '错误：未找到 Qdrant 容器。\n' +
        '请先创建并启动一个 Qdrant 容器：\n' +
        '  spindb create my-qdrant --engine qdrant\n' +
        '  spindb start my-qdrant',
    )
    process.exit(1)
  }

  console.log(`找到容器：${container.name}（端口 ${container.port}）`)

  // 检查 Qdrant 是否响应
  console.log('正在检查 Qdrant 健康状态...')
  const isHealthy = await checkQdrantHealth(container.port)

  if (!isHealthy) {
    console.error(
      `错误：Qdrant 在端口 ${container.port} 上无响应。\n` +
        '请确保容器正在运行：\n' +
        `  spindb start ${container.name}`,
    )
    process.exit(1)
  }

  console.log('Qdrant 健康\n')

  const port = container.port

  // 如果集合存在，则删除
  console.log(`正在清理现有的 ${COLLECTION_NAME} 集合...`)
  const encodedName = encodeCollectionName(COLLECTION_NAME)
  await qdrantRequest(port, 'DELETE', `/collections/${encodedName}`)

  // 创建集合
  console.log(`正在创建 ${COLLECTION_NAME} 集合...`)
  const createResponse = await qdrantRequest(
    port,
    'PUT',
    `/collections/${encodedName}`,
    { vectors: TEST_DATA.vectors },
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`创建集合时出错：${error}`)
    process.exit(1)
  }

  // 插入测试点
  console.log(`正在插入 ${TEST_DATA.points.length} 个测试点...`)
  const insertResponse = await qdrantRequest(
    port,
    'PUT',
    `/collections/${encodedName}/points`,
    { points: TEST_DATA.points },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`插入点数据时出错：${error}`)
    process.exit(1)
  }

  // 验证数据
  const infoResponse = await qdrantRequest(
    port,
    'GET',
    `/collections/${encodedName}`,
  )
  const info = (await infoResponse.json()) as {
    result: { points_count: number }
  }
  console.log(`已验证：集合中有 ${info.result.points_count} 个点\n`)

  // 创建快照
  console.log('正在创建快照（这可能需要一些时间）...')
  const snapshotResponse = await qdrantRequest(
    port,
    'POST',
    `/collections/${encodedName}/snapshots`,
  )

  if (!snapshotResponse.ok) {
    const error = await snapshotResponse.text()
    console.error(`创建快照时出错：${error}`)
    process.exit(1)
  }

  const snapshotResult = (await snapshotResponse.json()) as {
    result: { name: string; size: number }
  }
  const snapshotName = snapshotResult.result.name
  const snapshotSize = snapshotResult.result.size

  console.log(`快照已创建：${snapshotName}`)
  console.log(`大小：${(snapshotSize / 1024 / 1024).toFixed(1)} MB\n`)

  // 下载快照
  const outputPath = await getOutputPath()
  console.log(`正在下载快照到：${outputPath}`)

  const downloadResponse = await fetch(
    `http://127.0.0.1:${port}/collections/${encodedName}/snapshots/${encodeURIComponent(snapshotName)}`,
  )

  if (!downloadResponse.ok || !downloadResponse.body) {
    console.error('下载快照时出错')
    process.exit(1)
  }

  // 使用管道将下载内容写入文件
  const fileStream = createWriteStream(outputPath)
  await pipeline(downloadResponse.body, fileStream)

  console.log('下载完成！\n')

  // 清理 - 删除集合
  console.log(`正在清理 ${COLLECTION_NAME} 集合...`)
  await qdrantRequest(port, 'DELETE', `/collections/${encodedName}`)

  // 从 Qdrant 中删除快照（我们已有本地副本）
  // 注意：如果集合在上面已被删除，此操作可能因 Qdrant 自动删除其子快照而返回 404。
  // 这是预期行为，错误将被有意忽略。
  await qdrantRequest(
    port,
    'DELETE',
    `/collections/${encodedName}/snapshots/${encodeURIComponent(snapshotName)}`,
  ).catch(() => {})

  console.log('\n完成！')
  console.log(`快照已保存到：${outputPath}`)
  console.log('\n你可以使用此快照来测试 Qdrant 的还原功能：')
  console.log(`  spindb restore <容器名称> "${outputPath}"`)

  if (SNAPSHOT_NAME !== DEFAULT_SNAPSHOT_NAME) {
    console.log(`\n注意：使用了自定义快照名称 "${SNAPSHOT_NAME}"。`)
  }
}

main().catch((error) => {
  console.error('错误：', error)
  process.exit(1)
})
