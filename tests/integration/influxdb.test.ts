/**
 * InfluxDB 系统集成测试
 *
 * 使用真实的 InfluxDB 进程测试完整的容器生命周期。
 * InfluxDB 是一个基于 REST API 的时序数据库。
 *
 * TODO: 拥有远程 InfluxDB 实例的测试环境后（例如通过 CI 中的 Docker Compose），为 dumpFromConnectionString 添加集成测试。
 * 目前，连接字符串解析在 unit/influxdb-restore.test.ts 中进行了测试。
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
import {
  getDefaultUsername,
  saveCredentials,
} from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.InfluxDB
const DATABASE = 'testdb'
const TEST_VERSION = '3' // 主版本号 - 将通过版本映射解析为完整版本

/**
 * 辅助函数：通过行协议向 InfluxDB 写入数据
 */
async function writeLineProtocol(
  port: number,
  database: string,
  lines: string,
): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v3/write_lp?db=${encodeURIComponent(database)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: lines,
        signal: controller.signal,
      },
    )
    clearTimeout(timeoutId)
    return response.ok || response.status === 204
  } catch {
    clearTimeout(timeoutId)
    return false
  }
}

/**
 * 辅助函数：通过 SQL 查询 InfluxDB
 */
async function querySql(
  port: number,
  database: string,
  sql: string,
): Promise<unknown[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v3/query_sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: database, q: sql, format: 'json' }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!response.ok) return []
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await response.json()
      return Array.isArray(data) ? data : []
    }
    return []
  } catch {
    clearTimeout(timeoutId)
    return []
  }
}

/**
 * 辅助函数：从表中获取行数
 */
async function getRowCount(
  port: number,
  database: string,
  table: string,
): Promise<number> {
  const rows = await querySql(
    port,
    database,
    `SELECT COUNT(*) as count FROM "${table}"`,
  )
  if (rows.length > 0) {
    const row = rows[0] as Record<string, unknown>
    const count = row.count
    if (typeof count === 'number') return count
  }
  return 0
}

/**
 * 辅助函数：轮询直到行数达到预期值（或超时）
 */
