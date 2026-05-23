/**
 * libSQL (sqld) 系统集成测试
 *
 * 使用真实的 sqld 进程测试完整的容器生命周期。
 * libSQL 是 SQLite 的一个分支，通过 Hrana 协议提供 HTTP API 访问。
 * 每个实例仅包含单个数据库（'main'），不支持创建/删除数据库。
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
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername } from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { libsqlQuery, libsqlApiRequest } from '../../engines/libsql/api-client'

const ENGINE = Engine.LibSQL
const DATABASE = 'main' // libSQL 每个实例运行单个数据库
const TEST_VERSION = '0' // 主版本号 - 将通过版本映射解析为完整版本

describe('libSQL 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let authToken: string | undefined

  before(async () => {
    console.log('\n 正在清理所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    console.log('\n 正在查找可用的测试端口...')
    // libSQL 使用单个 HTTP 端口，因此我们只需要 3 个端口
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.libsql.base)
    console.log(`   使用端口：${testPorts.join(', ')}`)

    containerName = generateTestName('libsql-test')
    clonedContainerName = generateTestName('libsql-test-clone')
    renamedContainerName = generateTestName('libsql-test-renamed')
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

    // 首先确保 libSQL 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 libSQL 二进制文件可用...')
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

    // 验证容器已存在但未运行
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

    // 等待 sqld 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'libSQL 应准备好接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应响应健康检查', async () => {
    console.log('\n 正在检查健康端点...')

    const response = await libsqlApiRequest(testPorts[0], 'GET', '/health')
    assertEqual(response.status, 200, '健康端点应返回 200')

    console.log('   健康检查已通过')
  })

  it('应通过 Hrana 协议创建表并插入数据', async () => {
    console.log('\n 正在创建表并插入测试数据...')

    // 创建测试表
    await libsqlQuery(
      testPorts[0],
      `CREATE TABLE IF NOT EXISTS test_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    )

    // 插入测试数据
    await libsqlQuery(
      testPorts[0],
      `INSERT OR IGNORE INTO test_user (name, email) VALUES
        ('Alice Johnson', 'alice@example.com'),
        ('Bob Smith', 'bob@example.com'),
        ('Charlie Brown', 'charlie@example.com')`,
    )

    // 验证数据已插入
    const result = await libsqlQuery(
      testPorts[0],
      'SELECT COUNT(*) as count FROM test_user',
    )
    assertEqual(result.rows.length, 1, '应返回一行')

    const count = Number(
      result.rows[0][0].type === 'integer' ? result.rows[0][0].value : 0,
    )
    assertEqual(count, 3, '应有 3 行')

    console.log(`   已创建包含 ${count} 行的表`)
  })

  it('应使用 executeQuery 查询数据', async () => {
    logDebug('正在使用 engine.executeQuery 查询数据...')

    // 通过引擎的 executeQuery 接口测试 SELECT 查询
    const selectResult = await executeQuery(
      containerName,
      'SELECT name, email FROM test_user ORDER BY name',
    )

    assertEqual(selectResult.rowCount, 3, '应返回 3 行')
    assertTruthy(selectResult.columns.includes('name'), '应包含“name”列')
    assertTruthy(selectResult.columns.includes('email'), '应包含“email”列')

    // 验证行数据
    const firstRow = selectResult.rows[0] as Record<string, unknown>
    assertEqual(firstRow.name, 'Alice Johnson', '第一行应为 Alice')
    assertEqual(firstRow.email, 'alice@example.com', '第一行的电子邮件应匹配')

    // 测试 sqlite_master 查询（列出表）
    const tablesResult = await executeQuery(
      containerName,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    assertTruthy(tablesResult.rowCount >= 1, '应至少有一张表')

    logDebug(`executeQuery 返回了 ${selectResult.rowCount} 行`)
  })

  it('应使用 JWT 认证创建用户', async () => {
    console.log('\n 正在创建 JWT 认证用户...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    const credentials = await engine.createUser(config!, {
      username: 'auth_token',
      password: '',
    })

    assertTruthy(credentials.apiKey, '凭据应包含非空的 apiKey')
    assertEqual(credentials.password, '', 'JWT 认证的密码应为空')
    assertEqual(credentials.username, 'auth_token', '用户名应为 auth_token')
    assertEqual(credentials.engine, ENGINE, '引擎应匹配')

    // 存储令牌以供后续测试使用
    authToken = credentials.apiKey

    // 等待 sqld 在重启后就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'libSQL 应在认证重启后就绪')

    console.log('   JWT 认证用户已创建')
  })

  it('createUser 应具有幂等性', async () => {
    console.log('\n 正在测试 createUser 的幂等性...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    const credentials = await engine.createUser(config!, {
      username: 'auth_token',
      password: '',
    })

    assertTruthy(credentials.apiKey, '第二次调用时凭据应包含 apiKey')
    assertEqual(credentials.apiKey, authToken, '幂等调用应返回相同的令牌')

    console.log('   createUser 的幂等性已验证')
  })

  it('createUser 后应使用认证信息查询', async () => {
    console.log('\n 正在通过 executeQuery 进行带认证的查询...')

    // executeQuery 通过 loadAuthToken 自动加载凭据
    const result = await executeQuery(
      containerName,
      'SELECT COUNT(*) as count FROM test_user',
    )

    assertEqual(result.rowCount, 1, '应返回一行')
    const firstRow = result.rows[0] as Record<string, unknown>
    assertEqual(firstRow.count, 3, '应有 3 行')

    console.log('   带认证的查询已成功')
  })

  it('启用认证后应拒绝未认证的请求', async () => {
    console.log('\n 正在测试未认证请求的拒绝情况...')

    let rejected = false
    try {
      // 不带 auth 令牌的直接 libsqlQuery 调用应失败
      await libsqlQuery(testPorts[0], 'SELECT 1')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assertTruthy(message.includes('401'), '错误应指示 401 未授权')
      rejected = true
    }

    assert(rejected, '未认证的请求应以 401 被拒绝')

    console.log('   未认证的请求已被正确拒绝')
  })

  it('应以二进制格式备份（文件复制）', async () => {
    console.log('\n 正在创建二进制备份...')

    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/libsql-test-backup-binary-${Date.now()}`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    assertTruthy(result.size > 0, '备份应包含内容')
    assertEqual(result.format, 'binary', '备份格式应为 binary')

    // 清理（二进制备份是一个目录树）
    const { rm } = await import('fs/promises')
    await rm(backupPath, { recursive: true, force: true })

    console.log(`   已创建二进制备份（${result.size} 字节）`)
  })

  it('应以 SQL 格式备份（HTTP API 转储）', async () => {
    console.log('\n 正在创建 SQL 备份...')

    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/libsql-test-backup-sql-${Date.now()}.sql`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assertTruthy(result.size > 0, 'SQL 备份文件应包含内容')
    assertEqual(result.format, 'sql', '备份格式应为 sql')

    // 验证 SQL 转储包含预期内容
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assertTruthy(
      content.includes('CREATE TABLE'),
      'SQL 转储应包含 CREATE TABLE',
    )
    assertTruthy(content.includes('test_user'), 'SQL 转储应引用 test_user 表')
    assertTruthy(content.includes('INSERT INTO'), 'SQL 转储应包含 INSERT 语句')

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   已创建 SQL 备份（${result.size} 字节）`)
  })

  it('应通过备份/恢复来克隆容器', async () => {
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
    const backupPath = `${tmpdir()}/libsql-test-backup-${Date.now()}`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    // 停止源容器以进行恢复（二进制格式的恢复要求容器已停止）
    await engine.stop(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止
    const stopped = await waitForStopped(containerName, ENGINE, 60000)
    assert(stopped, '源容器在恢复前应完全停止')

    // 恢复到克隆容器
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器的配置应存在')

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
    assert(ready, '克隆出的 libSQL 应已就绪')

    // 清理备份目录
    const { rm } = await import('fs/promises')
    await rm(backupPath, { recursive: true, force: true })

    console.log('   已通过备份/恢复克隆容器')
  })

  it('应在源和目标均启用 JWT 认证的情况下进行备份和恢复', async () => {
    console.log('\n 正在测试带认证的 libSQL 备份/恢复...')

    const allPorts = await findConsecutiveFreePorts(
      4,
      TEST_PORTS.libsql.base + 20,
    )
    const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
    const sourceName = generateTestName('libsql-auth-source')
    const targetName = generateTestName('libsql-auth-target')
    const username = getDefaultUsername(ENGINE)
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = `${tmpdir()}/libsql-auth-backup-${Date.now()}.sql`
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
      assert(sourceConfig !== null, '源容器配置应存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceReady, '源 libSQL 应已就绪')

      await libsqlQuery(
        sourcePort,
        `CREATE TABLE IF NOT EXISTS test_user (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      )
      await libsqlQuery(
        sourcePort,
        `INSERT INTO test_user (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')`,
      )

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: '',
      })
      assertTruthy(sourceCreds.apiKey, '源 JWT 令牌应存在')

      const sourceAuthedReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceAuthedReady, '认证重启后源 libSQL 应已就绪')

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, { port: targetPort })

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })

      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(targetReady, '目标 libSQL 在恢复前应已就绪')

      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: '',
      })
      assertTruthy(targetCreds.apiKey, '目标 JWT 令牌应存在')

      const targetAuthedReady = await waitForReady(ENGINE, targetPort)
      assert(targetAuthedReady, '认证重启后目标 libSQL 应已就绪')

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      const restored = await executeQuery(
        targetName,
        'SELECT COUNT(*) AS count FROM test_user',
      )
      assertEqual(restored.rowCount, 1, '应返回一个计数行')
      const row = restored.rows[0] as Record<string, unknown>
      assertEqual(
        Number(row.count),
        3,
        '恢复的带认证的 libSQL 数据应与源数据匹配',
      )

      console.log('   已成功进行带 JWT 认证的 libSQL 备份/恢复')
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      if (sourceConfig) {
        await engine.stop(sourceConfig).catch(() => {})
        await waitForStopped(sourceName, ENGINE, 60000).catch(() => false)
        await containerManager
          .delete(sourceName, { force: true })
          .catch(() => {})
      }

      const targetConfig = await containerManager.getConfig(targetName)
      if (targetConfig) {
        await engine.stop(targetConfig).catch(() => {})
        await waitForStopped(targetName, ENGINE, 60000).catch(() => false)
        await containerManager
          .delete(targetName, { force: true })
          .catch(() => {})
      }
    }
  })

  it('应验证克隆数据与源数据匹配', async () => {
    console.log('\n 正在验证克隆数据与源数据匹配...')

    // 查询克隆容器以验证数据
    const result = await libsqlQuery(
      testPorts[1],
      'SELECT COUNT(*) as count FROM test_user',
    )
    assertEqual(result.rows.length, 1, '应返回一行')

    const count = Number(
      result.rows[0][0].type === 'integer' ? result.rows[0][0].value : 0,
    )
    assertEqual(count, 3, '克隆出的容器应有 3 行')

    // 验证特定数据
    const dataResult = await libsqlQuery(
      testPorts[1],
      'SELECT name FROM test_user ORDER BY name',
    )
    assertEqual(dataResult.rows.length, 3, '应有 3 行')

    const firstName = String(
      dataResult.rows[0][0].type === 'text' ? dataResult.rows[0][0].value : '',
    )
    assertEqual(firstName, 'Alice Johnson', '第一个姓名应匹配')

    console.log(`   克隆数据已验证：${count} 行`)
  })

  it('应停止并重命名容器', async () => {
    console.log('\n 正在重命名容器并更改端口...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 如果容器正在运行，则将其停止（可能已从前一个测试中停止）
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
    assert(stopped, '重命名前容器应完全停止')

    // 重命名容器并更改端口
    await containerManager.rename(containerName, renamedContainerName)
    await containerManager.updateConfig(renamedContainerName, {
      port: testPorts[2],
    })

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应存在')
    assertEqual(newConfig?.port, testPorts[2], '端口应已更新')

    console.log(
      `   已重命名为 "${renamedContainerName}"，端口为 ${testPorts[2]}`,
    )
  })

  it('应删除克隆出的容器', async () => {
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

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   容器已强制删除')
  })

  it('应确认没有测试容器残留', async () => {
    console.log('\n 正在验证没有测试容器残留...')

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
