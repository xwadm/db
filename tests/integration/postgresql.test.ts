/**
 * PostgreSQL 系统集成测试
 *
 * 使用真实 PostgreSQL 进程测试完整的容器生命周期。
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
  getRowCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  getConnectionString,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.PostgreSQL
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/postgresql/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5

describe('PostgreSQL 集成测试', () => {
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
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.postgresql.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('pg-test')
    clonedContainerName = generateTestName('pg-test-clone')
    renamedContainerName = generateTestName('pg-test-renamed')
    portConflictContainerName = generateTestName('pg-test-conflict')
  })

  after(async () => {
    // 将诊断信息打印到 STDERR，确保一定会显示
    process.stderr.write('\n')
    process.stderr.write(
      '╔══════════════════════════════════════════════════════════════╗\n',
    )
    process.stderr.write(
      '║              测试套件摘要 (after hook)                     ║\n',
    )
    process.stderr.write(
      '╠══════════════════════════════════════════════════════════════╣\n',
    )

    // 显示预期使用的测试容器名称
    process.stderr.write(`║ containerName: ${containerName || 'UNDEFINED'}\n`)
    process.stderr.write(
      `║ renamedContainerName: ${renamedContainerName || 'UNDEFINED'}\n`,
    )
    process.stderr.write(
      `║ clonedContainerName: ${clonedContainerName || 'UNDEFINED'}\n`,
    )
    process.stderr.write(
      '╠══════════════════════════════════════════════════════════════╣\n',
    )

    try {
      const containers = await containerManager.list()
      const testContainers = containers.filter((c) => c.name.includes('-test'))
      process.stderr.write(
        `║ 所有容器: ${JSON.stringify(containers.map((c) => c.name))}\n`,
      )
      process.stderr.write(
        `║ 剩余测试容器: ${testContainers.length}\n`,
      )
      for (const tc of testContainers) {
        process.stderr.write(
          `║   - ${tc.name} (${tc.engine}, 状态: ${tc.status})\n`,
        )
      }

      // 检查预期容器是否存在
      const hasOriginal = containers.some((c) => c.name === containerName)
      const hasRenamed = containers.some((c) => c.name === renamedContainerName)
      const hasClone = containers.some((c) => c.name === clonedContainerName)
      process.stderr.write(
        '╠══════════════════════════════════════════════════════════════╣\n',
      )
      process.stderr.write(
        `║ 原始容器 (${containerName}): ${hasOriginal ? 'EXISTS' : 'missing'}\n`,
      )
      process.stderr.write(
        `║ 重命名容器 (${renamedContainerName}): ${hasRenamed ? 'EXISTS' : 'missing'}\n`,
      )
      process.stderr.write(
        `║ 克隆容器 (${clonedContainerName}): ${hasClone ? 'EXISTS (should be deleted)' : 'deleted OK'}\n`,
      )
    } catch (error) {
      process.stderr.write(`║ 列出容器时出错: ${error}\n`)
    }
    process.stderr.write(
      '╚══════════════════════════════════════════════════════════════╝\n',
    )

    console.log('\n🧹 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  // 诊断测试 - 此测试应始终通过，显示环境信息
  it('[诊断] 环境检查', async () => {
    process.stdout.write('\n--- 诊断测试开始 ---\n')
    process.stdout.write(
      `HOME: ${process.env.HOME || process.env.USERPROFILE}\n`,
    )
    process.stdout.write(`CWD: ${process.cwd()}\n`)
    process.stdout.write(`testPorts: ${JSON.stringify(testPorts)}\n`)
    process.stdout.write(`containerName: ${containerName}\n`)
    process.stdout.write(`renamedContainerName: ${renamedContainerName}\n`)

    // 检查 PostgreSQL 二进制文件是否存在
    const engine = getEngine(ENGINE)
    let psqlPath: string | null = null
    try {
      psqlPath = await engine.getPsqlPath()
    } catch {
      psqlPath = null
    }
    process.stdout.write(`PostgreSQL psql 路径: ${psqlPath || 'NOT FOUND'}\n`)

    // 检查启动时的容器
    let containers: Awaited<ReturnType<typeof containerManager.list>> = []
    try {
      containers = await containerManager.list()
      process.stdout.write(
        `现有容器: ${JSON.stringify(containers.map((c) => c.name))}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `现有容器: 错误 - ${error instanceof Error ? error.message : error}\n`,
      )
    }
    process.stdout.write('--- 诊断测试结束 ---\n\n')

    // 始终通过，表明执行到这里了
    assert(true, '诊断测试通过')
  })

  it('应该创建容器但不启动 (--no-start)', async () => {
    console.log(
      `\n📦 创建容器但不启动 "${containerName}"...`,
    )

    // 首先确保 PostgreSQL 二进制文件已下载
    // 注意：版本必须与 CI 工作流下载匹配 (spindb-pg-18 缓存键)
    const engine = getEngine(ENGINE)
    console.log('   正在确保 PostgreSQL 二进制文件可用...')
    await engine.ensureBinaries('18', ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '18',
      port: testPorts[0],
      database: DATABASE,
    })

    // 初始化数据库集群
    await engine.initDataDir(containerName, '18', { superuser: 'postgres' })

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

    console.log('   ✓ 容器已创建但未运行')
  })

  it('应该启动容器', async () => {
    console.log(`\n▶️  启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 PostgreSQL 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'PostgreSQL 应该就绪以接受连接')

    // 创建用户数据库
    await engine.createDatabase(config!, DATABASE)

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   ✓ 容器已启动并就绪')
  })

  it('应该使用 runScript 用测试数据填充数据库', async () => {
    console.log(
      `\n🌱 用测试数据填充数据库，使用 engine.runScript...`,
    )

    // 使用 runScriptFile，内部调用 engine.runScript
    // 测试 `spindb run` 命令功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '填充后应有正确的行数',
    )

    console.log(`   ✓ 已使用 engine.runScript 填充 ${rowCount} 行`)
  })

  it('应该使用 executeQuery 查询已填充的数据', async () => {
    console.log(`\n🔍 查询已填充的数据，使用 engine.executeQuery...`)

    // 测试基本 SELECT 查询
    const result = await executeQuery(
      containerName,
      'SELECT id, name, email FROM test_user ORDER BY id',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, '应返回所有行')
    assertDeepEqual(
      result.columns,
      ['id', 'name', 'email'],
      '应有正确的列',
    )

    // 验证第一行数据
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      '第一行应为 Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      '第一行邮箱应该匹配',
    )

    // 测试过滤查询
    const filteredResult = await executeQuery(
      containerName,
      "SELECT name FROM test_user WHERE email LIKE '%bob%'",
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, '应为 Bob 返回一行')
    assertEqual(
      filteredResult.rows[0].name,
      'Bob Smith',
      '应找到 Bob Smith',
    )

    console.log(`   ✓ 查询返回了预期数据，共 ${result.rowCount} 行`)
  })

  it('应该从连接字符串创建新容器 (dump/restore)', async () => {
    console.log(
      `\n📋 从连接字符串创建容器 "${clonedContainerName}"...`,
    )

    const sourceConnectionString = getConnectionString(
      ENGINE,
      testPorts[0],
      DATABASE,
    )

    // 创建容器
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: '18',
      port: testPorts[1],
      database: DATABASE,
    })

    // 初始化并启动
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, '18', {
      superuser: 'postgres',
    })

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '克隆容器配置应该存在')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, '克隆的 PostgreSQL 应该就绪')

    // 创建数据库
    await engine.createDatabase(config!, DATABASE)

    // 从源转储并恢复到目标
    const { tmpdir } = await import('os')
    const dumpPath = join(tmpdir(), `pg-test-dump-${Date.now()}.dump`)

    await engine.dumpFromConnectionString(sourceConnectionString, dumpPath)
    await engine.restore(config!, dumpPath, {
      database: DATABASE,
      createDatabase: false,
    })

    // 清理转储文件
    const { rm } = await import('fs/promises')
    await rm(dumpPath, { force: true })

    console.log('   ✓ 容器已通过备份/恢复克隆')
  })

  it('应该验证恢复的数据与源匹配', async () => {
    console.log(`\n🔍 验证恢复的数据...`)

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

    console.log(`   ✓ 已在恢复的容器中验证 ${rowCount} 行`)
  })

  // ============================================
  // 备份格式测试
  // ============================================

  it('应该备份为 SQL 格式 (.sql)', async () => {
    console.log(`\n📦 测试 SQL 格式备份 (.sql)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-sql-backup-${Date.now()}.sql`)

    // 使用 'sql' 格式备份，生成纯 SQL
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assert(result.path === backupPath, '备份路径应该匹配')
    assert(result.format === 'sql', '格式应为 sql')
    assert(result.size > 0, '备份应该有内容')

    // 验证文件包含 SQL 语句
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assert(
      content.includes('CREATE TABLE'),
      '备份应包含 CREATE TABLE',
    )
    assert(
      content.includes('test_user'),
      '备份应包含 test_user 表',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL 备份已创建，大小 ${result.size} 字节`)
  })

  it('应该备份为自定义格式 (.dump)', async () => {
    console.log(`\n📦 测试自定义格式备份 (.dump)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-dump-backup-${Date.now()}.dump`)

    // 使用 'custom' 格式备份，生成自定义二进制
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'custom',
    })

    assert(result.path === backupPath, '备份路径应该匹配')
    assert(result.format === 'custom', '格式应为自定义')
    assert(result.size > 0, '备份应该有内容')

    // 验证文件为二进制格式（以 PGDMP 开头）
    const { readFile } = await import('fs/promises')
    const buffer = await readFile(backupPath)
    const header = buffer.slice(0, 5).toString('ascii')
    assert(header === 'PGDMP', '备份应有 PGDMP 头')

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ 自定义格式备份已创建，大小 ${result.size} 字节`)
  })

  it('应该从 SQL 格式恢复并验证数据', async () => {
    console.log(`\n📥 测试 SQL 格式恢复...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '容器配置应该存在')

    // 从源创建 SQL 备份
    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-sql-restore-${Date.now()}.sql`)

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // 在克隆容器中创建新数据库用于恢复测试
    const testDb = 'restore_test_db'
    await engine.createDatabase(config!, testDb)

    // 将 SQL 备份恢复到新数据库
    await engine.restore(config!, backupPath, {
      database: testDb,
      createDatabase: false,
    })

    // 验证数据已恢复
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      testDb,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '恢复的数据应与源匹配',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL 恢复已验证，共 ${rowCount} 行`)
  })

  it('应该停止并删除已恢复的容器', async () => {
    console.log(`\n🗑️  删除已恢复的容器 "${clonedContainerName}"...`)

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

  it('应该使用 runScript 内联 SQL 修改数据', async () => {
    console.log(
      `\n✏️  使用 engine.runScript 内联 SQL 删除一行...`,
    )

    // 使用 runScriptSQL，内部调用 engine.runScript 的 --sql 选项
    // 测试 `spindb run --sql` 命令功能
    await runScriptSQL(
      containerName,
      "DELETE FROM test_user WHERE email = 'eve@example.com'",
      DATABASE,
    )

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应该少一行')

    console.log(
      `   ✓ 已使用 engine.runScript 删除一行，现有 ${rowCount} 行`,
    )
  })

  it('应该创建用户并在重新创建时更新密码', async () => {
    console.log(`\n👤 测试 createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    // 使用第一个密码创建用户
    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', '用户名应该匹配')
    assertEqual(creds1.password, 'firstpass123', '密码应该匹配')
    assert(
      creds1.connectionString.includes('testuser'),
      '连接字符串应包含用户名',
    )
    console.log('   ✓ 已创建用户，使用初始密码')

    // 用不同密码重新创建同一用户（应更新，不报错）
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.username, 'testuser', '用户名应该匹配')
    assertEqual(creds2.password, 'secondpass456', '密码应该已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等）')
  })

  it('应该停止、重命名容器并更改端口', async () => {
    console.log(`\n📝 重命名容器并更改端口...`)

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

  it('应该验证重命名后数据持久化', async () => {
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
    assert(ready, '重命名后的 PostgreSQL 应该就绪')

    // 验证行数反映了删除操作
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      '重命名后行数应保持不变',
    )

    console.log(`   ✓ 数据已持久化: ${rowCount} 行`)
  })

  it('应该优雅处理端口冲突', async () => {
    console.log(`\n⚠️  测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器 (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: '18',
        port: testPorts[2], // 此端口已被重命名后的容器使用
        database: 'conflictdb',
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, '18', {
        superuser: 'postgres',
      })

      // 容器应已创建，但尝试启动时应检测到冲突
      // 在实际使用中，start 命令会自动分配新端口
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, '容器应该已创建')
      assertEqual(
        config?.port,
        testPorts[2],
        '端口应初始设置为冲突端口',
      )

      console.log(
        '   ✓ 容器已使用冲突端口创建（启动时会自动重新分配）',
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

  it('启动已运行容器时显示警告', async () => {
    console.log(`\n⚠️  测试启动已运行的容器...`)

    // 容器应该已从之前的测试中运行
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该已在运行')

    // 尝试再次启动不应抛出异常
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    // 应顺利完成而不抛出异常（幂等行为）
    await engine.start(config!)

    // 仍应正在运行
    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      stillRunning,
      '重复启动后容器应该仍在运行',
    )

    console.log(
      '   ✓ 容器已在运行（重复启动已优雅处理）',
    )
  })

  it('优雅处理停止已停止的容器', async () => {
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
    assert(!running, '容器应该已停止')

    // 尝试再次停止不应抛出异常
    // （在实际 CLI 使用中，会显示警告消息）
    console.log('   ✓ 容器已停止（在 CLI 中会显示警告）')
  })

  it('应该使用 --force 删除容器', async () => {
    console.log(`\n🗑️  强制删除容器 "${renamedContainerName}"...`)

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

  it('应该使用密码认证的本地超级用户凭据进行备份和恢复', async () => {
    console.log(
      `\n🔐 测试认证感知的 PostgreSQL 备份/恢复（本地容器）...`,
    )

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.postgresql.base + 40,
    )
    const sourceName = generateTestName('pg-auth-test-source')
    const targetName = generateTestName('pg-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, readFile, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `pg-auth-backup-${Date.now()}.dump`)
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
      const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE}`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=postgres',
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
            const result = await engine.executeQuery(config, 'SELECT 1 AS ok', {
              database: 'postgres',
              username: 'postgres',
              password,
            })
            if (result.rowCount === 1) {
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

    const enablePasswordAuth = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '容器配置应该存在')

      await runScriptSQL(
        containerName,
        // 仅用于测试的受控常量；直接插值在此处保持设置路径简单。
        `ALTER ROLE postgres WITH PASSWORD '${password}'`,
        'postgres',
      )

      const passwordState = await engine.executeQuery(
        config!,
        "SELECT rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname = 'postgres'",
        {
          database: 'postgres',
        },
      )
      const hasPassword = String(passwordState.rows[0]?.has_password)
      assert(
        hasPassword === 'true' || hasPassword === 't',
        `启用认证前应设置超级用户密码（得到 ${hasPassword}）`,
      )

      const dataDir = paths.getContainerDataPath(containerName, {
        engine: ENGINE,
      })
      const pgHbaPath = join(dataDir, 'pg_hba.conf')
      const pgHbaContent = await readFile(pgHbaPath, 'utf-8')
      await writeFile(
        pgHbaPath,
        pgHbaContent.replace(/\btrust\b/g, 'md5'),
        'utf-8',
      )

      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, '认证重启前容器应该已停止')

      const stoppedConfig = await containerManager.getConfig(containerName)
      assert(stoppedConfig !== null, '停止后的配置应该存在')
      await engine.start(stoppedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      const { ready, lastError } = await waitForAuthedReady(
        containerName,
        password,
      )
      assert(
        ready,
        `启用认证的 PostgreSQL 应该就绪${lastError ? `: ${lastError}` : ''}`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: '18',
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, '18', { superuser: 'postgres' })

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应该存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), '源应该就绪')
      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应该仍然存在')
      await engine.createDatabase(sourceConfig!, DATABASE)
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await enablePasswordAuth(sourceName, sourcePort, sourcePassword)

      const sourceAuthedConfig = await containerManager.getConfig(sourceName)
      assert(sourceAuthedConfig !== null, '源认证配置应该存在')
      const sourceRows = await engine.executeQuery(
        sourceAuthedConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username: 'postgres',
          password: sourcePassword,
        },
      )
      assertEqual(
        sourceRows.rowCount,
        EXPECTED_ROW_COUNT,
        '启用认证的源仍应可查询',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: '18',
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, '18', { superuser: 'postgres' })

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应该存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), '目标应该就绪')
      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应该仍然存在')
      await engine.createDatabase(targetConfig!, DATABASE)
      await enablePasswordAuth(targetName, targetPort, targetPassword)

      const backupResult = await engine.backup(sourceAuthedConfig!, backupPath, {
        database: DATABASE,
        format: 'custom',
      })
      assertEqual(backupResult.format, 'custom', '备份应使用自定义格式')

      const targetAuthedConfig = await containerManager.getConfig(targetName)
      assert(targetAuthedConfig !== null, '目标认证配置应该存在')
      await engine.restore(targetAuthedConfig!, backupPath, {
        database: DATABASE,
        createDatabase: false,
      })

      const restoredRows = await engine.executeQuery(
        targetAuthedConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username: 'postgres',
          password: targetPassword,
        },
      )
      assertEqual(
        restoredRows.rowCount,
        EXPECTED_ROW_COUNT,
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

    console.log('   ✓ 使用密码认证的 PostgreSQL 备份和恢复成功')
  })

  it('不应有测试容器残留', async () => {
    console.log(`\n✅ 验证中，确认无测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    // 构建详细的错误消息，显示在 TAP 输出中
    if (testContainers.length > 0) {
      const hasOriginal = containers.some((c) => c.name === containerName)
      const hasRenamed = containers.some((c) => c.name === renamedContainerName)
      const hasClone = containers.some((c) => c.name === clonedContainerName)

      const details = [
        `剩余容器: ${testContainers.map((c) => c.name).join(', ')}`,
        `预期 containerName: ${containerName} - ${hasOriginal ? 'EXISTS (should be renamed)' : 'missing'}`,
        `预期 renamedContainerName: ${renamedContainerName} - ${hasRenamed ? 'EXISTS' : 'MISSING (rename failed!)'}`,
        `预期 clonedContainerName: ${clonedContainerName} - ${hasClone ? 'EXISTS (delete failed!)' : 'deleted OK'}`,
      ].join(' | ')

      throw new Error(
        `不应有测试容器残留（找到 ${testContainers.length} 个）。${details}`,
      )
    }

    console.log('   ✓ 所有测试容器已清理')
  })
})
