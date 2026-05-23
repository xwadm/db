/**
 * ClickHouse 系统集成测试
 *
 * 使用真实的 ClickHouse 进程测试完整的容器生命周期。
 * ClickHouse 是一个列式 OLAP 数据库。
 *
 * 注意：hostdb 提供的 ClickHouse 二进制文件仅适用于 macOS 和 Linux。
 * Windows 不受支持 — 这些测试将在 Windows 上跳过。
 *
 * TODO: 一旦有了包含远程 ClickHouse 实例的测试环境（例如通过 CI 中的 Docker Compose），
 * 就为 dumpFromConnectionString 添加集成测试。
 * 目前，连接字符串解析在 unit/clickhouse-restore.test.ts 中进行了测试。
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const __dirname = dirname(fileURLToPath(import.meta.url))

// 通过 hostdb 提供的 ClickHouse 二进制文件不支持 Windows
const IS_WINDOWS = process.platform === 'win32'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getRowCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'
import {
  getDefaultUsername,
  saveCredentials,
} from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.ClickHouse
const DATABASE = 'default' // ClickHouse 默认数据库
const SEED_FILE = join(__dirname, '../fixtures/clickhouse/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5 // 5 条用户行
const TEST_VERSION = '25.12' // YY.MM 格式版本（仅 macOS/Linux，不支持 Windows）

/**
 * 检查错误是否为已知的瞬态/良性错误，应重试
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  const message = err.message.toLowerCase()
  const errWithCode = err as NodeJS.ErrnoException

  // ENOENT - 二进制文件尚未找到（启动期间）
  if (errWithCode.code === 'ENOENT') return true

  // 连接被拒绝 - 服务器尚未就绪
  if (message.includes('connection refused')) return true
  if (message.includes('econnrefused')) return true

  // 启动期间网络不可达
  if (message.includes('network unreachable')) return true

  // ClickHouse 特定的瞬态错误
  if (message.includes('code: 210')) return true // NETWORK_ERROR
  if (message.includes('code: 209')) return true // SOCKET_TIMEOUT

  return false
}

/**
 * 等待表上的所有变更操作完成
 * ClickHouse 的变更操作（ALTER TABLE DELETE/UPDATE）是异步操作，
 * 在后台运行。此函数轮询 system.mutations 直到完成。
 */
