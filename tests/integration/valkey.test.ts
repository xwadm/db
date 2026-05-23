/**
 * Valkey 系统集成测试
 *
 * 使用真实 Valkey 进程测试完整的容器生命周期。
 * Valkey 是一个 Redis 分支，具有完全的协议兼容性。
 *
 * TODO: 一旦我们拥有远程 Valkey 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 添加 dumpFromConnectionString 的集成测试。
 * 目前，连接字符串解析在 unit/valkey-restore.test.ts 中测试。
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getValkeyKeyCount,
  getValkeyValue,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.Valkey
const DATABASE = '0' // Valkey 使用编号数据库 0-15（与 Redis 相同）
const SEED_FILE = join(__dirname, '../fixtures/valkey/seeds/sample-db.valkey')
const EXPECTED_KEY_COUNT = 6 // 5 个用户键 + 1 个 user:count 键
const TEST_VERSION = '9' // 主版本 - 将通过版本映射解析为完整版本

describe('Valkey 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n 清理中，删除所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.valkey.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('valkey-test')
    clonedContainerName = generateTestName('valkey-test-clone')
    renamedContainerName = generateTestName('valkey-test-renamed')
    portConflictContainerName = generateTestName('valkey-test-conflict')
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

    // 首先确保 Valkey 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 Valkey 二进制文件可用...')
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
    await engine.initDataDir(containerName, TEST_VERSION, {})

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

    // 等待 Valkey 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Valkey 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应该使用 runScript 用测试数据填充数据库', async () => {
    console.log(`\n 使用 engine.runScript 用测试数据填充数据库...`)

    // 使用 runScriptFile，它内部调用 engine.runScript
    // 这测试了 spindb run 命令功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const keyCount = await getValkeyKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      '填充后应有正确的键数',
    )

    console.log(`   已填充 ${keyCount} 个键，使用 engine.runScript`)
  })

  it('应该创建用户并在重新创建时更新密码', async () => {
    console.log(`\n👤 测试 createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
    })
    assertEqual(creds1.username, 'testuser', '用户名应该匹配')
    assertEqual(creds1.password, 'firstpass123', '密码应该匹配')
    console.log('   ✓ 已使用初始密码创建用户')

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
    })
    assertEqual(creds2.password, 'secondpass456', '密码应该已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等）')
  })

  it('应该使用备份/恢复克隆容器', async () => {
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
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {})

    // 从源创建备份
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `valkey-test-backup-${Date.now()}.rdb`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'rdb',
    })

    // 停止源以进行恢复（恢复需要容器已停止）
    await engine.stop(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止
    const stopped = await waitForStopped(containerName, ENGINE)
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
    assert(ready, '克隆的 Valkey 应该就绪')

    // 清理备份文件
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    // 重启源容器
    await engine.start(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待源容器就绪
    const sourceReady = await waitForReady(ENGINE, testPorts[0])
    assert(sourceReady, '重启后源 Valkey 应该就绪')

    console.log('   容器已通过备份/恢复克隆')
  })

  it('应该验证恢复的数据与源匹配', async () => {
    console.log(`\n 验证恢复的数据...`)

    const keyCount = await getValkeyKeyCount(testPorts[1], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      '恢复的数据应有相同的键数',
    )

    // 验证特定值
    const userCount = await getValkeyValue(testPorts[1], DATABASE, 'user:count')
    assertEqual(userCount, '5', '用户数应为 5')

    console.log(`   已在恢复的容器中验证 ${keyCount} 个键`)
  })

  it('应该停止并删除已恢复的容器', async () => {
    console.log(`\n 删除已恢复的容器 "${clonedContainerName}"...`)

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

  // ============================================
  // 文本格式备份/恢复测试 (.valkey)
  // ============================================

  it('应该备份为文本格式 (.valkey)', async () => {
    console.log(`\n 测试文本格式备份 (.valkey)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `valkey-text-backup-${Date.now()}.valkey`)

    // 使用 'text' 格式备份，生成 .valkey 文本文件
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'text',
    })

    assert(result.path === backupPath, '备份路径应该匹配')
    assert(result.format === 'text', '格式应为 text')
    assert(result.size > 0, '备份应该有内容')

    // 验证文件包含 Valkey 命令（与 Redis 相同）
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assert(content.includes('SET user:'), '备份应包含 SET 命令')
    assert(
      content.includes('user:count'),
      '备份应包含 user:count 键',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   文本备份已创建，大小 ${result.size} 字节`)
  })

  it('应该使用合并模式从文本格式恢复', async () => {
    console.log(`\n 测试文本格式恢复（合并模式）...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 首先，添加一个不在备份文件中的键
    await runScriptSQL(
      containerName,
      'SET extra:key "should-persist"',
      DATABASE,
    )

    // 创建文本备份
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `valkey-merge-test-${Date.now()}.valkey`)

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'text',
    })

    // 修改一个键以验证它会被恢复
    await runScriptSQL(containerName, 'SET user:count 999', DATABASE)

    // 验证修改
    let userCount = await getValkeyValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '999', 'user:count 应该已被修改')

    // 使用合并模式恢复（flush: false）
    await engine.restore(config!, backupPath, {
      database: DATABASE,
      flush: false,
    })

    // 验证恢复的值
    userCount = await getValkeyValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '5', 'user:count 应该恢复为 5')

    // 验证额外键仍然存在（合并模式保留现有键）
    const extraKey = await getValkeyValue(testPorts[0], DATABASE, 'extra:key')
    assertEqual(
      extraKey,
      'should-persist',
      '额外键应在合并模式下保留',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })
    await runScriptSQL(containerName, 'DEL extra:key', DATABASE)

    console.log('   文本恢复合并模式保留现有键')
  })

  it('应该使用替换模式从文本格式恢复 (FLUSHDB)', async () => {
    console.log(`\n 测试文本格式恢复（替换模式，使用 FLUSHDB）...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 首先创建文本备份
    const { tmpdir } = await import('os')
    const backupPath = join(
      tmpdir(),
      `valkey-replace-test-${Date.now()}.valkey`,
    )

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'text',
    })

    // 添加一个不在备份中的键
    await runScriptSQL(
      containerName,
      'SET extra:key "should-be-deleted"',
      DATABASE,
    )

    // 验证额外键存在
    let extraKey = await getValkeyValue(testPorts[0], DATABASE, 'extra:key')
    assertEqual(
      extraKey,
      'should-be-deleted',
      '恢复前额外键应该存在',
    )

    // 使用替换模式恢复（flush: true）- 先运行 FLUSHDB
    await engine.restore(config!, backupPath, {
      database: DATABASE,
      flush: true,
    })

    // 验证额外键已消失（FLUSHDB 清除了它）
    extraKey = await getValkeyValue(testPorts[0], DATABASE, 'extra:key')
    assert(
      extraKey === null || extraKey === '',
      '额外键应被 FLUSHDB 删除',
    )

    // 验证备份数据已恢复
    const keyCount = await getValkeyKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(keyCount, EXPECTED_KEY_COUNT, '应有原始键数')

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   文本恢复替换模式清除现有数据')
  })

  it('应该检测无 .valkey 扩展名文件中的 Valkey 命令', async () => {
    console.log(`\n 测试基于内容的格式检测...`)

    const engine = getEngine(ENGINE)

    // 创建一个包含 Valkey 命令但扩展名为 .txt 的文件
    const { tmpdir } = await import('os')
    const { writeFile, rm } = await import('fs/promises')
    const testFile = join(tmpdir(), `valkey-commands-${Date.now()}.txt`)

    await writeFile(
      testFile,
      'SET test:key "value"\nSET test:key2 "value2"\n',
      'utf-8',
    )

    // 检测格式 - 应识别为 Valkey 文本命令
    const format = await engine.detectBackupFormat(testFile)
    assertEqual(
      format.format,
      'text',
      '应通过内容检测到 Valkey 命令',
    )
    assert(
      format.description.includes('detected by content'),
      '描述应提及内容检测',
    )

    // 清理
    await rm(testFile, { force: true })

    console.log(
      '   基于内容的检测适用于无 .valkey 扩展名的文件',
    )
  })

  it('应该使用 runScript 内联命令修改数据', async () => {
    console.log(
      `\n 删除一个键，使用 engine.runScript 内联命令...`,
    )

    // 使用 runScriptSQL，它内部使用 --sql 选项调用 engine.runScript
    // 对于 Valkey，sql 实际上是 Redis 兼容命令
    await runScriptSQL(containerName, 'DEL user:5', DATABASE)

    const keyCount = await getValkeyKeyCount(testPorts[0], DATABASE, 'user:*')
    // 现在应该有 5 个键（user:count + user:1 到 user:4）
    assertEqual(keyCount, EXPECTED_KEY_COUNT - 1, '应该少一个键')

    console.log(
      `   已使用 engine.runScript 删除键，现有 ${keyCount} 个键`,
    )
  })

  it('应该停止、重命名容器并更改端口', async () => {
    console.log(`\n 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 停止容器
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止（PID 文件已删除）
    // 这很重要，因为 rename() 在继续之前会检查 isRunning()
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

  it('应该验证重命名后数据持久化', async () => {
    console.log(`\n 验证重命名后数据持久化...`)

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应该存在')

    // 启动重命名后的容器
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[2])
    assert(ready, '重命名的 Valkey 应该就绪')

    // 验证键数反映删除
    const keyCount = await getValkeyKeyCount(testPorts[2], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT - 1,
      '重命名后键数应保持不变',
    )

    console.log(`   数据已持久化: ${keyCount} 个键`)
  })

  it('应该优雅处理端口冲突', async () => {
    console.log(`\n⚠️  测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器 (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 此端口被重命名后的容器使用
        database: '1', // 不同的数据库以避免混淆
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

      // 容器应该被创建，但当我们尝试启动时，应该检测到冲突
      // 在实际使用中，start 命令会自动分配新端口
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, '容器应该被创建')
      assertEqual(
        config?.port,
        testPorts[2],
        '端口最初应设置为冲突端口',
      )

      console.log(
        '   ✓ 容器已使用冲突端口创建（启动时会自动重新分配）',
      )
    } finally {
      // 即使测试失败也要清理此测试容器
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // 清理期间忽略错误（如果创建失败容器可能不存在）
        })
    }
  })

  it('启动已运行容器时应该显示警告', async () => {
    console.log(`\n 测试启动已运行容器...`)

    // 容器应该从之前的测试中已在运行
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    // 再次尝试启动不应抛出异常
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    // 这应该在不抛出异常的情况下完成（幂等行为）
    await engine.start(config!)

    // 应该仍在运行
    const stillRunning = await processManager.isRunning(renamedContainerName, {
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

  it('应该优雅处理停止已停止的容器', async () => {
    console.log(`\n 测试停止已停止的容器...`)

    // 首先停止容器
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'stopped',
    })

    // 等待容器完全停止
    const stopped = await waitForStopped(renamedContainerName, ENGINE)
    assert(stopped, '容器应该已完全停止')

    // 现在已停止，验证
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, '容器应该已停止')

    // 再次尝试停止不应抛出异常（幂等行为）
    // 注意：警告消息已记录但未在此验证，以保持测试简单
    await engine.stop(config!)

    // 仍然已停止
    const stillStopped = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      '重复停止后容器应该仍已停止',
    )

    console.log('   重复停止已优雅处理（幂等）')
  })

  it('应该使用 --force 删除容器', async () => {
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

  it('应该使用密码认证的本地 Valkey 备份和恢复', async () => {
    console.log(`\n🔐 测试认证感知的 Valkey 备份/恢复...`)

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.valkey.base + 40,
    )
    const sourceName = generateTestName('valkey-auth-test-source')
    const targetName = generateTestName('valkey-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { appendFile, mkdir, readFile, rm, writeFile } = await import(
      'fs/promises'
    )
    const backupPath = join(tmpdir(), `valkey-auth-backup-${Date.now()}.valkey`)
    const engine = getEngine(ENGINE)

    const writeDefaultCredentialFile = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const credentialsDir = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'credentials',
      )
      await mkdir(credentialsDir, { recursive: true })
      const connectionString = `redis://default:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE}`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=default',
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

    const waitForAuthedReady = async (
      containerName: string,
      password: string,
      timeoutMs = 30000,
    ): Promise<{ ready: boolean; lastError: string | null }> => {
      const startTime = Date.now()
      let lastError: string | null = null

      while (Date.now() - startTime < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(config, 'PING', {
              database: DATABASE,
              username: 'default',
              password,
            })
            if (result.rows[0]?.result === 'PONG') {
              return { ready: true, lastError: null }
            }
          }
        } catch (error) {
          lastError =
            error instanceof Error ? error.message : 'unknown auth-ready error'
        }

        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      return { ready: false, lastError }
    }

    const enableRequirePass = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '容器配置应该存在')

      const configPath = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'valkey.conf',
      )
      await appendFile(configPath, `\nrequirepass ${password}\n`, 'utf-8')
      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, '认证重启前容器应该停止')

      const stoppedConfig = await containerManager.getConfig(containerName)
      assert(stoppedConfig !== null, '已停止的配置应该存在')
      await engine.start(stoppedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      const { ready, lastError } = await waitForAuthedReady(
        containerName,
        password,
      )
      assert(
        ready,
        `启用认证的 Valkey 应该就绪${lastError ? `: ${lastError}` : ''}`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源配置应该存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), '源应该就绪')
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await enableRequirePass(sourceName, sourcePort, sourcePassword)

      const sourceAuthedConfig = await containerManager.getConfig(sourceName)
      assert(sourceAuthedConfig !== null, '源认证配置应该存在')
      const sourceResult = await engine.executeQuery(
        sourceAuthedConfig!,
        'GET user:count',
        {
          database: DATABASE,
          username: 'default',
          password: sourcePassword,
        },
      )
      assertEqual(
        sourceResult.rows[0].result,
        '5',
        '启用认证的源仍应可查询',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, {})

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标配置应该存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), '目标应该就绪')
      await enableRequirePass(targetName, targetPort, targetPassword)

      const backupResult = await engine.backup(sourceAuthedConfig!, backupPath, {
        database: DATABASE,
        format: 'text',
      })
      assertEqual(backupResult.format, 'text', '备份应使用文本格式')
      const backupContent = await readFile(backupPath, 'utf-8')
      assert(
        backupContent.includes('user:count'),
        '启用认证的 Valkey 备份应包含已填充的键',
      )

      const targetAuthedConfig = await containerManager.getConfig(targetName)
      assert(targetAuthedConfig !== null, '目标认证配置应该存在')
      const restoreResult = await engine.restore(targetAuthedConfig!, backupPath, {
        database: DATABASE,
        flush: true,
      })
      assert(
        !restoreResult.stdout?.includes('NOAUTH') &&
          !restoreResult.stdout?.includes('WRONGPASS') &&
          !restoreResult.stderr?.includes('NOAUTH') &&
          !restoreResult.stderr?.includes('WRONGPASS'),
        '启用认证的 Valkey 恢复不应发出认证错误',
      )

      const restoredResult = await engine.executeQuery(
        targetAuthedConfig!,
        'GET user:count',
        {
          database: DATABASE,
          username: 'default',
          password: targetPassword,
        },
      )
      assertEqual(
        restoredResult.rows[0].result,
        '5',
        '对启用认证的目标恢复应该成功',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})
      await containerManager.delete(sourceName, { force: true }).catch(() => {})
      await containerManager.delete(targetName, { force: true }).catch(() => {})
    }
  })

  it('不应该有测试容器残留', async () => {
    console.log(`\n 验证中没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
