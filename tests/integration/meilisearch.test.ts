/**
 * Meilisearch 系统集成测试
 *
 * 使用真实的 Meilisearch 进程测试完整的容器生命周期。
 * Meilisearch 是一个带有 REST API 的全文搜索引擎。
 *
 * TODO: 一旦我们有了包含远程 Meilisearch 实例的测试环境
 * （例如，通过 CI 中的 Docker Compose），就添加 dumpFromConnectionString 的集成测试。
 * 目前，连接字符串解析在 unit/meilisearch-restore.test.ts 中测试。
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getMeilisearchIndexCount,
  createMeilisearchIndex,
  insertMeilisearchDocuments,
  getMeilisearchDocumentCount,
  waitForMeilisearchTask,
  waitForReady,
  waitForStopped,
  containerDataExists,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import {
  getDefaultUsername,
  saveCredentials,
} from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Meilisearch
const DATABASE = 'default' // Meilisearch 使用索引，而非传统数据库
const TEST_INDEX = 'test_documents'
const TEST_VERSION = '1' // 主版本号 - 将通过版本映射解析为完整版本
const IS_WINDOWS = process.platform === 'win32'

// Meilisearch 在 Windows 上有一个 bug，创建快照时会失败：
// "map size must be a multiple of the system page size"
// 在 Meilisearch 修复此上游问题之前，跳过 Windows 上的备份/恢复测试。
const SKIP_BACKUP_ON_WINDOWS = IS_WINDOWS
  ? 'Meilisearch snapshot creation has a bug on Windows (page size alignment)'
  : false

describe('Meilisearch Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n 清理中，删除所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    // Meilisearch 使用单一端口（无 gRPC），因此只需要 3 个端口
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.meilisearch.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('meilisearch-test')
    clonedContainerName = generateTestName('meilisearch-test-clone')
    renamedContainerName = generateTestName('meilisearch-test-renamed')
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

    // 确保 Meilisearch 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 Meilisearch 二进制文件可用...')
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
      '容器状态应为 \'created\'',
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

    // 等待 Meilisearch 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Meilisearch 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('should create index and insert data', async () => {
    console.log(`\n 创建索引并插入测试数据...`)

    // 创建测试索引
    const createResult = await createMeilisearchIndex(
      testPorts[0],
      TEST_INDEX,
      'id',
    )
    assert(createResult.success, '应该创建索引')

    // 等待索引创建完成（异步操作）
    if (createResult.taskUid !== undefined) {
      const taskComplete = await waitForMeilisearchTask(
        testPorts[0],
        createResult.taskUid,
      )
      assert(taskComplete, '索引创建任务应该完成')
    } else {
      // 回退：如果没有 taskUid，等待异步处理完成
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // 插入一些测试文档
    const documents = [
      { id: 1, title: 'Hello World', content: 'This is the first document' },
      { id: 2, title: 'Second Post', content: 'This is another document' },
      { id: 3, title: 'Third Entry', content: 'Yet another test document' },
    ]
    const insertResult = await insertMeilisearchDocuments(
      testPorts[0],
      TEST_INDEX,
      documents,
    )
    assert(insertResult.success, '应该插入文档')

    // 等待任务完成
    if (insertResult.taskUid !== undefined) {
      const taskComplete = await waitForMeilisearchTask(
        testPorts[0],
        insertResult.taskUid,
      )
      assert(taskComplete, '文档插入任务应该完成')
    } else {
      // 回退：如果没有 taskUid，等待异步处理完成
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    // 验证索引数量
    const indexCount = await getMeilisearchIndexCount(testPorts[0])
    assertEqual(indexCount, 1, '应该有 1 个索引')

    // 验证文档数量
    const docCount = await getMeilisearchDocumentCount(testPorts[0], TEST_INDEX)
    assertEqual(docCount, 3, '应该有 3 个文档')

    console.log(`   已创建包含 ${docCount} 个文档的索引`)
  })

  it('should query data using executeQuery (REST API)', async () => {
    logDebug('使用 engine.executeQuery 查询数据（REST API）...')

    // 测试 GET indexes（REST API 查询格式：METHOD /path）
    // Meilisearch 返回 { results: [...], offset: 0, limit: 20, total: N }
    const indexesResult = await executeQuery(containerName, 'GET /indexes')

    // 验证返回了索引
    assertEqual(indexesResult.rowCount, 1, '应该有一个结果对象')
    assertTruthy(
      indexesResult.columns.length > 0,
      '结果中应该有列',
    )

    // 测试获取索引统计信息
    const statsResult = await executeQuery(
      containerName,
      `GET /indexes/${TEST_INDEX}/stats`,
    )

    assertEqual(statsResult.rowCount, 1, '应该返回统计信息')

    // 测试带请求体的 POST 搜索
    // 搜索返回包含 hits、query 等的完整响应对象
    const searchResult = await executeQuery(
      containerName,
      `POST /indexes/${TEST_INDEX}/search {"q": "document"}`,
    )

    // Meilisearch 搜索直接将 hits 作为行返回（从 'hits' 数组解析）
    // 所有 3 个文档都包含 "document" 一词
    assertTruthy(searchResult.rowCount > 0, '搜索应该返回命中结果')

    logDebug(`REST API 查询返回了包含 ${searchResult.rowCount} 个命中结果的索引`)
  })

  it(
    'should backup and restore with master-key auth enabled',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
      console.log('\n 测试认证支持的 Meilisearch 备份/恢复...')

      const authPorts = await findConsecutiveFreePorts(
        2,
        TEST_PORTS.meilisearch.base + 20,
      )
      const [sourcePort, targetPort] = authPorts
      const sourceName = generateTestName('meilisearch-auth-source-test')
      const targetName = generateTestName('meilisearch-auth-target-test')
      const username = getDefaultUsername(ENGINE)
      const sourceMasterKey = 'meili-source-master-key-12345'
      const targetMasterKey = 'meili-target-master-key-67890'
      const { tmpdir } = await import('os')
      const { rm } = await import('fs/promises')
      const backupPath = `${tmpdir()}/meilisearch-auth-backup-${Date.now()}.snapshot`
      const engine = getEngine(ENGINE)

      try {
        await containerManager.create(sourceName, {
          engine: ENGINE,
          version: TEST_VERSION,
          port: sourcePort,
          database: DATABASE,
        })
        await engine.initDataDir(sourceName, TEST_VERSION, {
          port: sourcePort,
        })

        const sourceConfig = await containerManager.getConfig(sourceName)
        assert(sourceConfig !== null, '源容器配置应该存在')
        await engine.start(sourceConfig!)
        await containerManager.updateConfig(sourceName, { status: 'running' })

        const sourceReady = await waitForReady(ENGINE, sourcePort)
        assert(sourceReady, '源 Meilisearch 应该就绪')

        const createResult = await createMeilisearchIndex(
          sourcePort,
          TEST_INDEX,
          'id',
        )
        assert(createResult.success, '应该创建源索引')
        if (createResult.taskUid !== undefined) {
          const taskComplete = await waitForMeilisearchTask(
            sourcePort,
            createResult.taskUid,
          )
          assert(taskComplete, '源索引创建任务应该完成')
        }

        const insertResult = await insertMeilisearchDocuments(
          sourcePort,
          TEST_INDEX,
          [
            { id: 1, title: 'Alpha', content: 'alpha document' },
            { id: 2, title: 'Beta', content: 'beta document' },
          ],
        )
        assert(insertResult.success, '应该插入源文档')
        if (insertResult.taskUid !== undefined) {
          const taskComplete = await waitForMeilisearchTask(
            sourcePort,
            insertResult.taskUid,
          )
          assert(taskComplete, '源文档插入任务应该完成')
        }

        const sourceCreds = await engine.createUser(sourceConfig!, {
          username,
          password: sourceMasterKey,
        })
        await saveCredentials(sourceName, ENGINE, sourceCreds)

        const sourceAuthedReady = await waitForReady(ENGINE, sourcePort)
        assert(
          sourceAuthedReady,
          '启用认证后源 Meilisearch 应该就绪',
        )

        await engine.backup(sourceConfig!, backupPath, {
          database: DATABASE,
          format: 'snapshot',
        })

        await containerManager.create(targetName, {
          engine: ENGINE,
          version: TEST_VERSION,
          port: targetPort,
          database: DATABASE,
        })
        await engine.initDataDir(targetName, TEST_VERSION, {
          port: targetPort,
        })

        const targetConfig = await containerManager.getConfig(targetName)
        assert(targetConfig !== null, '目标容器配置应该存在')

        const targetCreds = await engine.createUser(targetConfig!, {
          username,
          password: targetMasterKey,
        })
        await saveCredentials(targetName, ENGINE, targetCreds)

        await engine.restore(targetConfig!, backupPath, {
          database: DATABASE,
        })
        await engine.start(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'running' })

        const targetReady = await waitForReady(ENGINE, targetPort)
        assert(targetReady, '恢复后目标 Meilisearch 应该就绪')

        const searchResult = await executeQuery(
          targetName,
          `POST /indexes/${TEST_INDEX}/search {"q": "document"}`,
        )
        assertTruthy(
          searchResult.rowCount > 0,
          '启用认证的 Meilisearch 恢复应保留可搜索的文档',
        )
      } finally {
        for (const cleanupName of [sourceName, targetName]) {
          const config = await containerManager.getConfig(cleanupName)
          if (config) {
            await engine.stop(config).catch(() => {})
            await waitForStopped(cleanupName, ENGINE).catch(() => false)
            await containerManager.delete(cleanupName, { force: true }).catch(
              () => {},
            )
          }
        }
        await rm(backupPath, { force: true })
      }
    },
  )

  it(
    'should clone container using backup/restore',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
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

      // 从源容器创建备份
      const { tmpdir } = await import('os')
      const backupPath = `${tmpdir()}/meilisearch-test-backup-${Date.now()}.snapshot`

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
      const stopped = await waitForStopped(containerName, ENGINE, 60000)
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
      assert(ready, '克隆的 Meilisearch 应该就绪')

      // 清理备份文件
      const { rm } = await import('fs/promises')
      await rm(backupPath, { force: true })

      console.log('   容器已通过备份/恢复克隆')
    },
  )

  it(
    'should verify cloned data matches source',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
      console.log('\n 验证克隆的数据与源匹配...')

      // 验证克隆容器上的索引数量
      const indexCount = await getMeilisearchIndexCount(testPorts[1])
      assertEqual(indexCount, 1, '克隆容器应该有 1 个索引')

      // 验证克隆容器上的文档数量
      const docCount = await getMeilisearchDocumentCount(
        testPorts[1],
        TEST_INDEX,
      )
      assertEqual(docCount, 3, '克隆容器应该有 3 个文档')

      console.log(
        `   克隆数据已验证: ${indexCount} 个索引, ${docCount} 个文档`,
      )
    },
  )

  it('should stop and rename container', async () => {
    console.log(`\n 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 如果容器正在运行则停止（可能已从前一个测试停止）
    const engine = getEngine(ENGINE)
    const isRunning = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    if (isRunning) {
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
    }

    // 始终等待容器完全停止
    const stopped = await waitForStopped(containerName, ENGINE, 60000)
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

  it(
    'should delete cloned container',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
      console.log(`\n 删除克隆容器 "${clonedContainerName}"...`)

      const config = await containerManager.getConfig(clonedContainerName)
      if (config) {
        const engine = getEngine(ENGINE)
        await engine.stop(config)
        await waitForStopped(clonedContainerName, ENGINE, 60000)
      }

      await containerManager.delete(clonedContainerName, { force: true })

      // 验证文件系统已清理
      const exists = containerDataExists(clonedContainerName, ENGINE)
      assert(!exists, '容器数据目录应该已删除')

      console.log('   克隆容器已删除')
    },
  )

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
    console.log(`\n 验证中没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
