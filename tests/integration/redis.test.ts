/**
 * Redis 系统集成测试
 *
 * 使用真实 Redis 进程测试完整的容器生命周期。
 *
 * TODO: 一旦我们有了包含远程 Redis 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 就添加 dumpFromConnectionString 的集成测试。
 * 目前，连接字符串解析在 unit/redis-restore.test.ts 中测试。
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
  getKeyCount,
  getRedisValue,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.Redis
const DATABASE = '0' // Redis 使用编号数据库 0-15
const SEED_FILE = join(__dirname, '../fixtures/redis/seeds/sample-db.redis')
const EXPECTED_KEY_COUNT = 6 // 5 个 user 键 + 1 个 user:count 键
const TEST_VERSION = '8' // 主版本号 - 将通过版本映射解析为完整版本

describe('Redis 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n🧹 清理中，删除所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n🔍 查找可用测试端口...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.redis.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('redis-test')
    clonedContainerName = generateTestName('redis-test-clone')
    renamedContainerName = generateTestName('redis-test-renamed')
    portConflictContainerName = generateTestName('redis-test-conflict')
  })

  after(async () => {
    console.log('\n🧹 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  it('should create container without starting (--no-start)', async () => {
    console.log(
      `\n📦 创建容器 "${containerName}" 但不启动...`,
    )

    // 确保 Redis 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 Redis 二进制文件可用...')
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
      'Container status should be "created"',
    )

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, '容器不应该正在运行')

    console.log('   ✓ 容器已创建但未运行')
  })

  it('should start the container', async () => {
    console.log(`\n▶️  启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 Redis 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Redis should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   ✓ 容器已启动并就绪')
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(
      `\n🌱 正在用示例数据填充数据库，使用 engine.runScript...`,
    )

    // 使用 runScriptFile，它内部调用 engine.runScript
    // 这测试了 `spindb run` 命令功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      '填充后应有正确的键数',
    )

    console.log(`   ✓ 已填充 ${keyCount} 个键，使用 engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    console.log(`\n🔍 使用 engine.executeQuery 查询已填充的数据...`)

    // 测试 KEYS 命令
    const keysResult = await executeQuery(
      containerName,
      'KEYS user:*',
      DATABASE,
    )

    assertEqual(
      keysResult.rowCount,
      EXPECTED_KEY_COUNT,
      'Should return all user keys',
    )
    assertTruthy(
      keysResult.columns.includes('value'),
      'KEYS result should have value column',
    )

    // 测试 GET 命令
    const getResult = await executeQuery(
      containerName,
      'GET user:count',
      DATABASE,
    )

    assertEqual(getResult.rowCount, 1, 'GET should return one result')
    assertEqual(getResult.rows[0].result, '5', 'user:count should be 5')

    // 测试获取特定用户键
    const userResult = await executeQuery(containerName, 'GET user:1', DATABASE)

    assertEqual(userResult.rowCount, 1, 'GET should return one result')
    // user:1 包含 Alice 的 JSON 数据
    const userData = userResult.rows[0].result as string
    assertTruthy(
      userData.includes('Alice Johnson'),
      'user:1 should contain Alice Johnson',
    )

    console.log(
      `   ✓ 查询返回了 ${keysResult.rowCount} 个键，数据正确`,
    )
  })

  it('should create a user and update password on re-create', async () => {
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

    // ACL SETUSER 是幂等的 - 应该更新密码
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
    })
    assertEqual(creds2.password, 'secondpass456', '密码应该已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等）')
  })

  it('should clone container using backup/restore', async () => {
    console.log(
      `\n📋 通过备份/恢复创建容器 "${clonedContainerName}"...`,
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
    const backupPath = join(tmpdir(), `redis-test-backup-${Date.now()}.rdb`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'rdb',
    })

    // 停止源容器以进行恢复（恢复需要容器已停止）
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
    assert(ready, '克隆的 Redis 应该就绪')

    // 清理备份文件
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    // 重启源容器
    await engine.start(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待源容器就绪
    const sourceReady = await waitForReady(ENGINE, testPorts[0])
    assert(sourceReady, '重启后源 Redis 应该就绪')

    console.log('   ✓ 容器已通过备份/恢复克隆')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n🔍 验证恢复的数据与源匹配...`)

    const keyCount = await getKeyCount(testPorts[1], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      '恢复的数据应有相同的键数',
    )

    // 验证特定值
    const userCount = await getRedisValue(testPorts[1], DATABASE, 'user:count')
    assertEqual(userCount, '5', '用户数应为 5')

    console.log(`   ✓ 已在恢复的容器中验证 ${keyCount} 个键`)
  })

  it('should stop and delete the restored container', async () => {
    console.log(`\n🗑️  停止并删除已恢复的容器 "${clonedContainerName}"...`)

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

    console.log('   ✓ 容器已删除，文件系统已清理')
  })

  // ============================================
  // 文本格式备份/恢复测试 (.redis)
  // ============================================

  it('should backup to text format (.redis)', async () => {
    console.log(`\n📦 测试文本格式备份 (.redis)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-text-backup-${Date.now()}.redis`)

    // 使用 'text' 格式备份，生成 .redis 文本文件
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'text',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'text', 'Format should be text')
    assert(result.size > 0, 'Backup should have content')

    // 验证文件包含 Redis 命令
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assert(content.includes('SET user:'), '备份应包含 SET 命令')
    assert(
      content.includes('user:count'),
      'Backup should contain user:count key',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ 文本备份已创建，大小 ${result.size} 字节`)
  })

  it('should restore from text format with merge mode', async () => {
    console.log(`\n📥 测试文本格式恢复（合并模式）...`)

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
    const backupPath = join(tmpdir(), `redis-merge-test-${Date.now()}.redis`)

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'text',
    })

    // 修改一个键以验证它会被恢复
    await runScriptSQL(containerName, 'SET user:count 999', DATABASE)

    // 验证修改
    let userCount = await getRedisValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '999', 'user:count 应该已被修改')

    // 使用合并模式恢复（flush: false）
    await engine.restore(config!, backupPath, {
      database: DATABASE,
      flush: false,
    })

    // 验证恢复的值
    userCount = await getRedisValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '5', 'user:count 应该恢复为 5')

    // 验证额外键仍然存在（合并模式保留现有键）
    const extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
    assertEqual(
      extraKey,
      'should-persist',
      '额外键应在合并模式下保留',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })
    await runScriptSQL(containerName, 'DEL extra:key', DATABASE)

    console.log('   ✓ 文本恢复合并模式保留现有键')
  })

  it('should restore from text format with replace mode (FLUSHDB)', async () => {
    console.log(
      `\n📥 测试文本格式恢复（替换模式，使用 FLUSHDB）...`,
    )

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 首先创建文本备份
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-replace-test-${Date.now()}.redis`)

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
    let extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
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
    extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
    assert(
      extraKey === null || extraKey === '',
      '额外键应被 FLUSHDB 删除',
    )

    // 验证备份数据已恢复
    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(keyCount, EXPECTED_KEY_COUNT, '应有原始键数')

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   ✓ 文本恢复替换模式清除现有数据')
  })

  it('should detect Redis commands in file without .redis extension', async () => {
    console.log(`\n🔍 测试基于内容的格式检测...`)

    const engine = getEngine(ENGINE)

    // 创建一个包含 Redis 命令但使用 .txt 扩展名的文件
    const { tmpdir } = await import('os')
    const { writeFile, rm } = await import('fs/promises')
    const testFile = join(tmpdir(), `redis-commands-${Date.now()}.txt`)

    await writeFile(
      testFile,
      'SET test:key "value"\nSET test:key2 "value2"\n',
      'utf-8',
    )

    // 检测格式 - 应识别为 Redis 文本命令
    const format = await engine.detectBackupFormat(testFile)
    assertEqual(
      format.format,
      'text',
      '应通过内容检测到 Redis 命令',
    )
    assert(
      format.description.includes('detected by content'),
      '描述应提及内容检测',
    )

    // 清理
    await rm(testFile, { force: true })

    console.log(
      '   ✓ 基于内容的检测适用于无 .redis 扩展名的文件',
    )
  })

  it('should modify data using runScript inline command', async () => {
    console.log(
      `\n✏️  使用 engine.runScript 内联命令删除一个键...`,
    )

    // 使用 runScriptSQL，它内部调用 engine.runScript 并带有 --sql 选项
    // 对于 Redis，"sql" 实际上是 Redis 命令
    await runScriptSQL(containerName, 'DEL user:5', DATABASE)

    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    // 现在应该有 5 个键（user:count + user:1 到 user:4）
    assertEqual(keyCount, EXPECTED_KEY_COUNT - 1, '应该少一个键')

    console.log(
      `   ✓ 已使用 engine.runScript 删除键，现有 ${keyCount} 个键`,
    )
  })

  it('should stop, rename container, and change port', async () => {
    console.log(`\n📝 停止、重命名容器并更改端口...`)

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
      `   ✓ 已重命名为 "${renamedContainerName}"，端口 ${testPorts[2]}`,
    )
  })

  it('should verify data persists after rename', async () => {
    console.log(`\n🔍 验证重命名后数据持久化...`)

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
    assert(ready, '重命名的 Redis 应该就绪')

    // 验证键数反映了删除操作
    const keyCount = await getKeyCount(testPorts[2], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT - 1,
      '重命名后键数应保持不变',
    )

    console.log(`   ✓ 数据已持久化: ${keyCount} 个键`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n⚠️  测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器（testPorts[2]）
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 此端口已被重命名后的容器使用
        database: '1', // 使用不同的数据库以避免混淆
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

      // 容器应该已创建，但当我们尝试启动时，应该检测到冲突
      // 在实际使用中，start 命令会自动分配新端口
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, 'Container should be created')
      assertEqual(
        config?.port,
        testPorts[2],
        'Port should be set to conflicting port initially',
      )

      console.log(
        '   ✓ 容器已使用冲突端口创建（启动时会自动重新分配）',
      )
    } finally {
      // 始终清理此测试容器，即使测试失败
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // 忽略清理期间的错误（如果创建失败，容器可能不存在）
        })
    }
  })

  it('should show warning when starting already running container', async () => {
    console.log(`\n⚠️  启动已运行容器时显示警告...`)

    // 容器应该已经从之前的测试中运行
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should already be running')

    // 尝试再次启动不应抛出异常
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    // 这应该顺利完成而不抛出异常（幂等行为）
    await engine.start(config!)

    // 应该仍在运行
    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      stillRunning,
      'Container should still be running after duplicate start',
    )

    console.log(
      '   ✓ 容器已在运行（重复启动已优雅处理）',
    )
  })

  it('should handle stopping already stopped container gracefully', async () => {
    console.log(`\n⚠️  测试停止已停止的容器...`)

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
    assert(!running, 'Container should be stopped')

    // 尝试再次停止不应抛出异常（幂等行为）
    // 注意：此处未验证警告消息，以保持测试简单
    await engine.stop(config!)

    // 仍然已停止
    const stillStopped = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      'Container should still be stopped after duplicate stop',
    )

    console.log('   ✓ 重复停止已优雅处理（幂等）')
  })

  it('should delete container with --force', async () => {
    console.log(`\n🗑️  使用 --force 删除容器 "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应在列表中')

    console.log('   ✓ 容器已强制删除')
  })

  it('should backup and restore with password-authenticated local redis', async () => {
    console.log(`\n🔐 测试认证感知的 Redis 备份/恢复...`)

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.redis.base + 40,
    )
    const sourceName = generateTestName('redis-auth-test-source')
    const targetName = generateTestName('redis-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { appendFile, mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `redis-auth-backup-${Date.now()}.redis`)
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
        'redis.conf',
      )
      await appendFile(configPath, `\nrequirepass ${password}\n`, 'utf-8')
      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, 'Container should stop before auth restart')

      const stoppedConfig = await containerManager.getConfig(containerName)
      assert(stoppedConfig !== null, 'Stopped config should exist')
      await engine.start(stoppedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      const { ready, lastError } = await waitForAuthedReady(
        containerName,
        password,
      )
      assert(
        ready,
        `Auth-enabled Redis should be ready${lastError ? `: ${lastError}` : ''}`,
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
      assert(sourceConfig !== null, 'Source config should exist')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), 'Source should be ready')
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await enableRequirePass(sourceName, sourcePort, sourcePassword)

      const sourceAuthedConfig = await containerManager.getConfig(sourceName)
      assert(sourceAuthedConfig !== null, 'Source auth config should exist')
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
      assert(targetConfig !== null, 'Target config should exist')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), 'Target should be ready')
      await enableRequirePass(targetName, targetPort, targetPassword)

      const backupResult = await engine.backup(sourceAuthedConfig!, backupPath, {
        database: DATABASE,
        format: 'text',
      })
      assertEqual(backupResult.format, 'text', '备份应使用文本格式')

      const targetAuthedConfig = await containerManager.getConfig(targetName)
      assert(targetAuthedConfig !== null, 'Target auth config should exist')
      await engine.restore(targetAuthedConfig!, backupPath, {
        database: DATABASE,
        flush: true,
      })

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

      for (const containerName of [sourceName, targetName]) {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager.isRunning(containerName, {
            engine: ENGINE,
          }).catch(() => false)
          if (running) {
            await engine.stop(config).catch(() => {})
            await containerManager
              .updateConfig(containerName, { status: 'stopped' })
              .catch(() => {})
          }
        }
        await containerManager.delete(containerName, { force: true }).catch(() => {})
      }
    }

    console.log('   ✓ 备份和恢复适用于使用密码认证的 Redis')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ 验证中，确认没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 所有测试容器已清理')
  })
})
