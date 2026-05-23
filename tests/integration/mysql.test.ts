/**
 * MySQL 系统集成测试
 *
 * 使用真实 MySQL 进程测试完整的容器生命周期。
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

const ENGINE = Engine.MySQL
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/mysql/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5
const TEST_VERSION = '9' // 主版本号 - 将通过版本映射解析为完整版本

describe('MySQL 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n🧹 清理中...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n🔍 查找可用测试端口...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.mysql.base)
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('mysql-test')
    clonedContainerName = generateTestName('mysql-test-clone')
    renamedContainerName = generateTestName('mysql-test-renamed')
    portConflictContainerName = generateTestName('mysql-test-conflict')
  })

  after(async () => {
    console.log('\n🧹 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  it('创建容器但不启动 (--no-start)', async () => {
    console.log(
      `\n📦 创建容器 "${containerName}" 但不启动...`,
    )

    // 确保已下载 MySQL 二进制文件
    const engine = getEngine(ENGINE)
    console.log('   正在确保 MySQL 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // 初始化数据库集群
    await engine.initDataDir(containerName, TEST_VERSION, {
      superuser: 'root',
    })

    // 验证容器存在但未运行
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')
    assertEqual(
      config?.status,
      'created',
      "容器状态应为 'created'",
    )

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, '容器不应该正在运行')

    console.log('   ✓ 容器已创建但未运行')
  })

  it('启动容器', async () => {
    console.log(`\n▶️  启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 MySQL 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'MySQL 应该已就绪，可以接受连接')

    // 创建用户数据库
    await engine.createDatabase(config!, DATABASE)

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   ✓ 容器已启动并就绪')
  })

  it('使用 runScript 用测试数据填充数据库', async () => {
    console.log(
      `\n🌱 用测试数据填充数据库，使用 engine.runScript...`,
    )

    // 使用 runScriptFile，它内部调用 engine.runScript
    // 这测试了 `spindb run` 命令的功能
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

  it('使用 executeQuery 查询已填充的数据', async () => {
    console.log(`\n🔍 使用 engine.executeQuery 查询已填充的数据...`)

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

    assertEqual(filteredResult.rowCount, 1, '应返回 Bob 的一行')
    assertEqual(
      filteredResult.rows[0].name,
      'Bob Smith',
      '应找到 Bob Smith',
    )

    console.log(`   ✓ 查询返回了 ${result.rowCount} 行正确数据`)
  })

  it('创建用户并在重新创建时更新密码', async () => {
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
    console.log('   ✓ 用户创建成功（初始密码）')

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', '密码应该已更新')
    console.log('   ✓ 使用新密码重新创建用户（幂等）')
  })

  it('通过连接字符串创建新容器（dump/restore）', async () => {
    console.log(
      `\n📋 通过连接字符串创建容器 "${clonedContainerName}"...`,
    )

    const sourceConnectionString = getConnectionString(
      ENGINE,
      testPorts[0],
      DATABASE,
    )

    // 创建容器
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    // 初始化并启动
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {
      superuser: 'root',
    })

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '克隆容器配置应该存在')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, '克隆的 MySQL 应该已就绪')

    // 创建数据库
    await engine.createDatabase(config!, DATABASE)

    // 从源转储并恢复到目标
    const { tmpdir } = await import('os')
    const dumpPath = join(tmpdir(), `mysql-test-dump-${Date.now()}.sql`)

    await engine.dumpFromConnectionString(sourceConnectionString, dumpPath)
    await engine.restore(config!, dumpPath, {
      database: DATABASE,
      createDatabase: false,
    })

    // 清理转储文件
    const { rm } = await import('fs/promises')
    await rm(dumpPath, { force: true })

    console.log('   ✓ 容器已通过连接字符串创建')
  })

  it('验证恢复的数据与源匹配', async () => {
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

  it('备份为 SQL 格式 (.sql)', async () => {
    console.log(`\n📦 测试 SQL 格式备份 (.sql)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `mysql-sql-backup-${Date.now()}.sql`)

    // 使用 'sql' 格式备份生成纯 SQL
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

  it('备份为压缩格式 (.sql.gz)', async () => {
    console.log(`\n📦 测试压缩格式备份 (.sql.gz)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `mysql-dump-backup-${Date.now()}.sql.gz`)

    // 使用 'compressed' 格式备份生成压缩 SQL
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'compressed',
    })

    assert(result.path === backupPath, '备份路径应该匹配')
    assert(result.format === 'compressed', '格式应为 compressed')
    assert(result.size > 0, '备份应该有内容')

    // 验证文件为 gzip 格式（以 gzip 魔数 1f 8b 开头）
    const { readFile } = await import('fs/promises')
    const buffer = await readFile(backupPath)
    assert(
      buffer[0] === 0x1f && buffer[1] === 0x8b,
      '备份应有 gzip 头',
    )

    // 清理
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ 压缩备份已创建，大小 ${result.size} 字节`)
  })

  it('从压缩格式恢复并验证数据', async () => {
    console.log(`\n📥 测试压缩格式恢复...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '容器配置应该存在')

    // 从源创建压缩备份
    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `mysql-gz-restore-${Date.now()}.sql.gz`)

    const backupResult = await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'compressed',
    })
    console.log(`   备份已创建: ${backupResult.size} 字节`)

    // 在克隆容器中创建新数据库用于恢复测试
    const testDb = 'restore_test_db'
    await engine.createDatabase(config!, testDb)
    console.log(`   数据库 ${testDb} 已创建`)

    // 将压缩备份恢复到新数据库
    const restoreResult = await engine.restore(config!, backupPath, {
      database: testDb,
      createDatabase: false,
    })
    console.log(
      `   恢复结果: code=${restoreResult.code}, stderr=${restoreResult.stderr || '无'}`,
    )

    // 检查恢复结果是否有错误
    if (restoreResult.code !== 0 && restoreResult.code !== undefined) {
      throw new Error(
        `恢复失败，返回码 ${restoreResult.code}: ${restoreResult.stderr}`,
      )
    }

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

    console.log(`   ✓ 压缩恢复已验证，共 ${rowCount} 行`)
  })

  it('停止并删除已恢复的容器', async () => {
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

  it('使用 runScript 内联 SQL 修改数据', async () => {
    console.log(
      `\n✏️  使用 engine.runScript 内联 SQL 删除一行...`,
    )

    // 使用 runScriptSQL，它内部调用 engine.runScript 并带 --sql 选项
    // 这测试了 `spindb run --sql` 命令的功能
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

  it('停止、重命名容器并更改端口', async () => {
    console.log(`\n📝 重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    // 停止容器
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止（PID 文件已移除）
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

  it('验证重命名后数据持久化', async () => {
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
    assert(ready, '重命名后的 MySQL 应该已就绪')

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

  it('优雅处理端口冲突', async () => {
    console.log(`\n⚠️  测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器（testPorts[2]）
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 该端口已被重命名后的容器使用
        database: 'conflictdb',
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, TEST_VERSION, {
        superuser: 'root',
      })

      // 容器应该已创建，但当我们尝试启动时，应检测到冲突
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
          // 忽略清理期间的错误（如果创建失败，容器可能不存在）
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

    // 这应该正常完成而不抛出异常（幂等行为）
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
      '   ✓ 容器已在运行（重复启动已优雅处理）',
    )
  })

  it('优雅处理停止已停止的容器', async () => {
    console.log(`\n⚠️  测试停止已停止的容器...`)

    // 先停止容器
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
    // （在实际 CLI 使用中，这会显示警告消息）
    console.log('   ✓ 容器已停止（在 CLI 中会显示警告）')
  })

  it('使用 --force 删除容器', async () => {
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

  it('使用密码认证的本地 root 凭据进行备份和恢复', async () => {
    console.log(`\n🔐 测试认证感知的 MySQL 备份/恢复...`)

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.mysql.authBase,
    )
    const sourceName = generateTestName('mysql-auth-test-source')
    const targetName = generateTestName('mysql-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `mysql-auth-backup-${Date.now()}.sql.gz`)
    const engine = getEngine(ENGINE)

    // 写入默认凭据文件
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
      const connectionString = `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE}`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=root',
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

    // 等待认证就绪
    const waitForAuthedReady = async (containerName: string, timeoutMs = 30000) => {
      const start = Date.now()
      let lastError: string | null = null

      while (Date.now() - start < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(
              config,
              'SELECT 1 AS ok',
              { database: DATABASE },
            )
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

    // 启用 root 密码认证
    const enableRootPasswordAuth = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const escapedPassword = password.replace(/'/g, "''")
      await runScriptSQL(
        containerName,
        [
          `CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '${escapedPassword}'`,
          `ALTER USER 'root'@'%' IDENTIFIED BY '${escapedPassword}'`,
          `ALTER USER 'root'@'localhost' IDENTIFIED BY '${escapedPassword}'`,
          "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION",
          "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION",
          'FLUSH PRIVILEGES',
        ].join('; ') + ';',
      )

      await writeDefaultCredentialFile(containerName, port, password)

      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '认证重启前容器配置应该存在')
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, '认证重启前容器应该已停止')

      const stoppedConfig = await containerManager.getConfig(containerName)
      assert(stoppedConfig !== null, '停止后的配置应该存在')
      await engine.start(stoppedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      const { ready, lastError } = await waitForAuthedReady(containerName)
      assert(
        ready,
        `MySQL 应该已使用密码认证就绪${lastError ? ` (${lastError})` : ''}`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, { superuser: 'root' })

      const sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应该存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), '源 MySQL 应该已就绪')
      await engine.createDatabase(sourceConfig!, DATABASE)
      await runScriptFile(sourceName, SEED_FILE, DATABASE)

      await enableRootPasswordAuth(sourceName, sourcePort, sourcePassword)

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, { superuser: 'root' })

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应该存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), '目标 MySQL 应该已就绪')
      await engine.createDatabase(targetConfig!, DATABASE)

      await enableRootPasswordAuth(targetName, targetPort, targetPassword)

      const authedSource = await containerManager.getConfig(sourceName)
      assert(authedSource !== null, '启用认证的源配置应该存在')
      await engine.backup(authedSource!, backupPath, {
        database: DATABASE,
        format: 'compressed',
      })

      const authedTarget = await containerManager.getConfig(targetName)
      assert(authedTarget !== null, '启用认证的目标配置应该存在')
      const restoreResult = await engine.restore(authedTarget!, backupPath, {
        database: DATABASE,
      })
      assert(
        restoreResult.code === 0 || restoreResult.code === undefined,
        `恢复应该成功，返回码 ${restoreResult.code}`,
      )

      const verifyResult = await engine.executeQuery(
        authedTarget!,
        'SELECT COUNT(*) AS count FROM test_user',
        { database: DATABASE },
      )
      assertEqual(
        String(verifyResult.rows[0]?.count),
        String(EXPECTED_ROW_COUNT),
        '密码认证下恢复的 MySQL 行数应与源匹配',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})
      await containerManager.delete(sourceName, { force: true }).catch(() => {})
      await containerManager.delete(targetName, { force: true }).catch(() => {})
    }
  })

  it('不应有测试容器残留', async () => {
    console.log(`\n✅ 验证中没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 所有测试容器已清理')
  })
})
