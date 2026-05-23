/**
 * CouchDB 系统集成测试
 *
 * 使用真实的 CouchDB 进程测试完整的容器生命周期。
 * CouchDB 是一个基于 REST API 的文档数据库。
 *
 * TODO: 一旦有了包含远程 CouchDB 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 就为 dumpFromConnectionString 添加集成测试。
 * 目前，连接字符串解析在 unit/couchdb-restore.test.ts 中进行了测试。
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getCouchDBDatabaseCount,
  createCouchDBDatabase,
  insertCouchDBDocuments,
  getCouchDBDocumentCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.CouchDB
const DATABASE = 'test_db'
const TEST_VERSION = '3' // 主版本号 - 将通过版本映射解析为完整版本

describe('CouchDB 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n 正在清理现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    console.log('\n 正在查找可用的测试端口...')
    // CouchDB 使用单个端口（HTTP API），因此我们只需要 3 个端口
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.couchdb.base)
    console.log(`   使用端口：${testPorts.join(', ')}`)

    containerName = generateTestName('couchdb-test')
    clonedContainerName = generateTestName('couchdb-test-clone')
    renamedContainerName = generateTestName('couchdb-test-renamed')
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }
  })

  it('应创建容器但不启动（--no-start）', async () => {
    console.log(`\n 正在创建容器 "${containerName}" 但不启动...`)

    // 首先确保 CouchDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 CouchDB 二进制文件可用...')
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
    assert(config !== null, '容器配置应存在')
    assertEqual(config?.status, 'created', '容器状态应为“created”')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, '容器不应处于运行状态')

    console.log('   容器已创建且未运行')
  })

  it('应启动容器', async () => {
    console.log(`\n 正在启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 CouchDB 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'CouchDB 应准备好接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应创建数据库并插入数据', async () => {
    console.log(`\n 正在创建数据库并插入测试数据...`)

    // 创建测试数据库
    const createResult = await createCouchDBDatabase(testPorts[0], DATABASE)
    assert(createResult, '应成功创建数据库')

    // 插入一些测试文档
    const documents = [
      { _id: 'user1', name: 'Alice', age: 30 },
      { _id: 'user2', name: 'Bob', age: 25 },
      { _id: 'user3', name: 'Charlie', age: 35 },
      { _id: 'user4', name: 'Diana', age: 28 },
      { _id: 'user5', name: 'Eve', age: 32 },
    ]
    const insertResult = await insertCouchDBDocuments(
      testPorts[0],
      DATABASE,
      documents,
    )
    assert(insertResult, '应成功插入文档')

    // 验证数据库数量（应至少有 1 个用户创建的数据库）
    const dbCount = await getCouchDBDatabaseCount(testPorts[0])
    assert(dbCount >= 1, '应至少有 1 个数据库')

    // 验证文档数量
    const docCount = await getCouchDBDocumentCount(testPorts[0], DATABASE)
    assertEqual(docCount, 5, '应有 5 个文档')

    console.log(`   已创建包含 ${docCount} 个文档的数据库`)
  })

  it('应使用 executeQuery（REST API）查询数据', async () => {
    console.log(`\n 正在使用 engine.executeQuery（REST API）查询数据...`)

    // 测试获取所有数据库（REST API 查询格式：METHOD /path）
    // CouchDB 返回数据库名称数组
    const dbsResult = await executeQuery(containerName, 'GET /_all_dbs')

    // 验证返回了数据库（字符串数组 -> 行具有 'value' 列）
    assertTruthy(dbsResult.rowCount > 0, '应有数据库查询结果')

    // 测试获取我们数据库中所有文档
    // CouchDB _all_docs 返回 { rows: [...] }，解析器直接提取行
    const docsResult = await executeQuery(
      containerName,
      `GET /${DATABASE}/_all_docs?include_docs=true`,
    )

    // 解析器直接从 CouchDB 响应中提取 rows 数组
    assertEqual(docsResult.rowCount, 5, '应有 5 个文档')

    // 测试获取特定文档
    const docResult = await executeQuery(
      containerName,
      `GET /${DATABASE}/user1`,
    )

    assertEqual(docResult.rowCount, 1, '应返回文档')
    const docData = docResult.rows[0] as Record<string, unknown>
    assertEqual(docData.name, 'Alice', '文档应为 Alice')

    console.log(
      `   REST API 查询返回了包含 ${docsResult.rowCount} 个文档的数据库`,
    )
  })

  it('应创建用户并在重新创建时更新密码', async () => {
    console.log(`\n👤 正在测试 createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)

    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', '用户名应匹配')
    assertEqual(creds1.password, 'firstpass123', '密码应匹配')
    console.log('   ✓ 已创建用户并设置初始密码')

    // 在 409 冲突时，应获取 _rev 并更新
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', '密码应已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等操作）')
  })

  it('应通过备份/恢复克隆容器', async () => {
    console.log(`\n 正在通过备份/恢复创建容器 "${clonedContainerName}"...`)

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
    const backupPath = `${tmpdir()}/couchdb-test-backup-${Date.now()}.json`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'json',
    })

    // 先启动克隆容器（CouchDB 恢复需要正在运行的实例）
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器的配置应存在')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const clonedReady = await waitForReady(ENGINE, testPorts[1])
    assert(clonedReady, '克隆出的 CouchDB 在恢复前应已就绪')

    // 恢复到克隆容器
    await engine.restore(clonedConfig!, backupPath, {
      database: DATABASE,
    })

    // 清理备份文件
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   已通过备份/恢复克隆容器')
  })

  it('应验证克隆数据与源数据匹配', async () => {
    console.log('\n 正在验证克隆数据与源数据匹配...')

    // 验证克隆容器上的数据库存在
    const dbCount = await getCouchDBDatabaseCount(testPorts[1])
    assert(dbCount >= 1, '克隆出的容器应至少有 1 个数据库')

    // 验证克隆容器上的文档数量
    const docCount = await getCouchDBDocumentCount(testPorts[1], DATABASE)
    assertEqual(docCount, 5, '克隆出的容器应有 5 个文档')

    console.log(`   克隆数据已验证：${dbCount} 个数据库，${docCount} 个文档`)
  })

  it('应停止并重命名容器', async () => {
    console.log(`\n 正在重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 如果容器正在运行，则停止它
    const engine = getEngine(ENGINE)
    const isRunning = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    if (isRunning) {
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
    }

    // 总是等待容器完全停止
    const stopped = await waitForStopped(containerName, ENGINE, 60000)
    assert(stopped, '重命名前容器应完全停止')

    // 重命名容器并更改端口
    await containerManager.rename(containerName, renamedContainerName)
    await containerManager.updateConfig(renamedContainerName, {
      port: testPorts[2],
    })

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名称不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应存在')
    assertEqual(newConfig?.port, testPorts[2], '端口应已更新')

    console.log(`   已重命名为 "${renamedContainerName}"，端口 ${testPorts[2]}`)
  })

  it('应删除克隆容器', async () => {
    console.log(`\n 正在删除克隆容器 "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (config) {
      const engine = getEngine(ENGINE)
      await engine.stop(config)
      await waitForStopped(clonedContainerName, ENGINE, 60000)
    }

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    console.log('   克隆容器已删除')
  })

  it('应使用 --force 删除重命名后的容器', async () => {
    console.log(`\n 正在强制删除容器 "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证已不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   容器已强制删除')
  })

  it('应使用密码认证的本地管理员凭证进行备份和恢复', async () => {
    console.log(`\n🔐 正在测试本地容器上带认证的 CouchDB 备份/恢复...`)

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.couchdb.base + 40,
    )
    const sourceName = generateTestName('couchdb-auth-test-source')
    const targetName = generateTestName('couchdb-auth-test-target')
    const sourceAdmin = { username: 'sourceadmin', password: 'sourcepass123' }
    const targetAdmin = { username: 'targetadmin', password: 'targetpass456' }
    const documents = [
      { _id: 'user1', name: 'Alice', age: 30 },
      { _id: 'user2', name: 'Bob', age: 25 },
      { _id: 'user3', name: 'Charlie', age: 35 },
      { _id: 'user4', name: 'Diana', age: 28 },
      { _id: 'user5', name: 'Eve', age: 32 },
    ]
    const { tmpdir } = await import('os')
    const { mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `couchdb-auth-backup-${Date.now()}.json`)
    const engine = getEngine(ENGINE)

    const writeDefaultCredentialFile = async (
      containerName: string,
      port: number,
      username: string,
      password: string,
    ) => {
      const credentialsDir = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'credentials',
      )
      await mkdir(credentialsDir, { recursive: true })
      const connectionString = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          `DB_USER=${username}`,
          `DB_PASSWORD=${password}`,
          'DB_HOST=127.0.0.1',
          `DB_PORT=${port}`,
          `DB_NAME=${DATABASE}`,
          `DB_URL=${connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const restartWithAdminAuth = async (
      containerName: string,
      port: number,
      auth: { username: string; password: string },
    ) => {
      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '容器配置应存在')

      await writeDefaultCredentialFile(
        containerName,
        port,
        auth.username,
        auth.password,
      )
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })

      const stopped = await waitForStopped(containerName, ENGINE, 60000)
      assert(stopped, '启用认证重启前容器应停止')

      const restartedConfig = await containerManager.getConfig(containerName)
      assert(restartedConfig !== null, '重启后的配置应存在')
      await engine.start(restartedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      assert(await waitForReady(ENGINE, port), '启用认证的容器应已就绪')
    }

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

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), '源容器应已就绪')
      assert(
        await createCouchDBDatabase(sourcePort, DATABASE),
        '应成功创建源数据库',
      )
      assert(
        await insertCouchDBDocuments(sourcePort, DATABASE, documents),
        '应成功插入源文档',
      )
      await restartWithAdminAuth(sourceName, sourcePort, sourceAdmin)

      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器认证配置应存在')
      const sourceRows = await engine.executeQuery(
        sourceConfig!,
        `GET /${DATABASE}/_all_docs?include_docs=true`,
      )
      assertEqual(
        sourceRows.rowCount,
        documents.length,
        '启用认证的源容器应仍可查询',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, {
        port: targetPort,
      })

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), '目标容器应已就绪')
      await restartWithAdminAuth(targetName, targetPort, targetAdmin)

      const backupResult = await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
      })
      assertEqual(backupResult.format, 'json', '备份应使用 JSON 格式')

      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器认证配置应存在')
      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
        flush: true,
      })

      const restoredRows = await engine.executeQuery(
        targetConfig!,
        `GET /${DATABASE}/_all_docs?include_docs=true`,
      )
      assertEqual(
        restoredRows.rowCount,
        documents.length,
        '对启用认证的目标容器进行恢复应成功',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      for (const containerName of [sourceName, targetName]) {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager
            .isRunning(containerName, {
              engine: ENGINE,
            })
            .catch(() => false)
          if (running) {
            await engine.stop(config).catch(() => {})
            await containerManager
              .updateConfig(containerName, { status: 'stopped' })
              .catch(() => {})
          }
        }
        await containerManager
          .delete(containerName, { force: true })
          .catch(() => {})
      }
    }

    console.log('   ✓ 备份和恢复在使用密码认证的 CouchDB 上正常工作')
  })

  it('应确认没有残留的测试容器', async () => {
    console.log(`\n 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