async function waitForRowCount(
  port: number,
  database: string,
  table: string,
  expected: number,
  maxRetries = 10,
): Promise<number> {
  for (let i = 0; i < maxRetries; i++) {
    const count = await getRowCount(port, database, table)
    if (count >= expected) return count
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return getRowCount(port, database, table)
}

const SEED_DATA = [
  'test_user,id=1 name="Alice",email="alice@example.com"',
  'test_user,id=2 name="Bob",email="bob@example.com"',
  'test_user,id=3 name="Charlie",email="charlie@example.com"',
  'test_user,id=4 name="Diana",email="diana@example.com"',
  'test_user,id=5 name="Eve",email="eve@example.com"',
].join('\n')

describe('InfluxDB 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n 正在清理所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    console.log('\n 正在查找可用测试端口...')
    // InfluxDB 使用单个端口（HTTP API），因此我们只需要 3 个端口
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.influxdb.base)
    console.log(`   使用端口：${testPorts.join(', ')}`)

    containerName = generateTestName('influxdb-test')
    clonedContainerName = generateTestName('influxdb-test-clone')
    renamedContainerName = generateTestName('influxdb-test-renamed')
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

    // 首先确保 InfluxDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 InfluxDB 二进制文件可用...')
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

    // 等待 InfluxDB 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'InfluxDB 应准备好接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应使用测试数据填充数据库', async () => {
    console.log(`\n 正在使用测试数据填充数据库...`)

    // 写入行协议数据（隐式创建数据库）
    const writeOk = await writeLineProtocol(testPorts[0], DATABASE, SEED_DATA)
    assert(writeOk, '应成功写入种子数据')

    // 等待数据被索引（用轮询代替固定等待）
    const count = await waitForRowCount(testPorts[0], DATABASE, 'test_user', 5)
    assertEqual(count, 5, '应有 5 条 test_user 记录')

    console.log(`   已填充 ${count} 条记录`)
  })

  it('应使用 executeQuery（REST API）查询数据', async () => {
    console.log(`\n 正在使用 engine.executeQuery（REST API）查询数据...`)

    // 通过引擎测试 SQL 查询
    const result = await executeQuery(containerName, 'SELECT * FROM test_user')

    assertTruthy(result.rowCount > 0, '应返回查询结果')
    assertEqual(result.rowCount, 5, '应有 5 行')

    console.log(`   REST API 查询返回了 ${result.rowCount} 行`)
  })

  it('应在启用管理员令牌认证的情况下进行备份和恢复', async () => {
    console.log('\n 正在测试带认证的 InfluxDB 备份/恢复...')

    const authPorts = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.influxdb.base + 20,
    )
    const [sourcePort, targetPort] = authPorts
    const sourceName = generateTestName('influxdb-auth-source')
    const targetName = generateTestName('influxdb-auth-target')
    const username = getDefaultUsername(ENGINE)
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = `${tmpdir()}/influxdb-auth-backup-${Date.now()}.sql`
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
      assert(sourceConfig !== null, '源容器配置应存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceReady, '源 InfluxDB 应已就绪')

      const writeOk = await writeLineProtocol(sourcePort, DATABASE, SEED_DATA)
      assert(writeOk, '应成功向带认证的源写入种子数据')

      const sourceCount = await waitForRowCount(
        sourcePort,
        DATABASE,
        'test_user',
        5,
      )
      assertEqual(sourceCount, 5, '启用认证前源应包含 5 行')

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: 'ignored-admin-token-input',
      })
      await saveCredentials(sourceName, ENGINE, sourceCreds)

      const sourceAuthedReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceAuthedReady, '启用认证后源 InfluxDB 应已就绪')

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
      assert(targetConfig !== null, '目标容器配置应存在')

      // createUser 会特意运行 `influxdb3 create token --offline` 并写入持久化的管理员令牌文件，
      // 后续 start() 调用会读取该文件。
      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: 'ignored-target-admin-token-input',
      })
      await saveCredentials(targetName, ENGINE, targetCreds)

      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })

      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(targetReady, '启用认证后目标 InfluxDB 应已就绪')

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })
      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      const restored = await executeQuery(
        targetName,
        'SELECT * FROM test_user',
        DATABASE,
      )
      assertEqual(restored.rowCount, 5, '已认证的 InfluxDB 恢复应保留所有行')
    } finally {
      await containerManager.delete(sourceName, { force: true }).catch(() => {})
      await containerManager.delete(targetName, { force: true }).catch(() => {})
      await rm(backupPath, { force: true })
    }
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
    const backupPath = `${tmpdir()}/influxdb-test-backup-${Date.now()}.sql`

    try {
      const sourceConfig = await containerManager.getConfig(containerName)
      assert(sourceConfig !== null, '源容器配置应存在')

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      // 先启动克隆容器（InfluxDB 恢复需要正在运行的实例）
      const clonedConfig = await containerManager.getConfig(clonedContainerName)
      assert(clonedConfig !== null, '克隆容器的配置应存在')

      await engine.start(clonedConfig!)
      await containerManager.updateConfig(clonedContainerName, {
        status: 'running',
      })

      // 等待就绪
      const clonedReady = await waitForReady(ENGINE, testPorts[1])
      assert(clonedReady, '克隆出的 InfluxDB 在恢复前应已就绪')

      // 恢复到克隆容器
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      const { rm } = await import('fs/promises')
      await rm(backupPath, { force: true }).catch(() => {})
    }

    console.log('   已通过备份/恢复克隆容器')
  })

  it('应验证克隆数据与源数据匹配', async () => {
    console.log('\n 正在验证克隆数据与源数据匹配...')

    // 验证克隆容器上的记录数
    const count = await waitForRowCount(testPorts[1], DATABASE, 'test_user', 5)
    assertEqual(count, 5, '克隆出的容器应有 5 条记录')

    console.log(`   克隆数据已验证：${count} 条记录`)
  })

  it('应基于文件内容检测备份格式', async () => {
    console.log('\n 正在检测备份格式...')

    const { tmpdir } = await import('os')
    const { writeFile, rm } = await import('fs/promises')

    // 创建一个测试用的 SQL 备份文件
    const testBackupPath = `${tmpdir()}/influxdb-format-test-${Date.now()}.sql`
    await writeFile(
      testBackupPath,
      '-- InfluxDB SQL Backup\nINSERT INTO test (col) VALUES (1);\n',
    )

    const engine = getEngine(ENGINE)
    const format = await engine.detectBackupFormat(testBackupPath)
    assertEqual(format.format, 'sql', '应检测到 SQL 格式')

    await rm(testBackupPath, { force: true })
    console.log(`   检测到的格式：${format.format}`)
  })

  it('应使用 runScript 内联 SQL 修改数据', async () => {
    console.log('\n 正在使用内联 SQL 修改数据...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 通过行协议写入额外的数据点
    const writeOk = await writeLineProtocol(
      testPorts[0],
      DATABASE,
      'test_user,id=6 name="Frank",email="frank@example.com"',
    )
    assert(writeOk, '应成功写入额外数据')

    // 验证新记录
    const count = await waitForRowCount(testPorts[0], DATABASE, 'test_user', 6)
    assertEqual(count, 6, '插入后应有 6 条记录')

    console.log(`   数据已修改：现有 ${count} 条记录`)
  })

  it('应创建 SQL 格式的备份', async () => {
    console.log('\n 正在创建 SQL 格式的备份...')

    const { tmpdir } = await import('os')
    const { stat, rm } = await import('fs/promises')

    const backupPath = `${tmpdir()}/influxdb-sql-backup-${Date.now()}.sql`

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assertEqual(result.format, 'sql', '备份格式应为 sql')

    const stats = await stat(backupPath)
    assert(stats.size > 0, '备份文件不应为空')

    await rm(backupPath, { force: true })
    console.log(`   已创建 SQL 备份（${stats.size} 字节）`)
  })

  it('应妥善处理端口冲突', async () => {
    console.log('\n 正在测试端口冲突处理...')

    // 尝试在同一端口上启动另一个容器
    const conflictName = generateTestName('influxdb-conflict')
    await containerManager.create(conflictName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0], // 与正在运行的容器端口相同
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(conflictName, TEST_VERSION, {
      port: testPorts[0],
    })

    const config = await containerManager.getConfig(conflictName)
    let startFailed = false
    try {
      await engine.start(config!)
    } catch {
      startFailed = true
    }
    assert(startFailed, '在已占用的端口上应无法启动')

    // 清理
    await containerManager.delete(conflictName, { force: true })
    console.log('   端口冲突已正确处置')
  })

  it('启动已运行的容器时应显示警告', async () => {
    console.log('\n 正在启动已运行的容器...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    // 不应抛出异常，只返回现有连接信息
    const result = await engine.start(config!)
    assertEqual(result.port, testPorts[0], '应返回现有端口')

    console.log('   已运行的容器得到了妥善处置')
  })

  it('应停止并重命名容器', async () => {
    console.log(`\n 正在重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 如果容器正在运行，则将其停止
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

  it('应验证重命名后数据依然存在', async () => {
    console.log('\n 正在验证重命名后数据依然存在...')

    // 启动重命名后的容器
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '重命名后的容器配置应存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    const ready = await waitForReady(ENGINE, testPorts[2])
    assert(ready, '重命名后的容器应已就绪')

    // 验证数据仍存在
    const count = await getRowCount(testPorts[2], DATABASE, 'test_user')
    assertEqual(count, 6, '重命名后的容器应有 6 条记录')

    console.log(`   数据仍存在：${count} 条记录`)
  })

  it('应妥善处理对已停止容器的停止操作', async () => {
    console.log('\n 正在停止已停止的容器...')

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)

    // 先停止它
    await engine.stop(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'stopped',
    })
    await waitForStopped(renamedContainerName, ENGINE, 60000)

    // 再次停止 —— 不应抛出异常
    await engine.stop(config!)

    console.log('   对已停止容器的再次停止已妥善处置')
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

  it('应确认没有残留的测试容器', async () => {
    console.log(`\n 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
