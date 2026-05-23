/**
 * Weaviate 系统集成测试
 *
 * 使用真实 Weaviate 进程测试完整的容器生命周期。
 * Weaviate 是一个 AI 原生向量数据库，具有 REST/GraphQL 和 gRPC API。
 *
 * TODO: 一旦我们拥有远程 Weaviate 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 添加 dumpFromConnectionString 的集成测试。
 * 目前，连接字符串解析在 unit/weaviate-restore.test.ts 中测试。
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getWeaviateClassCount,
  createWeaviateClass,
  insertWeaviateObjects,
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

const ENGINE = Engine.Weaviate
const DATABASE = 'default' // Weaviate 使用类/集合，而非传统数据库
const TEST_CLASS = 'TestVectors'
const TEST_VERSION = '1' // 主版本 - 将通过版本映射解析为完整版本
const IS_WINDOWS = process.platform === 'win32'

// Weaviate 在 Windows 上持有 LSM 文件锁，阻止备份期间的 fsync，
// 导致"访问被拒绝"错误。在 Windows 上跳过备份/恢复测试。
const SKIP_BACKUP_ON_WINDOWS = IS_WINDOWS
  ? 'Weaviate 备份在 Windows 上因 LSM 文件锁定而失败（访问被拒绝）'
  : false

describe('Weaviate 集成测试', () => {
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
    // Weaviate 使用 HTTP 端口 +1 作为 gRPC，因此每个容器需要 2 个端口
    // 请求 6 个连续端口并每隔一个使用，以避免 gRPC 冲突
    const allPorts = await findConsecutiveFreePorts(6, TEST_PORTS.weaviate.base)
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(
      `   使用端口: ${testPorts.join(', ')}（gRPC 在各自 +1 端口）`,
    )

    containerName = generateTestName('weaviate-test')
    clonedContainerName = generateTestName('weaviate-test-clone')
    renamedContainerName = generateTestName('weaviate-test-renamed')
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  it('应该创建容器但不启动 (--no-start)', async () => {
    console.log(`\n 创建容器 "${containerName}" 但不启动...`)

    // 首先确保 Weaviate 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 Weaviate 二进制文件可用...')
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

  it('应该启动容器', async () => {
    console.log(`\n 启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 Weaviate 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Weaviate 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应该创建类并插入数据', async () => {
    console.log(`\n 创建类并插入测试数据...`)

    // 创建测试类
    const created = await createWeaviateClass(testPorts[0], TEST_CLASS)
    assert(created, '应该创建类')

    // 插入一些测试对象
    const objects = [
      {
        properties: { content: 'test object 1' },
        vector: [0.1, 0.2, 0.3, 0.4],
      },
      {
        properties: { content: 'test object 2' },
        vector: [0.2, 0.3, 0.4, 0.5],
      },
      {
        properties: { content: 'test object 3' },
        vector: [0.3, 0.4, 0.5, 0.6],
      },
    ]
    const inserted = await insertWeaviateObjects(
      testPorts[0],
      TEST_CLASS,
      objects,
    )
    assert(inserted, '应该插入对象')

    // 验证类计数
    const classCount = await getWeaviateClassCount(testPorts[0])
    assertEqual(classCount, 1, '应该有 1 个类')

    console.log(`   已创建包含测试对象的类`)
  })

  it('应该使用 executeQuery (REST API) 查询数据', async () => {
    logDebug('使用 engine.executeQuery (REST API) 查询数据...')

    // 测试 GET schema（REST API 查询格式：METHOD /path）
    const schemaResult = await executeQuery(containerName, 'GET /v1/schema')

    // 验证 schema 已返回
    assertEqual(schemaResult.rowCount, 1, '应该有一个结果对象')
    assertTruthy(
      schemaResult.columns.includes('classes'),
      '结果中应该有 classes',
    )

    // 测试 GET 类信息
    const classResult = await executeQuery(
      containerName,
      `GET /v1/schema/${TEST_CLASS}`,
    )

    assertEqual(classResult.rowCount, 1, '应该返回类信息')

    logDebug(`REST API 查询返回了 schema 信息`)
  })

  it(
    '应该使用备份/恢复克隆容器',
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

      // 从源创建备份（备份是目录，不是单个文件）
      const { tmpdir } = await import('os')
      const backupPath = `${tmpdir()}/weaviate-test-backup-${Date.now()}`

      const sourceConfig = await containerManager.getConfig(containerName)
      assert(sourceConfig !== null, '源容器配置应该存在')

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'snapshot',
      })

      // 停止源以进行恢复（恢复需要容器已停止）
      await engine.stop(sourceConfig!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })

      // 等待容器完全停止
      const stopped = await waitForStopped(containerName, ENGINE, 90000)
      assert(stopped, '恢复前源容器应该已完全停止')

      // 恢复到克隆容器（将备份目录复制到克隆的备份路径中）
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
      assert(ready, '克隆的 Weaviate 应该就绪')

      // 通过 Weaviate API 触发恢复
      // 从 backup_config.json 读取真实备份 ID（Weaviate 验证匹配）
      const { readFile } = await import('fs/promises')
      const { join: joinPath } = await import('path')
      const backupConfigPath = joinPath(backupPath, 'backup_config.json')
      const backupConfig = JSON.parse(
        await readFile(backupConfigPath, 'utf-8'),
      ) as { id: string }
      const backupId = backupConfig.id
      console.log(`   使用配置中的备份 ID: ${backupId}`)

      // Weaviate 在恢复到不同节点主机名时需要 node_mapping
      const sourceHostname = `node-${testPorts[0]}`
      const targetHostname = `node-${testPorts[1]}`
      const restoreResponse = await fetch(
        `http://127.0.0.1:${testPorts[1]}/v1/backups/filesystem/${backupId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_mapping: { [sourceHostname]: targetHostname },
          }),
        },
      )
      if (!restoreResponse.ok) {
        const errorText = await restoreResponse.text()
        console.log(
          `   恢复 API 响应: ${restoreResponse.status} - ${errorText}`,
        )
        console.log(`   备份 ID: ${backupId}`)
      }
      assert(restoreResponse.ok, '恢复 API 调用应该成功')

      // 等待恢复完成
      let restored = false
      let finalStatus = ''
      for (let i = 0; i < 30; i++) {
        const statusResp = await fetch(
          `http://127.0.0.1:${testPorts[1]}/v1/backups/filesystem/${backupId}/restore`,
        )
        if (statusResp.ok) {
          const status = (await statusResp.json()) as { status: string }
          finalStatus = status.status
          if (finalStatus === 'SUCCESS') {
            restored = true
            break
          }
          if (finalStatus === 'FAILED') {
            throw new Error('Restore failed')
          }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      assert(
        restored,
        `恢复应该已完成（最后状态："${finalStatus || '无响应'}"）`,
      )

      // 清理备份目录
      const { rm } = await import('fs/promises')
      await rm(backupPath, { recursive: true, force: true })

      console.log('   容器已通过备份/恢复克隆')
    },
  )

  it('应该停止并重命名容器', async () => {
    console.log(`\n 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 如果正在运行则停止容器（可能已从之前的测试中停止）
    const engine = getEngine(ENGINE)
    const isRunning = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    if (isRunning) {
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
    }

    // 始终等待容器完全停止
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

  it(
    '应该使用 API-key 认证备份并成功恢复',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
      console.log('\n 测试认证支持的 Weaviate 备份/恢复...')

      const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.weaviate.base + 20)
      const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
      const sourceName = generateTestName('weaviate-auth-test-source')
      const targetName = generateTestName('weaviate-auth-test-target')
      const username = getDefaultUsername(ENGINE)
      const sourceApiKey = 'weaviate-source-key-123'
      const targetApiKey = 'weaviate-target-key-456'
      const { tmpdir } = await import('os')
      const { rm, readFile } = await import('fs/promises')
      const { join: joinPath } = await import('path')
      const backupPath = `${tmpdir()}/weaviate-auth-backup-${Date.now()}`
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
        assert(sourceReady, '源 Weaviate 应该就绪')

        const created = await createWeaviateClass(sourcePort, TEST_CLASS)
        assert(created, '应该创建源类')
        const inserted = await insertWeaviateObjects(sourcePort, TEST_CLASS, [
          {
            properties: { content: 'alpha document' },
            vector: [0.1, 0.2, 0.3],
          },
          {
            properties: { content: 'beta document' },
            vector: [0.4, 0.5, 0.6],
          },
        ])
        assert(inserted, '应该插入源对象')

        const sourceCreds = await engine.createUser(sourceConfig!, {
          username,
          password: sourceApiKey,
        })
        await saveCredentials(sourceName, ENGINE, sourceCreds)

        const sourceAuthedReady = await waitForReady(ENGINE, sourcePort)
        assert(sourceAuthedReady, '认证重启后源 Weaviate 应该就绪')

        await containerManager.create(targetName, {
          engine: ENGINE,
          version: TEST_VERSION,
          port: targetPort,
          database: DATABASE,
        })
        await engine.initDataDir(targetName, TEST_VERSION, { port: targetPort })

        const targetConfig = await containerManager.getConfig(targetName)
        assert(targetConfig !== null, '目标容器配置应该存在')
        await engine.start(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'running' })

        const targetReady = await waitForReady(ENGINE, targetPort)
        assert(targetReady, '认证配置前目标 Weaviate 应该就绪')

        const targetCreds = await engine.createUser(targetConfig!, {
          username,
          password: targetApiKey,
        })
        await saveCredentials(targetName, ENGINE, targetCreds)

        const targetAuthedReady = await waitForReady(ENGINE, targetPort)
        assert(targetAuthedReady, '认证重启后目标 Weaviate 应该就绪')

        await engine.stop(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'stopped' })
        const targetStopped = await waitForStopped(targetName, ENGINE, 90000)
        assert(targetStopped, '恢复复制前目标应该停止')

        await engine.backup(sourceConfig!, backupPath, {
          database: DATABASE,
          format: 'snapshot',
        })

        await engine.restore(targetConfig!, backupPath, {
          database: DATABASE,
        })

        await engine.start(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'running' })
        const restoredReady = await waitForReady(ENGINE, targetPort)
        assert(restoredReady, '恢复后目标 Weaviate 应该就绪')

        const backupConfigPath = joinPath(backupPath, 'backup_config.json')
        const backupConfig = JSON.parse(
          await readFile(backupConfigPath, 'utf-8'),
        ) as { id: string }
        const backupId = backupConfig.id

        const sourceHostname = `node-${sourcePort}`
        const targetHostname = `node-${targetPort}`
        const restoreResponse = await fetch(
          `http://127.0.0.1:${targetPort}/v1/backups/filesystem/${backupId}/restore`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${targetCreds.apiKey}`,
            },
            body: JSON.stringify({
              node_mapping: { [sourceHostname]: targetHostname },
            }),
          },
        )
        assert(restoreResponse.ok, '认证支持的恢复 API 调用应该成功')

        let restored = false
        for (let attempt = 0; attempt < 30; attempt++) {
          const statusResp = await fetch(
            `http://127.0.0.1:${targetPort}/v1/backups/filesystem/${backupId}/restore`,
            {
              headers: { Authorization: `Bearer ${targetCreds.apiKey}` },
            },
          )
          if (statusResp.ok) {
            const status = (await statusResp.json()) as { status: string }
            if (status.status === 'SUCCESS') {
              restored = true
              break
            }
            if (status.status === 'FAILED') {
              throw new Error('Weaviate restore failed')
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        assert(restored, 'Weaviate 认证支持的恢复应该完成')

        const queryResult = await engine.executeQuery(
          targetConfig!,
          `GET /v1/objects?class=${TEST_CLASS}&limit=10`,
          {
            password: targetCreds.apiKey,
          },
        )
        const restoredObjects =
          (queryResult.rows[0] as { objects?: unknown[] } | undefined)
            ?.objects ?? []
        assertEqual(
          restoredObjects.length,
          2,
          '应该使用 API key 查询恢复的对象',
        )

        console.log('   API-key Weaviate 备份/恢复成功')
      } finally {
        await rm(backupPath, { recursive: true, force: true }).catch(() => {})

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
    },
  )

  it('应该删除克隆容器', async () => {
    console.log(`\n 删除克隆容器 "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (!config) {
      // 克隆测试已跳过（例如在 Windows 上），无需删除
      console.log('   克隆容器不存在（克隆测试已跳过）')
      return
    }

    const engine = getEngine(ENGINE)
    await engine.stop(config)
    await waitForStopped(clonedContainerName, ENGINE, 90000)

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    console.log('   克隆容器已删除')
  })

  it('应该使用 --force 删除重命名容器', async () => {
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

  it('不应该有测试容器残留', async () => {
    console.log(`\n 验证中没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
