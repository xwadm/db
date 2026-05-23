/**
 * TigerBeetle 系统集成测试
 *
 * 使用真实 TigerBeetle 进程测试完整的容器生命周期。
 * TigerBeetle 是一个高性能金融账本数据库，使用
 * 自定义二进制协议（无 REST/SQL）。
 *
 * 注意：没有通过 REST/SQL 的数据操作测试（自定义二进制协议）。
 * REPL 连接通过验证进程是否正确生成来测试。
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  waitForReady,
  waitForStopped,
  containerDataExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.TigerBeetle
const DATABASE = 'default' // TigerBeetle 没有数据库概念
const TEST_VERSION = '0.16'

describe('TigerBeetle 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n 清理中：清理所有现有的测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.tigerbeetle.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('tigerbeetle-test')
    renamedContainerName = generateTestName('tigerbeetle-test-renamed')
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

    // 首先确保 TigerBeetle 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 TigerBeetle 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // 初始化数据目录（运行 tigerbeetle format）
    await engine.initDataDir(containerName, TEST_VERSION, {
      port: testPorts[0],
    })

    // 验证容器存在但未运行
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')
    assertEqual(
      config?.status,
      'created',
      '容器状态应为 "created"',
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

    // 等待 TigerBeetle 就绪（TCP 端口检查）
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'TigerBeetle 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('should report correct status', async () => {
    console.log(`\n 检查容器状态...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    const status = await engine.status(config!)
    assert(status.running, '状态应指示正在运行')
    assert(status.message.length > 0, '状态消息不应为空')

    console.log('   状态已验证为正在运行')
  })

  it('should get connection string', async () => {
    console.log(`\n 获取连接字符串...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    const connString = engine.getConnectionString(config!)
    assert(
      connString.includes(String(testPorts[0])),
      '连接字符串应包含端口',
    )
    assert(
      connString.includes('127.0.0.1'),
      '连接字符串应包含主机',
    )

    console.log(`   连接字符串: ${connString}`)
  })

  it('should stop and backup container (stop-and-copy)', async () => {
    console.log(`\n 备份容器...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    // 停止容器（TigerBeetle 备份需要）
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    const stopped = await waitForStopped(containerName, ENGINE, 30000)
    assert(stopped, '容器应该已完全停止')

    // 创建备份
    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/tigerbeetle-test-backup-${Date.now()}.tigerbeetle`

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    // 验证备份文件存在
    const { existsSync } = await import('fs')
    assert(existsSync(backupPath), '备份文件应该存在')

    // 重启容器
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'TigerBeetle 重启后应该就绪')

    // 清理备份
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   备份已成功完成')
  })

  it('should stop and rename container', async () => {
    console.log(`\n 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    const stopped = await waitForStopped(containerName, ENGINE, 30000)
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
    console.log(`\n 验证中：确认没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
