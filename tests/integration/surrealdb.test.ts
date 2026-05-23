/**
 * SurrealDB 系统集成测试
 *
 * 使用真实 SurrealDB 进程测试完整的容器生命周期。
 * SurrealDB 是一个多模型数据库，具有类似 SQL 的查询语言（SurrealQL）。
 *
 * TODO: 一旦我们拥有远程 SurrealDB 实例的测试环境，
 * 就添加 dumpFromConnectionString 的集成测试。
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
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine, type ContainerConfig } from '../../types'
import { paths } from '../../config/paths'
import { parseSurrealDBResult } from '../../core/query-parser'

const ENGINE = Engine.SurrealDB
const DATABASE = 'test' // SurrealDB 命名空间/数据库
const SEED_FILE = join(__dirname, '../fixtures/surrealdb/seeds/sample-db.surql')
const EXPECTED_ROW_COUNT = 5 // 5 个用户行
const TEST_VERSION = '2' // 主版本号

/**
 * 使用 surreal sql 从 SurrealDB 获取行数
 * 使用 spawn 和 stdin 以实现跨平台兼容性（echo 管道在 Windows 上不起作用）
 */
async function getSurrealDBRowCount(
  port: number,
  containerName: string,
  database: string,
  table: string,
  actualContainerName?: string,
): Promise<number> {
  const { spawn } = await import('child_process')

  const engine = getEngine(ENGINE)
  const surrealPath = await engine
    .getSurrealPath(TEST_VERSION)
    .catch(() => 'surreal')

  // 从容器名称派生命名空间（与引擎相同）
  const namespace = containerName.replace(/-/g, '_')

  // 在 SurrealDB 中查询行数的查询
  // SurrealQL 语法: SELECT count() FROM table GROUP ALL
  const query = `SELECT count() FROM ${table} GROUP ALL`

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const args = [
        'sql',
        '--endpoint',
        `ws://127.0.0.1:${port}`,
        '--namespace',
        namespace,
        '--database',
        database,
        '--username',
        'root',
        '--password',
        'root',
        '--json',
        '--hide-welcome',
      ]
      // 将 cwd 设置为容器目录，以便 history.txt 写在那里，而不是项目根目录
      // 重命名后，目录位于新名称，但命名空间使用原始名称
      const cwd = paths.getContainerPath(actualContainerName || containerName, {
        engine: ENGINE,
      })
      const proc = spawn(surrealPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      })
      let output = ''
      let stderr = ''
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('close', (code) => {
        if (code === 0) resolve(output)
        else reject(new Error(stderr || `Exit code ${code}`))
      })
      proc.on('error', reject)
      proc.stdin.write(query)
      proc.stdin.end()
    })

    const results = parseSurrealDBResult(stdout)
    const count = results.rows[0]?.count
    if (typeof count === 'number') {
      return count
    }
    return 0
  } catch (error) {
    console.error('错误: 获取行数失败:', error)
    return 0
  }
}

