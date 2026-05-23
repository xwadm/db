/**
 * QuestDB 系统集成测试
 *
 * 使用真实 QuestDB 进程测试完整的容器生命周期。
 * QuestDB 是一个高性能时序数据库，支持 PostgreSQL 线协议。
 *
 * 注意：QuestDB 使用单一数据库 'qdb' - 无需创建数据库。
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

import {
  TEST_PORTS,
  TEST_VERSIONS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getRowCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { saveCredentials } from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { isWindows } from '../../core/platform-service'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.QuestDB
const DATABASE = 'qdb' // QuestDB 默认数据库
const SEED_FILE = join(__dirname, '../fixtures/questdb/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5 // 5 个用户行
const TEST_VERSION = TEST_VERSIONS.questdb

describe('QuestDB Integration Tests', () => {
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
    // QuestDB 使用多个端口（PostgreSQL: 8812, HTTP: 9000, ILP: 9009）
    // 每个容器预留 4 个端口以避免冲突
    const allPorts = await findConsecutiveFreePorts(12, TEST_PORTS.questdb.base)
    testPorts = [allPorts[0], allPorts[4], allPorts[8]]
    console.log(`   使用 PostgreSQL 端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('questdb-test')
    clonedContainerName = generateTestName('questdb-test-clone')
    renamedContainerName = generateTestName('questdb-test-renamed')
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

    // 确保 QuestDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 QuestDB 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    // QuestDB 使用 PostgreSQL 线协议 - 确保 psql 可用
    const pgEngine = getEngine(Engine.PostgreSQL)
    console.log('   正在确保 PostgreSQL 二进制文件可用（用于 psql）...')
    await pgEngine.ensureBinaries('17', ({ message }) => {
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

    // 等待 QuestDB 就绪（慢速 CI 运行器使用 90 秒超时）
    const ready = await waitForReady(ENGINE, testPorts[0], 150000)
    assert(ready, 'QuestDB 应该就绪，可以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(`\n 正在用示例数据填充数据库，使用 engine.runScript...`)

    // 使用 runScriptFile，它内部调用 engine.runScript
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    // QuestDB 使用 WAL 缓冲 - 轮询直到数据提交
    // Windows CI 刷新 WAL 可能明显更慢
    let rowCount = 0
    const maxWaitMs = 15000
    const startTime = Date.now()
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      rowCount = await getRowCount(ENGINE, testPorts[0], DATABASE, 'test_user')
      if (rowCount >= EXPECTED_ROW_COUNT) break
    }

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '填充后应有正确的行数',
    )

    console.log(`   已使用 engine.runScript 填充 ${rowCount} 行`)
  })

  it('should clone container using backup/restore', async () => {
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

    // 先启动克隆容器（SQL 恢复需要）
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器配置应该存在')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1], 150000)
    assert(ready, '恢复前克隆的 QuestDB 应该就绪')

    // 从源创建备份
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `questdb-test-backup-${Date.now()}.sql`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      // 恢复到克隆容器
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })

      // 给 QuestDB 时间提交恢复的数据 - 时序数据库使用 WAL 缓冲
      await new Promise((resolve) => setTimeout(resolve, 1000))
    } finally {
      // 即使恢复失败也清理备份文件
      await rm(backupPath, { force: true })
    }

    console.log('   容器已通过备份/恢复克隆')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n 验证恢复的数据...`)

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '恢复的数据应有相同的行数',
    )

    console.log(`   已在恢复的容器中验证 ${rowCount} 行`)
  })

  it('should prefer saved admin credentials over legacy generic credentials', async () => {
    console.log('\n 测试认证支持的 QuestDB 备份/恢复...')

    const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.questdb.base + 20)
    const targetPort = allPorts[2]
    const targetName = generateTestName('questdb-auth-target')
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `questdb-auth-backup-${Date.now()}.sql`)
    const engine = getEngine(ENGINE)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源 QuestDB 配置应该存在')

    const sourceAdminCreds = {
      username: 'admin',
      password: 'quest',
      connectionString: `postgresql://admin:quest@127.0.0.1:${testPorts[0]}/${DATABASE}`,
      engine: ENGINE,
      container: containerName,
      database: DATABASE,
    }
    const sourceLegacyCreds = {
      username: 'spindb',
      password: 'wrongpass',
      connectionString: `postgresql://spindb:wrongpass@127.0.0.1:${testPorts[0]}/${DATABASE}`,
      engine: ENGINE,
      container: containerName,
      database: DATABASE,
    }

    try {
      await saveCredentials(containerName, ENGINE, sourceAdminCreds)
      await saveCredentials(containerName, ENGINE, sourceLegacyCreds)

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
      assert(targetConfig !== null, 'Target QuestDB config should exist')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, {
        status: 'running',
      })

      const targetReady = await waitForReady(ENGINE, targetPort, 150000)
      assert(targetReady, '恢复前目标 QuestDB 应该就绪')

      const targetAdminCreds = {
        username: 'admin',
        password: 'quest',
        connectionString: `postgresql://admin:quest@127.0.0.1:${targetPort}/${DATABASE}`,
        engine: ENGINE,
        container: targetName,
        database: DATABASE,
      }
      const targetLegacyCreds = {
        username: 'spindb',
        password: 'wrongpass',
        connectionString: `postgresql://spindb:wrongpass@127.0.0.1:${targetPort}/${DATABASE}`,
        engine: ENGINE,
        container: targetName,
        database: DATABASE,
      }
      await saveCredentials(targetName, ENGINE, targetAdminCreds)
      await saveCredentials(targetName, ENGINE, targetLegacyCreds)

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      await new Promise((resolve) => setTimeout(resolve, 1000))

      const restored = await engine.executeQuery(
        targetConfig!,
        'SELECT count(*) AS count FROM test_user',
        {
          database: DATABASE,
        },
      )
      assertEqual(restored.rowCount, 1, 'Should return one count row')
      assertEqual(
        Number(restored.rows[0].count),
        EXPECTED_ROW_COUNT,
        'QuestDB 恢复应忽略损坏的旧版凭据并使用管理员凭据',
      )

      console.log('   已保存的 QuestDB 管理员凭据已成功使用')
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

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

  it('should stop and delete the restored container', async () => {
    console.log(`\n 停止并删除已恢复的容器 "${clonedContainerName}"...`)

    // 在 Windows 上跳过 - QuestDB 的 Java 进程在终止后长时间持有文件锁
    // 导致删除操作出现 EBUSY 错误
    if (isWindows()) {
      console.log(
        '   ⚠️  在 Windows 上跳过删除测试（已知的文件锁定问题）',
      )

      // 只停止容器，不尝试删除
      const config = await containerManager.getConfig(clonedContainerName)
      if (config) {
        const engine = getEngine(ENGINE)
        await engine.stop(config)
        await waitForStopped(clonedContainerName, ENGINE)
      }
      return
    }

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)

    // 等待容器完全停止
    const stopped = await waitForStopped(clonedContainerName, ENGINE)
    assert(stopped, '删除前容器应该已完全停止')

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    // 验证不在容器列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === clonedContainerName)
    assert(!found, '容器不应在列表中')

    console.log('   容器已删除，文件系统已清理')
  })

  it('should modify data using runScript inline command', async () => {
    console.log(
      `\n 使用 engine.runScript 内联命令插入一行...`,
    )

    // QuestDB 不支持 DELETE - 它是一个仅追加的时序数据库
    // 改为测试 QuestDB 支持的 INSERT
    // 使用 runScriptSQL，它内部调用 engine.runScript 并带 --sql 选项
    await runScriptSQL(
      containerName,
      "INSERT INTO test_user (id, name, email, created_at) VALUES (6, 'Test User 6', 'test6@example.com', now());",
      DATABASE,
    )

    // QuestDB 使用 WAL 缓冲 - 轮询直到数据提交
    let rowCount = 0
    const maxWaitMs = 15000
    const startTime = Date.now()
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      rowCount = await getRowCount(ENGINE, testPorts[0], DATABASE, 'test_user')
      if (rowCount >= EXPECTED_ROW_COUNT + 1) break
    }

    // 现在应该有 6 行（5 行来自填充 + 1 行来自插入）
    assertEqual(rowCount, EXPECTED_ROW_COUNT + 1, 'Should have one more row')

    console.log(
      `   已使用 engine.runScript 插入行，现有 ${rowCount} 行`,
    )
  })

  it('should stop, rename container, and change port', async () => {
    console.log(`\n 停止、重命名容器并更改端口...`)

    // 在 Windows 上跳过 - QuestDB 的 Java 进程在终止后长时间持有文件锁
    // 导致重命名操作出现 EBUSY 错误
    if (isWindows()) {
      console.log(
        '   ⚠️  在 Windows 上跳过重命名测试（已知的文件锁定问题）',
      )

      // 只停止容器，不尝试重命名
      const config = await containerManager.getConfig(containerName)
      if (config) {
        const engine = getEngine(ENGINE)
        await engine.stop(config)
        await waitForStopped(containerName, ENGINE)
      }
      return
    }

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 停止容器
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止（PID 文件已删除）
    const stopped = await waitForStopped(containerName, ENGINE)
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

  it('should verify data persists after rename', async () => {
    console.log(`\n 验证重命名后数据持久化...`)

    // 在 Windows 上，重命名被跳过，因此使用原始容器名
    const testContainer = isWindows() ? containerName : renamedContainerName
    const testPort = isWindows() ? testPorts[0] : testPorts[2]

    const config = await containerManager.getConfig(testContainer)
    if (!config) {
      console.log('   容器未找到 - 跳过')
      return
    }

    // 启动容器
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(testContainer, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPort, 150000)
    assert(ready, 'QuestDB 应该就绪')

    // 验证行数反映了插入（5 + 1 = 6）
    const rowCount = await getRowCount(ENGINE, testPort, DATABASE, 'test_user')
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT + 1,
      '重命名后行数应保持不变',
    )

    console.log(`   数据已持久化: ${rowCount} 行`)
  })

  it('should show warning when starting already running container', async () => {
    console.log(`\n 测试端口冲突处理...`)

    // 在 Windows 上，重命名被跳过，因此使用原始容器名
    const testContainer = isWindows() ? containerName : renamedContainerName

    const config = await containerManager.getConfig(testContainer)
    if (!config) {
      console.log('   容器未找到 - 跳过')
      return
    }

    const engine = getEngine(ENGINE)

    // 现在容器应该正在运行
    const running = await processManager.isRunning(testContainer, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    // 再次尝试启动不应抛出错误（幂等行为）
    await engine.start(config)

    // 应该仍在运行
    const stillRunning = await processManager.isRunning(testContainer, {
      engine: ENGINE,
    })
    assert(
      stillRunning,
      '重复启动后容器应该仍在运行',
    )

    console.log(
      '   容器已在运行（重复启动已优雅处理）',
    )
  })

  it('should handle stopping already stopped container gracefully', async () => {
    console.log(`\n 测试停止已停止的容器...`)

    // 在 Windows 上，重命名被跳过，因此使用原始容器名
    const testContainer = isWindows() ? containerName : renamedContainerName

    const config = await containerManager.getConfig(testContainer)
    if (!config) {
      console.log('   容器未找到 - 跳过')
      return
    }

    const engine = getEngine(ENGINE)

    // 先停止容器
    await engine.stop(config)
    await containerManager.updateConfig(testContainer, {
      status: 'stopped',
    })

    // 等待容器完全停止
    const stopped = await waitForStopped(testContainer, ENGINE)
    assert(stopped, '容器应该已完全停止')

    // 现在已停止，验证
    const running = await processManager.isRunning(testContainer, {
      engine: ENGINE,
    })
    assert(!running, '容器应该已停止')

    // 再次尝试停止不应抛出错误（幂等行为）
    await engine.stop(config)

    // 仍然停止
    const stillStopped = await processManager.isRunning(testContainer, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      '重复停止后容器应该仍然停止',
    )

    console.log('   重复停止已优雅处理（幂等）')
  })

  it('should delete container with --force', async () => {
    // 在 Windows 上，重命名被跳过，因此使用原始容器名
    const testContainer = isWindows() ? containerName : renamedContainerName
    console.log(`\n 强制删除容器 "${testContainer}"...`)

    // 在 Windows 上跳过删除 - QuestDB 的 Java 进程持有文件锁
    if (isWindows()) {
      console.log(
        '   ⚠️  在 Windows 上跳过删除测试（已知的文件锁定问题）',
      )
      return
    }

    const config = await containerManager.getConfig(testContainer)
    if (!config) {
      console.log('   容器未找到 - 跳过删除测试')
      return
    }

    await containerManager.delete(testContainer, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(testContainer, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === testContainer)
    assert(!found, '容器不应在列表中')

    console.log('   容器已强制删除')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n 验证中，验证没有测试容器残留...`)

    // 在 Windows 上，由于文件锁定问题跳过了删除测试
    // 因此预期会有残留容器
    if (isWindows()) {
      console.log(
        '   ⚠️  在 Windows 上跳过清理验证（删除测试已跳过）',
      )
      return
    }

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