async function waitForMutationsComplete(
  port: number,
  database: string,
  table: string,
  timeoutMs: number = 10000,
): Promise<void> {
  const startTime = Date.now()
  const pollInterval = 200

  const engine = getEngine(ENGINE)

  while (Date.now() - startTime < timeoutMs) {
    try {
      // 查询 system.mutations 表中该表上待处理的变更操作
      const clickhouse = await engine.getClickHouseClientPath()

      const query = `SELECT count() FROM system.mutations WHERE database = '${database}' AND table = '${table}' AND is_done = 0`
      const { stdout } = await execAsync(
        `"${clickhouse}" client --host 127.0.0.1 --port ${port} --database ${database} --query "${query}"`,
      )

      const pendingCount = parseInt(stdout.trim(), 10)
      if (isNaN(pendingCount)) {
        throw new Error(
          `[waitForMutationsComplete] 无法从输出中解析待处理变更计数："${stdout.trim()}"。查询："${query}"`,
        )
      }
      if (pendingCount === 0) {
        return // 所有变更操作已完成
      }
    } catch (err) {
      // 仅在已知瞬态错误时重试
      if (isTransientError(err)) {
        console.debug(
          `[waitForMutationsComplete] 瞬态错误，正在重试：${err instanceof Error ? err.message : String(err)}`,
        )
        // 继续下一次轮询迭代
      } else {
        // 意外错误 - 让测试明显失败
        throw new Error(
          `[waitForMutationsComplete] 轮询端口 ${port} 上 ${database}.${table} 的变更操作时出现意外错误：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 等待下一次轮询
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  throw new Error(`等待 ${database}.${table} 上的变更操作完成超时`)
}

describe(
  'ClickHouse 集成测试',
  {
    skip: IS_WINDOWS ? 'ClickHouse 二进制文件不适用于 Windows' : false,
  },
  () => {
    let testPorts: number[]
    let containerName: string
    let clonedContainerName: string
    let renamedContainerName: string
    let portConflictContainerName: string

    before(async () => {
      console.log('\n 正在清理任何现有的测试容器...')
      const deleted = await cleanupTestContainers()
      if (deleted.length > 0) {
        console.log(`   已删除：${deleted.join(', ')}`)
      }

      console.log('\n 正在查找可用的测试端口...')
      // ClickHouse 每个容器使用 2 个端口（TCP + HTTP），因此我们需要 6 个连续端口，
      // 并每隔一个用于 TCP：[0], [2], [4] 以避免 HTTP 端口冲突
      const allPorts = await findConsecutiveFreePorts(
        6,
        TEST_PORTS.clickhouse.base,
      )
      testPorts = [allPorts[0], allPorts[2], allPorts[4]]
      console.log(
        `   使用端口：${testPorts.join(', ')}（每个端口的 HTTP 端口分别为 +1）`,
      )

      containerName = generateTestName('clickhouse-test')
      clonedContainerName = generateTestName('clickhouse-test-clone')
      renamedContainerName = generateTestName('clickhouse-test-renamed')
      portConflictContainerName = generateTestName('clickhouse-test-conflict')
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

      // 首先确保 ClickHouse 二进制文件已下载
      const engine = getEngine(ENGINE)
      console.log('   正在确保 ClickHouse 二进制文件可用...')
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
      assertEqual(config?.status, 'created', '容器状态应为 "created"')

      const running = await processManager.isRunning(containerName, {
        engine: ENGINE,
      })
      assert(!running, '容器不应正在运行')

      console.log('   容器已创建且未运行')
    })

    it('应启动容器', async () => {
      console.log(`\n 正在启动容器 "${containerName}"...`)

      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '容器配置应存在')

      const engine = getEngine(ENGINE)
      await engine.start(config!)
      await containerManager.updateConfig(containerName, { status: 'running' })

      // 等待 ClickHouse 就绪（慢速 CI 运行器超时设为 120 秒）
      const ready = await waitForReady(ENGINE, testPorts[0], 120000)
      assert(ready, 'ClickHouse 应准备好接受连接')

      const running = await processManager.isRunning(containerName, {
        engine: ENGINE,
      })
      assert(running, '容器应正在运行')

      console.log('   容器已启动并就绪')
    })

    it('应使用 runScript 为数据库填充测试数据', async () => {
      console.log(`\n 正在使用 engine.runScript 填充测试数据...`)

      // 使用 runScriptFile，它内部调用 engine.runScript
      // 这将测试 `spindb run` 命令的功能
      await runScriptFile(containerName, SEED_FILE, DATABASE)

      const rowCount = await getRowCount(
        ENGINE,
        testPorts[0],
        DATABASE,
        'test_user',
      )
      assertEqual(rowCount, EXPECTED_ROW_COUNT, '填充后应具有正确的行数')

      console.log(`   已使用 engine.runScript 填充了 ${rowCount} 行`)
    })

    it('应使用 executeQuery 查询已填充的数据', async () => {
      logDebug('正在使用 engine.executeQuery 查询已填充的数据...')

      // 测试基本的 SELECT 查询
      const result = await executeQuery(
        containerName,
        'SELECT id, name, email FROM test_user ORDER BY id',
        DATABASE,
      )

      assertEqual(result.rowCount, EXPECTED_ROW_COUNT, '应返回所有行')
      assertDeepEqual(result.columns, ['id', 'name', 'email'], '应具有正确的列')

      // 验证第一行数据
      assertEqual(
        result.rows[0].name,
        'Alice Johnson',
        '第一行应为 Alice Johnson',
      )
      assertEqual(
        result.rows[0].email,
        'alice@example.com',
        '第一行电子邮件应匹配',
      )

      // 测试过滤查询
      const filteredResult = await executeQuery(
        containerName,
        "SELECT name FROM test_user WHERE email LIKE '%bob%'",
        DATABASE,
      )

      assertEqual(filteredResult.rowCount, 1, '应返回 Bob 所在的一行')
      assertEqual(filteredResult.rows[0].name, 'Bob Smith', '应找到 Bob Smith')

      logDebug(`查询返回了 ${result.rowCount} 行，且数据正确`)
    })

    it('应创建用户并在重新创建时更新密码', async () => {
      logDebug(`正在测试 createUser...`)

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
      logDebug('已使用初始密码创建用户')

      const creds2 = await engine.createUser(config!, {
        username: 'testuser',
        password: 'secondpass456',
        database: DATABASE,
      })
      assertEqual(creds2.password, 'secondpass456', '密码应已更新')
      logDebug('已使用新密码重新创建用户（幂等操作）')
    })

    it('应使用备份/恢复来克隆容器', async () => {
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

      // 先启动克隆容器（SQL 恢复需要）
      const clonedConfig = await containerManager.getConfig(clonedContainerName)
      assert(clonedConfig !== null, '克隆容器的配置应存在')

      await engine.start(clonedConfig!)
      await containerManager.updateConfig(clonedContainerName, {
        status: 'running',
      })

      // 等待它就绪
      const ready = await waitForReady(ENGINE, testPorts[1], 120000)
      assert(ready, '克隆的 ClickHouse 应在恢复前就绪')

      // 从源容器创建备份
      const { tmpdir } = await import('os')
      const backupPath = join(
        tmpdir(),
        `clickhouse-test-backup-${Date.now()}.sql`,
      )

      const sourceConfig = await containerManager.getConfig(containerName)
      assert(sourceConfig !== null, '源容器配置应存在')

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      // 恢复到克隆容器
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })

      // 清理备份文件
      const { rm } = await import('fs/promises')
      await rm(backupPath, { force: true })

      console.log('   已通过备份/恢复克隆容器')
    })

    it('应验证恢复的数据与源数据匹配', async () => {
      console.log(`\n 正在验证恢复的数据...`)

      const rowCount = await getRowCount(
        ENGINE,
        testPorts[1],
        DATABASE,
        'test_user',
      )
      assertEqual(rowCount, EXPECTED_ROW_COUNT, '恢复的数据应具有相同的行数')

      console.log(`   已验证恢复的容器中有 ${rowCount} 行`)
    })

    it('应使用密码认证的已保存本地用户凭证进行备份和恢复', async () => {
      console.log(`\n🔐 正在测试本地容器上带认证的 ClickHouse 备份/恢复...`)

      const allPorts = await findConsecutiveFreePorts(
        4,
        TEST_PORTS.clickhouse.base + 40,
      )
      const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
      const sourceName = generateTestName('clickhouse-auth-test-source')
      const targetName = generateTestName('clickhouse-auth-test-target')
      const sourcePassword = 'sourcepass123'
      const targetPassword = 'targetpass456'
      const username = getDefaultUsername(ENGINE)
      const { tmpdir } = await import('os')
      const { rm } = await import('fs/promises')
      const backupPath = join(
        tmpdir(),
        `clickhouse-auth-backup-${Date.now()}.sql`,
      )
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

        const sourceReady = await waitForReady(ENGINE, sourcePort, 120000)
        assert(sourceReady, '源 ClickHouse 应就绪')

        await runScriptFile(sourceName, SEED_FILE, DATABASE)

        const sourceCreds = await engine.createUser(sourceConfig!, {
          username,
          password: sourcePassword,
          database: DATABASE,
        })
        await saveCredentials(sourceName, ENGINE, sourceCreds)

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

        const targetReady = await waitForReady(ENGINE, targetPort, 120000)
        assert(targetReady, '目标 ClickHouse 应就绪')

        const targetCreds = await engine.createUser(targetConfig!, {
          username,
          password: targetPassword,
          database: DATABASE,
        })
        await saveCredentials(targetName, ENGINE, targetCreds)

        await engine.backup(sourceConfig!, backupPath, {
          database: DATABASE,
          format: 'sql',
        })

        await engine.restore(targetConfig!, backupPath, {
          database: DATABASE,
        })

        const result = await engine.executeQuery(
          targetConfig!,
          'SELECT count() AS count FROM test_user',
          {
            database: DATABASE,
            username: targetCreds.username,
            password: targetCreds.password,
          },
        )

        assertEqual(result.rowCount, 1, '应返回一个计数行')
        assertEqual(
          Number(result.rows[0].count),
          EXPECTED_ROW_COUNT,
          '恢复的带认证的 ClickHouse 数据应与源行数匹配',
        )

        console.log('   ✓ 备份和恢复在使用密码认证的 ClickHouse 上正常工作')
      } finally {
        await rm(backupPath, { force: true }).catch(() => {})

        const sourceConfig = await containerManager.getConfig(sourceName)
        if (sourceConfig) {
          await engine.stop(sourceConfig).catch(() => {})
          await waitForStopped(sourceName, ENGINE, 90000).catch(() => false)
          await containerManager
            .delete(sourceName, { force: true })
            .catch(() => {})
        }

        const targetConfig = await containerManager.getConfig(targetName)
        if (targetConfig) {
          await engine.stop(targetConfig).catch(() => {})
          await waitForStopped(targetName, ENGINE, 90000).catch(() => false)
          await containerManager
            .delete(targetName, { force: true })
            .catch(() => {})
        }
      }
    })

    it('应停止并删除恢复的容器', async () => {
      console.log(`\n 正在删除已恢复的容器 "${clonedContainerName}"...`)

      const config = await containerManager.getConfig(clonedContainerName)
      assert(config !== null, '容器配置应存在')

      const engine = getEngine(ENGINE)
      await engine.stop(config!)

      // 等待容器完全停止
      const stopped = await waitForStopped(clonedContainerName, ENGINE)
      assert(stopped, '容器在删除前应完全停止')

      await containerManager.delete(clonedContainerName, { force: true })

      // 验证文件系统已清理
      const exists = containerDataExists(clonedContainerName, ENGINE)
      assert(!exists, '容器数据目录应已删除')

      // 验证不在容器列表中
      const containers = await containerManager.list()
      const found = containers.find((c) => c.name === clonedContainerName)
      assert(!found, '容器不应在列表中')

      console.log('   容器已删除且文件系统已清理')
    })

    it('应使用 runScript 内联命令修改数据', async () => {
      console.log(`\n 正在使用 engine.runScript 内联命令删除一行...`)

      // 使用 runScriptSQL，它内部调用 engine.runScript 并带 --sql 选项
      await runScriptSQL(
        containerName,
        'ALTER TABLE test_user DELETE WHERE id = 5',
        DATABASE,
      )

      // 等待变更操作完成（ClickHouse 的变更操作是异步的）
      // 轮询 system.mutations 直到 DELETE 变更操作完成
      await waitForMutationsComplete(testPorts[0], DATABASE, 'test_user')

      const rowCount = await getRowCount(
        ENGINE,
        testPorts[0],
        DATABASE,
        'test_user',
      )
      // 现在应有 4 行
      assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应少一行')

      console.log(`   已使用 engine.runScript 删除一行，现在有 ${rowCount} 行`)
    })

    it('应停止、重命名容器并更改端口', async () => {
      console.log(`\n 正在重命名容器并更改端口...`)

      const config = await containerManager.getConfig(containerName)
      assert(config !== null, '容器配置应存在')

      // 停止容器
      const engine = getEngine(ENGINE)
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })

      // 等待容器完全停止（PID 文件已删除）
      // 这很重要，因为 rename() 在继续之前会检查 isRunning()
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, '容器在重命名前应完全停止')

      // 重命名容器并更改端口
      await containerManager.rename(containerName, renamedContainerName)
      await containerManager.updateConfig(renamedContainerName, {
        port: testPorts[2],
      })

      // ClickHouse 使用 config.xml 来设置端口，因此我们需要使用新端口重新生成它
      await engine.initDataDir(renamedContainerName, TEST_VERSION, {
        port: testPorts[2],
      })

      // 验证重命名
      const oldConfig = await containerManager.getConfig(containerName)
      assert(oldConfig === null, '旧容器名称不应存在')

      const newConfig = await containerManager.getConfig(renamedContainerName)
      assert(newConfig !== null, '重命名后的容器应存在')
      assertEqual(newConfig?.port, testPorts[2], '端口应已更新')

      console.log(
        `   已重命名为 "${renamedContainerName}"，端口为 ${testPorts[2]}`,
      )
    })

    it('应验证重命名后数据仍然存在', async () => {
      console.log(`\n 正在验证重命名后数据仍然存在...`)

      const config = await containerManager.getConfig(renamedContainerName)
      assert(config !== null, '容器配置应存在')

      // 启动重命名后的容器
      const engine = getEngine(ENGINE)
      await engine.start(config!)
      await containerManager.updateConfig(renamedContainerName, {
        status: 'running',
      })

      // 等待就绪
      const ready = await waitForReady(ENGINE, testPorts[2], 120000)
      assert(ready, '重命名后的 ClickHouse 应就绪')

      // 验证行数反映了删除操作
      const rowCount = await getRowCount(
        ENGINE,
        testPorts[2],
        DATABASE,
        'test_user',
      )
      assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '重命名后行数应保持不变')

      console.log(`   数据仍存在：${rowCount} 行`)
    })

    it('应妥善处理端口冲突', async () => {
      console.log(`\n⚠️  正在测试端口冲突处理...`)

      try {
        // 尝试在已被占用的端口上创建容器（testPorts[2]）
        await containerManager.create(portConflictContainerName, {
          engine: ENGINE,
          version: TEST_VERSION,
          port: testPorts[2], // 此端口正被重命名后的容器使用
          database: 'test_db', // 不同的数据库以避免混淆
        })

        const engine = getEngine(ENGINE)
        await engine.initDataDir(portConflictContainerName, TEST_VERSION, {
          port: testPorts[2],
        })

        // 容器应被创建，但当我们尝试启动时，它应检测到冲突
        // 在实际使用中，启动命令会自动分配新端口
        const config = await containerManager.getConfig(
          portConflictContainerName,
        )
        assert(config !== null, '容器应被创建')
        assertEqual(config?.port, testPorts[2], '端口最初应设置为冲突的端口')

        console.log('   ✓ 已在冲突端口上创建容器（启动时会自动重新分配）')
      } finally {
        // 始终清理此测试容器，即使测试失败
        await containerManager
          .delete(portConflictContainerName, { force: true })
          .catch(() => {
            // 忽略清理过程中的错误（如果创建失败，容器可能不存在）
          })
      }
    })

    it('启动已运行的容器时应显示警告', async () => {
      console.log(`\n 正在测试对已运行容器的启动操作...`)

      // 容器应已从之前的测试中开始运行
      const running = await processManager.isRunning(renamedContainerName, {
        engine: ENGINE,
      })
      assert(running, '容器应已处于运行状态')

      // 尝试再次启动不应抛出错误
      const config = await containerManager.getConfig(renamedContainerName)
      assert(config !== null, '容器配置应存在')

      const engine = getEngine(ENGINE)

      // 此操作应正常完成（幂等行为）
      await engine.start(config!)

      // 应仍处于运行状态
      const stillRunning = await processManager.isRunning(
        renamedContainerName,
        {
          engine: ENGINE,
        },
      )
      assert(stillRunning, '重复启动后容器应仍处于运行状态')

      console.log('   容器已运行（重复启动已妥善处理）')
    })

    it('应妥善处理对已停止容器的停止操作', async () => {
      console.log(`\n 正在测试对已停止容器的停止操作...`)

      // 首先停止容器
      const config = await containerManager.getConfig(renamedContainerName)
      assert(config !== null, '容器配置应存在')

      const engine = getEngine(ENGINE)
      await engine.stop(config!)
      await containerManager.updateConfig(renamedContainerName, {
        status: 'stopped',
      })

      // 等待容器完全停止
      const stopped = await waitForStopped(renamedContainerName, ENGINE)
      assert(stopped, '容器应已完全停止')

      // 现在它已停止，进行验证
      const running = await processManager.isRunning(renamedContainerName, {
        engine: ENGINE,
      })
      assert(!running, '容器应处于停止状态')

      // 尝试再次停止不应抛出错误（幂等行为）
      // 注意：警告消息已记录但此处未验证，以保持测试简洁
      await engine.stop(config!)

      // 仍处于停止状态
      const stillStopped = await processManager.isRunning(
        renamedContainerName,
        {
          engine: ENGINE,
        },
      )
      assert(!stillStopped, '重复停止后容器应仍处于停止状态')

      console.log('   重复停止已妥善处理（幂等操作）')
    })

    it('应使用 --force 删除容器', async () => {
      console.log(`\n 正在强制删除容器 "${renamedContainerName}"...`)

      await containerManager.delete(renamedContainerName, { force: true })

      // 验证文件系统已清理
      const exists = containerDataExists(renamedContainerName, ENGINE)
      assert(!exists, '容器数据目录应已删除')

      // 验证不在列表中
      const containers = await containerManager.list()
      const found = containers.find((c) => c.name === renamedContainerName)
      assert(!found, '容器不应在列表中')

      console.log('   容器已强制删除')
    })

    it('不应有测试容器残留', async () => {
      console.log(`\n 正在验证没有测试容器残留...`)

      const containers = await containerManager.list()
      const testContainers = containers.filter((c) => c.name.includes('-test'))

      assertEqual(testContainers.length, 0, '不应有测试容器残留')

      console.log('   所有测试容器已清理')
    })
  },
)
