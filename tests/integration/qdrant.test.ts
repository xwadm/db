/**
 * Qdrant 系统集成测试
 *
 * 使用真实 Qdrant 进程测试完整的容器生命周期。
 * Qdrant 是一个向量相似性搜索引擎。
 *
 * TODO: 一旦我们拥有远程 Qdrant 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 就添加 dumpFromConnectionString 的集成测试。
 * 目前，连接字符串解析在 unit/qdrant-restore.test.ts 中测试。
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getQdrantCollectionCount,
  createQdrantCollection,
  insertQdrantPoints,
  getQdrantPointCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { getDefaultUsername, saveCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Qdrant
const DATABASE = 'default' // Qdrant 使用 collection，而非传统数据库
const TEST_COLLECTION = 'test_vectors'
const TEST_VERSION = '1' // 主版本号 - 将通过版本映射解析为完整版本

describe('Qdrant Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n 清理中，清理所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    // Qdrant 使用 HTTP 端口 +1 作为 gRPC 端口，因此每个容器需要 2 个端口
    // 请求 6 个连续端口并每隔一个使用一个，以避免 gRPC 冲突
    const allPorts = await findConsecutiveFreePorts(6, TEST_PORTS.qdrant.base)
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(
      `   使用端口: ${testPorts.join(', ')} (gRPC 各自 +1)`,
    )

    containerName = generateTestName('qdrant-test')
    clonedContainerName = generateTestName('qdrant-test-clone')
    renamedContainerName = generateTestName('qdrant-test-renamed')
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  it('should create container without starting (--no-start)', async () => {
    console.log(`\n 创建容器但不启动 "${containerName}"...`)

    // 确保 Qdrant 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 Qdrant 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // 初始化数据目录
    await engine.initDataDir(containerName, TEST_VERSION, {
      port: testPorts[0],
    })

    // 验证容器存在但未运行
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')
    assertEqual(
      config?.status,
      'created',
      'Container status should be "created"',
    )

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, '容器不应该正在运行')

    console.log('   容器已创建但未运行')
  })

  it('should start the container', async () => {
    console.log(`\n 启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 Qdrant 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Qdrant 应该就绪，可以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('should create collection and insert data', async () => {
    console.log(`\n 创建集合并插入测试数据...`)

    // 创建测试 collection
    const created = await createQdrantCollection(
      testPorts[0],
      TEST_COLLECTION,
      4,
    )
    assert(created, '应该创建集合')

    // 插入一些测试点
    const points = [
      { id: 1, vector: [0.1, 0.2, 0.3, 0.4], payload: { name: 'test1' } },
      { id: 2, vector: [0.2, 0.3, 0.4, 0.5], payload: { name: 'test2' } },
      { id: 3, vector: [0.3, 0.4, 0.5, 0.6], payload: { name: 'test3' } },
    ]
    const inserted = await insertQdrantPoints(
      testPorts[0],
      TEST_COLLECTION,
      points,
    )
    assert(inserted, '应该插入点')

    // 验证 collection 数量
    const collectionCount = await getQdrantCollectionCount(testPorts[0])
    assertEqual(collectionCount, 1, 'Should have 1 collection')

    // 验证点数量
    const pointCount = await getQdrantPointCount(testPorts[0], TEST_COLLECTION)
    assertEqual(pointCount, 3, 'Should have 3 points')

    console.log(`   已创建包含 ${pointCount} 个点的集合`)
  })

  it('should query data using executeQuery (REST API)', async () => {
    logDebug('使用 engine.executeQuery (REST API) 查询数据...')

    // 测试 GET collections（REST API 查询格式：METHOD /path）
    const collectionsResult = await executeQuery(
      containerName,
      'GET /collections',
    )

    // 验证返回了 collections（Qdrant 返回 { result: { collections: [...] } }）
    assertEqual(collectionsResult.rowCount, 1, 'Should have one result object')
    assertTruthy(
      collectionsResult.columns.includes('collections'),
      'Should have collections in result',
    )

    // 测试 GET collection 信息
    const collectionResult = await executeQuery(
      containerName,
      `GET /collections/${TEST_COLLECTION}`,
    )

    assertEqual(collectionResult.rowCount, 1, 'Should return collection info')

    // 测试 POST scroll 获取点
    const scrollResult = await executeQuery(
      containerName,
      `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
    )

    assertEqual(scrollResult.rowCount, 1, 'Should return scroll results')
    // 验证我们获取到了点
    const scrollData = scrollResult.rows[0] as Record<string, unknown>
    const points = scrollData.points as unknown[]
    assertEqual(points.length, 3, 'Should have 3 points')

    logDebug(`REST API 查询返回了包含 ${points.length} 个点的集合`)
  })

  it('should clone container using backup/restore', async (t) => {
    if (process.platform === 'win32') {
      t.skip(
        'Qdrant 快照恢复在 Windows 上尚不稳定；克隆/恢复仍在 Unix 运行器上覆盖。',
      )
      return
    }

    console.log(
      `\n 通过备份/恢复创建容器 "${clonedContainerName}"...`,
    )

    // 创建并初始化克隆容器
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {
      port: testPorts[1],
    })

    // 从源创建备份
    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/qdrant-test-backup-${Date.now()}.snapshot`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'snapshot',
    })

    // 停止源容器以进行恢复（恢复需要容器已停止）
    await engine.stop(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止
    // 在 Windows 上使用更长的超时时间以释放端口/文件
    const stopped = await waitForStopped(containerName, ENGINE, 90000)
    assert(stopped, '恢复前源容器应该已完全停止')

    // 恢复到克隆容器
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器配置应该存在')

    await engine.restore(clonedConfig!, backupPath, {
      database: DATABASE,
    })

    // 启动克隆容器
    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, '克隆的 Qdrant 应该就绪')

    // 清理备份文件
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    // 注意：我们不会在这里重新启动源容器，因为：
    // 1. 在 Windows 上，TCP TIME_WAIT 可能在进程终止后保持端口占用数分钟
    // 2. 备份/恢复已通过克隆成功启动得到验证
    // 3. 下一个测试将处理源容器（重命名为不同端口）

    console.log('   容器已通过备份/恢复克隆')
  })

  it('should stop and rename container', async () => {
    console.log(`\n 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 如果容器正在运行则停止（可能已从上一个测试停止）
    const engine = getEngine(ENGINE)
    const isRunning = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    if (isRunning) {
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
    }

    // 始终等待容器完全停止，即使已经停止
    // 这确保在重命名之前释放文件句柄（尤其在 Windows 上）
    const stopped = await waitForStopped(containerName, ENGINE, 120000)
    assert(stopped, '重命名前容器应该已完全停止')

    // 重命名容器并更改端口
    await containerManager.rename(containerName, renamedContainerName)
    await containerManager.updateConfig(renamedContainerName, {
      port: testPorts[2],
    })

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应该存在')
    assertEqual(newConfig?.port, testPorts[2], '端口应该已更新')

    console.log(
      `   已重命名为 "${renamedContainerName}"，端口 ${testPorts[2]}`,
    )
  })

  it('should backup with auth-enabled source and restore successfully', async (t) => {
    if (process.platform === 'win32') {
      t.skip(
        'Qdrant 认证支持的快照恢复在 Windows 上尚不稳定；恢复覆盖仍在 Unix 运行器上进行。',
      )
      return
    }

    console.log(`\n🔐 测试认证感知的 Qdrant 备份/恢复...`)

    const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.qdrant.base + 20)
    const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
    const sourceName = generateTestName('qdrant-auth-test-source')
    const targetName = generateTestName('qdrant-auth-test-target')
    const username = getDefaultUsername(ENGINE)
    const sourceApiKey = 'qdrant-auth-key-123'
    const targetApiKey = 'qdrant-auth-key-456'
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = `${tmpdir()}/qdrant-auth-backup-${Date.now()}.snapshot`
    const engine = getEngine(ENGINE)

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, { port: sourcePort })

      const sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应该存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceReady, '源 Qdrant 应该就绪')

      const created = await createQdrantCollection(
        sourcePort,
        TEST_COLLECTION,
        4,
      )
      assert(created, 'Should create source collection')

      const inserted = await insertQdrantPoints(sourcePort, TEST_COLLECTION, [
        { id: 1, vector: [0.1, 0.2, 0.3, 0.4], payload: { name: 'test1' } },
        { id: 2, vector: [0.2, 0.3, 0.4, 0.5], payload: { name: 'test2' } },
        { id: 3, vector: [0.3, 0.4, 0.5, 0.6], payload: { name: 'test3' } },
      ])
      assert(inserted, 'Should insert source points')

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: sourceApiKey,
        database: DATABASE,
      })
      await saveCredentials(sourceName, ENGINE, sourceCreds)

      const authedReady = await waitForReady(ENGINE, sourcePort)
      assert(authedReady, '启用认证的源 Qdrant 应该就绪')

      const authResult = await engine.executeQuery(
        sourceConfig!,
        `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
        {
          username: sourceCreds.username,
          password: sourceCreds.apiKey,
        },
      )
      const authRow = authResult.rows[0] as Record<string, unknown>
      const authPoints = authRow.points as unknown[]
      assertEqual(authPoints.length, 3, 'Auth query should see 3 source points')

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, { port: targetPort })

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target container config should exist')
      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: targetApiKey,
        database: DATABASE,
      })
      await saveCredentials(targetName, ENGINE, targetCreds)

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'snapshot',
      })

      await engine.stop(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'stopped' })
      const sourceStopped = await waitForStopped(sourceName, ENGINE, 90000)
      assert(sourceStopped, '恢复前源应该已停止')

      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(targetReady, '恢复后目标 Qdrant 应该就绪')

      let restoredPointCount = 0
      for (let attempt = 0; attempt < 30; attempt++) {
        const restoredResult = await engine.executeQuery(
          targetConfig!,
          `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
          {
            username: targetCreds.username,
            password: targetCreds.apiKey,
          },
        )
        const restoredRow = restoredResult.rows[0] as Record<string, unknown>
        const restoredPoints = restoredRow.points as unknown[]
        restoredPointCount = restoredPoints.length
        if (restoredPointCount === 3) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assertEqual(
        restoredPointCount,
        3,
        '恢复的 Qdrant 集合应该有 3 个点',
      )

      console.log(
        '   ✓ 备份在启用认证的 Qdrant 源上正常工作，恢复保留了数据',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      if (sourceConfig) {
        await engine.stop(sourceConfig).catch(() => {})
        await waitForStopped(sourceName, ENGINE, 90000).catch(() => false)
        await containerManager.delete(sourceName, { force: true }).catch(
          () => {},
        )
      }

      const targetConfig = await containerManager.getConfig(targetName)
      if (targetConfig) {
        await engine.stop(targetConfig).catch(() => {})
        await waitForStopped(targetName, ENGINE, 90000).catch(() => false)
        await containerManager.delete(targetName, { force: true }).catch(
          () => {},
        )
      }
    }
  })

  it('should delete cloned container', async () => {
    console.log(`\n 删除克隆容器 "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (!config) {
      console.log('   克隆容器不存在，跳过删除')
      return
    }

    const engine = getEngine(ENGINE)
    await engine.stop(config)
    // 在 Windows 上使用更长的超时时间以释放端口/文件
    await waitForStopped(clonedContainerName, ENGINE, 90000)

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    console.log('   克隆容器已删除')
  })

  it('should delete renamed container with --force', async () => {
    console.log(`\n 强制删除容器 "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应在列表中')

    console.log('   容器已强制删除')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n 验证中，验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