describe('SurrealDB 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string
  // 在 Windows 上，重命名被跳过，因此容器保留其原始名称
  // 这跟踪重命名点之后测试的"当前"容器名称
  const getActiveContainerName = () =>
    process.platform === 'win32' ? containerName : renamedContainerName

  before(async () => {
    console.log('\n 清理中：清理所有现有的测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    // SurrealDB 每个容器使用 1 个端口
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.surrealdb.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('surrealdb-test')
    clonedContainerName = generateTestName('surrealdb-test-clone')
    renamedContainerName = generateTestName('surrealdb-test-renamed')
    portConflictContainerName = generateTestName('surrealdb-test-conflict')
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

    // 首先确保 SurrealDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 SurrealDB 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // SurrealDB 不需要 initDataDir - 数据目录在启动时创建

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

    // 等待 SurrealDB 就绪（60 秒超时，适用于慢速 CI 运行器）
    const ready = await waitForReady(ENGINE, testPorts[0], 60000)
    assert(ready, 'SurrealDB 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(`\n 正在用示例数据填充数据库，使用 engine.runScript...`)

    // 使用 runScriptFile，它在内部调用 engine.runScript
    // 这测试了 `spindb run` 命令功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getSurrealDBRowCount(
      testPorts[0],
      containerName,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '填充后应有正确的行数',
    )

    console.log(`   已填充 ${rowCount} 行，使用 engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    logDebug('使用 engine.executeQuery 查询已填充的数据...')

    // 测试基本 SELECT 查询（SurrealQL 语法）
    const result = await executeQuery(
      containerName,
      'SELECT id, name, email FROM test_user ORDER BY id',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, 'Should return all rows')

    // 验证第一行数据
    assertEqual(result.rows[0].name, 'Alice', 'First row should be Alice')
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      'First row email should match',
    )

    // 验证列包含预期字段
    assertTruthy(result.columns.includes('name'), 'Columns should include name')
    assertTruthy(
      result.columns.includes('email'),
      'Columns should include email',
    )

    // 测试过滤查询
    const filteredResult = await executeQuery(
      containerName,
      "SELECT name FROM test_user WHERE email CONTAINS 'bob'",
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, 'Should return one row for Bob')
    assertEqual(filteredResult.rows[0].name, 'Bob', 'Should find Bob')

    logDebug(`查询返回了 ${result.rowCount} 行，数据正确`)
  })

  it('should create a user and update password on re-create', async () => {
    console.log(`\n👤 测试 createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', '用户名应该匹配')
    assertEqual(creds1.password, 'firstpass123', '密码应该匹配')
    console.log('   ✓ 已使用初始密码创建用户')

    // DEFINE USER 是幂等的 - 应该更新密码
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', '密码应该已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等）')
  })

  it('should clone container using backup/restore', async () => {
    console.log(
      `\n 通过备份/恢复创建容器 "${clonedContainerName}"...`,
    )

    // 创建克隆容器
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    const engine = getEngine(ENGINE)

    // 先启动克隆容器（导入需要）
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器配置应该存在')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1], 60000)
    assert(ready, '克隆的 SurrealDB 恢复前应该就绪')

    // 从源创建备份
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `surrealdb-test-backup-${Date.now()}.surql`,
    )

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'surql',
      })

      // 恢复到克隆容器
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      // 即使恢复失败也清理备份文件
      await rm(backupPath, { force: true })
    }

    console.log('   容器已通过备份/恢复克隆')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n 验证恢复的数据与源匹配...`)

    const rowCount = await getSurrealDBRowCount(
      testPorts[1],
      clonedContainerName,
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

  it('should stop and delete the restored container', async (t) => {
    // 在 Windows 上跳过 - SurrealDB 的 SurrealKV 使用内存映射文件，
    // Windows 会持有其句柄超过 100 秒，导致 EBUSY 错误
    if (process.platform === 'win32') {
      t.skip('删除测试在 Windows 上跳过（SurrealKV 文件句柄锁定）')
      return
    }

    console.log(`\n 停止并删除已恢复的容器 "${clonedContainerName}"...`)

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
      `\n 删除一行，使用 engine.runScript 内联命令...`,
    )

    // 使用 runScriptSQL，它在内部调用 engine.runScript 并带有 --sql 选项
    await runScriptSQL(containerName, 'DELETE test_user:5', DATABASE)

    const rowCount = await getSurrealDBRowCount(
      testPorts[0],
      containerName,
      DATABASE,
      'test_user',
    )
    // 现在应该有 4 行
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应该少一行')

    console.log(
      `   行已删除，使用 engine.runScript，现有 ${rowCount} 行`,
    )
  })

  it('should stop, rename container, and change port', async (t) => {
    // 在 Windows 上跳过 - SurrealDB 使用内存映射文件，Windows 在进程退出后
    // 仍会长时间持有句柄，导致重命名时出现 EPERM 错误，
    // 超出合理的重试超时时间
    if (process.platform === 'win32') {
      t.skip('重命名测试在 Windows 上跳过（文件句柄锁定问题）')
      return
    }

    console.log(`\n 重命名容器并更改端口...`)

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

  it('should verify data persists after rename', async (t) => {
    // 在 Windows 上跳过 - 依赖于被跳过的重命名测试
    if (process.platform === 'win32') {
      t.skip('重命名验证在 Windows 上跳过（重命名测试已跳过）')
      return
    }

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
    const ready = await waitForReady(ENGINE, testPorts[2], 60000)
    assert(ready, '重命名的 SurrealDB 应该就绪')

    // 验证行数反映删除
    // 注意：命名空间存储在 SurrealDB 的数据文件中，因此重命名后
    // 我们仍然需要使用原始容器名称的命名空间进行查询
    const rowCount = await getSurrealDBRowCount(
      testPorts[2],
      containerName,
      DATABASE,
      'test_user',
      renamedContainerName,
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      '重命名后行数应保持不变',
    )

    console.log(`   数据已持久化: ${rowCount} 行`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n 测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器（testPorts[2]）
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 此端口被重命名后的容器使用
        database: 'test_db', // 不同的数据库以避免混淆
      })

      // 容器应该被创建，但当我们尝试启动时，应该检测到冲突
      // 在实际使用中，start 命令会自动分配新端口
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, 'Container should be created')
      assertEqual(
        config?.port,
        testPorts[2],
        'Port should be set to conflicting port initially',
      )

      console.log(
        '   容器已使用冲突端口创建（启动时会自动重新分配）',
      )
    } finally {
      // 始终清理此测试容器，即使测试失败
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // 清理期间忽略错误（如果创建失败，容器可能不存在）
        })
    }
  })

  it('should show warning when starting already running container', async (t) => {
    console.log(`\n 测试启动已运行容器...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      t.skip('容器未找到 - 之前的测试可能已失败')
      return
    }

    const engine = getEngine(ENGINE)

    // 检查容器是否正在运行 - 如果没有，先启动它
    const initiallyRunning = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })

    if (!initiallyRunning) {
      console.log('   容器未运行，先启动它...')
      await engine.start(config)
      const ready = await waitForReady(ENGINE, config.port, 60000)
      if (!ready) {
        t.skip('容器启动失败 - 跳过重复启动测试')
        return
      }
      await containerManager.updateConfig(activeContainer, {
        status: 'running',
      })
    }

    // 现在容器应该正在运行
    const running = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    // 尝试再次启动不应抛出错误（幂等行为）
    await engine.start(config)

    // 应该仍在运行
    const stillRunning = await processManager.isRunning(activeContainer, {
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

  it('should handle stopping already stopped container gracefully', async (t) => {
    console.log(`\n 测试停止已停止的容器...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      t.skip('容器未找到 - 之前的测试可能已失败')
      return
    }

    const engine = getEngine(ENGINE)

    // 先停止容器
    await engine.stop(config)
    await containerManager.updateConfig(activeContainer, {
      status: 'stopped',
    })

    // 等待容器完全停止
    const stopped = await waitForStopped(activeContainer, ENGINE)
    assert(stopped, '容器应该已完全停止')

    // 现在已停止，验证
    const running = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(!running, '容器应该已停止')

    // 尝试再次停止不应抛出错误（幂等行为）
    await engine.stop(config)

    // 仍然已停止
    const stillStopped = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      '重复停止后容器应该仍已停止',
    )

    console.log('   重复停止已优雅处理（幂等）')
  })

  it('should delete container with --force', async (t) => {
    // 在 Windows 上跳过 - SurrealDB 的 SurrealKV 使用内存映射文件，
    // Windows 会持有其句柄超过 100 秒，导致 EBUSY 错误
    if (process.platform === 'win32') {
      t.skip(
        '强制删除测试在 Windows 上跳过（SurrealKV 文件句柄锁定）',
      )
      return
    }

    const activeContainer = getActiveContainerName()
    console.log(`\n 强制删除容器 "${activeContainer}"...`)

    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      console.log('   容器未找到 - 跳过删除测试')
      t.skip('容器未找到 - 之前的测试可能已失败')
      return
    }

    await containerManager.delete(activeContainer, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(activeContainer, ENGINE)
    assert(!exists, '容器数据目录应该已删除')

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === activeContainer)
    assert(!found, '容器不应在列表中')

    console.log('   容器已强制删除')
  })

  it('should backup and restore with password-authenticated saved local root credentials', async () => {
    console.log(
      `\n🔐 测试认证感知的 SurrealDB 备份/恢复，在本地容器上...`,
    )

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.surrealdb.base + 40,
    )
    const sourceName = generateTestName('surrealdb-auth-test-source')
    const targetName = generateTestName('surrealdb-auth-test-target')
    const { tmpdir } = await import('os')
    const { mkdir, readFile, rm, writeFile } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `surrealdb-auth-backup-${Date.now()}.surql`,
    )
    const engine = getEngine(ENGINE)
    const buildSavedRootScopedCredentials = (
      containerName: string,
      port: number,
    ) => ({
      username: 'saved_root_user',
      password: 'saved-root-pass-123',
      connectionString: `surrealdb://saved_root_user:saved-root-pass-123@127.0.0.1:${port}/${containerName.replace(/-/g, '_')}/${DATABASE}?authLevel=root`,
      database: DATABASE,
    })

    const writeDefaultCredentialFile = async (
      containerName: string,
      credentials: {
        username: string
        password: string
        connectionString: string
        database?: string
      },
    ) => {
      const credentialsDir = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'credentials',
      )
      await mkdir(credentialsDir, { recursive: true })
      const parsedUrl = new URL(credentials.connectionString)
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          `DB_USER=${credentials.username}`,
          `DB_PASSWORD=${credentials.password}`,
          `DB_HOST=${parsedUrl.hostname || '127.0.0.1'}`,
          `DB_PORT=${parsedUrl.port || '8000'}`,
          `DB_NAME=${credentials.database || DATABASE}`,
          `DB_URL=${credentials.connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const createSavedRootScopedUser = async (
      config: ContainerConfig,
      containerName: string,
      port: number,
    ) => {
      const credentials = buildSavedRootScopedCredentials(containerName, port)
      await engine.runScript(config, {
        sql: [
          `DEFINE USER OVERWRITE ${credentials.username} ON ROOT PASSWORD '${credentials.password}' ROLES OWNER;`,
          `DEFINE USER OVERWRITE root ON ROOT PASSWORD 'rotated-bootstrap-pass-123' ROLES OWNER;`,
        ].join(' '),
        database: DATABASE,
      })
      await writeDefaultCredentialFile(containerName, credentials)
      return credentials
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源配置应该存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(
        await waitForReady(ENGINE, sourcePort, 60000),
        '源应该就绪',
      )
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await createSavedRootScopedUser(
        sourceConfig!,
        sourceName,
        sourcePort,
      )

      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源认证配置应该存在')
      const sourceRows = await engine.executeQuery(
        sourceConfig!,
        'SELECT * FROM test_user ORDER BY id',
        {
          database: DATABASE,
        },
      )
      assertEqual(
        sourceRows.rowCount,
        EXPECTED_ROW_COUNT,
        '启用认证的源应该仍然可以查询',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标配置应该存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(
        await waitForReady(ENGINE, targetPort, 60000),
        '目标应该就绪',
      )
      await createSavedRootScopedUser(
        targetConfig!,
        targetName,
        targetPort,
      )

      const backupResult = await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
      })
      assertEqual(
        backupResult.format,
        'surql',
        '备份应使用 SurrealQL 格式',
      )
      const backupContent = await readFile(backupPath, 'utf-8')
      assert(
        !/DEFINE\s+(USER|ACCESS)\b/i.test(backupContent),
        'SurrealDB 备份不应包含认证定义',
      )

      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标认证配置应该存在')
      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })
      const restoredRows = await engine.executeQuery(
        targetConfig!,
        'SELECT * FROM test_user ORDER BY id',
        {
          database: DATABASE,
        },
      )
      assertEqual(
        restoredRows.rowCount,
        EXPECTED_ROW_COUNT,
        '恢复应该对启用认证的目标成功',
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

    console.log(
      '   ✓ 备份和恢复在使用密码认证的 SurrealDB 上正常工作',
    )
  })

  it('should have no test containers remaining', async (t) => {
    // 在 Windows 上跳过 - 删除测试被跳过，因此容器将保留
    if (process.platform === 'win32') {
      t.skip('清理验证在 Windows 上跳过（删除测试已跳过）')
      return
    }

    console.log(`\n 验证中：确认没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
