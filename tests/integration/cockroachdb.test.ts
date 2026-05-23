/**
 * CockroachDB 系统集成测试
 *
 * 使用真实的 CockroachDB 进程测试完整的容器生命周期。
 * CockroachDB 是一个兼容 PostgreSQL 有线协议的分布式 SQL 数据库。
 *
 * TODO: 拥有远程 CockroachDB 实例的测试环境后，为 dumpFromConnectionString 添加集成测试。
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

const ENGINE = Engine.CockroachDB
const DATABASE = 'defaultdb' // CockroachDB 默认数据库
const SEED_FILE = join(__dirname, '../fixtures/cockroachdb/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5 // 5 行用户数据
const TEST_VERSION = '25' // 主版本号

describe('CockroachDB 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n 正在清理现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    console.log('\n 正在查找可用的测试端口...')
    // CockroachDB 每个容器使用 2 个端口（SQL + HTTP），因此需要 6 个连续端口，
    // 每隔一个用于 SQL：[0]、[2]、[4] 以避免 HTTP 端口冲突
    const allPorts = await findConsecutiveFreePorts(
      6,
      TEST_PORTS.cockroachdb.base,
    )
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(`   使用端口：${testPorts.join(', ')}（HTTP 端口分别为 +1）`)

    containerName = generateTestName('cockroachdb-test')
    clonedContainerName = generateTestName('cockroachdb-test-clone')
    renamedContainerName = generateTestName('cockroachdb-test-renamed')
    portConflictContainerName = generateTestName('cockroachdb-test-conflict')
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }
  })

  it('应创建容器但不启动（--no-start）', async () => {
    console.log(`\n 正在创建容器 "${containerName}"，不启动...`)

    // 首先确保 CockroachDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 CockroachDB 二进制文件可用...')
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

    // 等待 CockroachDB 就绪（慢速 CI 运行器最长等待 120 秒，尤其是 Windows）
    const ready = await waitForReady(ENGINE, testPorts[0], 120000)
    assert(ready, 'CockroachDB 应准备好接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应使用 runScript 填充测试数据', async () => {
    console.log(`\n 正在使用 engine.runScript 填充测试数据...`)

    // 使用 runScriptFile，其内部调用 engine.runScript
    // 用于测试 `spindb run` 命令的功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT, '填充后应具有正确的行数')

    console.log(`   已通过 engine.runScript 填充 ${rowCount} 行数据`)
  })

  it('应创建用户并在重新创建时更新密码', async () => {
    console.log(`\n👤 正在测试 createUser...`)

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
    console.log('   ✓ 已创建用户并设置初始密码')

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', '密码应已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等操作）')
  })

  it('应通过备份/恢复克隆容器', async () => {
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

    // 先启动克隆容器（SQL 恢复需要容器运行）
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, '克隆容器的配置应存在')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待其就绪
    const ready = await waitForReady(ENGINE, testPorts[1], 90000)
    assert(ready, '克隆出的 CockroachDB 在恢复前应已就绪')

    // 从源容器创建备份
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `cockroachdb-test-backup-${Date.now()}.sql`,
    )

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })

      // 恢复到克隆容器
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      // 即使恢复失败也清理备份文件
      await rm(backupPath, { force: true })
    }

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
    assertEqual(rowCount, EXPECTED_ROW_COUNT, '恢复后的数据应具有相同的行数')

    console.log(`   已验证恢复的容器中有 ${rowCount} 行数据`)
  })

  it('应停止并删除已恢复的容器', async (t) => {
    // 在 Windows 上跳过 — CockroachDB 的 RocksDB 使用内存映射文件，
    // Windows 会长时间持有句柄，导致 EBUSY 错误
    if (process.platform === 'win32') {
      t.skip('删除测试在 Windows 上跳过（RocksDB 文件句柄锁定）')
      return
    }

    console.log(`\n 正在删除已恢复的容器 "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)

    // 等待容器完全停止
    const stopped = await waitForStopped(clonedContainerName, ENGINE)
    assert(stopped, '删除前容器应完全停止')

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已被清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证已不在容器列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === clonedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   容器已删除，文件系统已清理')
  })

  it('应使用 runScript 内联命令修改数据', async () => {
    console.log(`\n 正在使用 engine.runScript 内联命令删除一行...`)

    // 使用 runScriptSQL，其内部调用 engine.runScript 并传入 --sql 选项
    // CockroachDB 要求语句以分号结尾
    await runScriptSQL(
      containerName,
      'DELETE FROM test_user WHERE id = 5;',
      DATABASE,
    )

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    // 现在应剩下 4 行
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应比之前少一行')

    console.log(`   已通过 engine.runScript 删除一行，当前行数为 ${rowCount}`)
  })

  it('应停止、重命名容器并更改端口', async (t) => {
    // 在 Windows 上跳过 — RocksDB 持有文件句柄，会阻止重命名
    if (process.platform === 'win32') {
      t.skip('重命名测试在 Windows 上跳过（RocksDB 文件句柄锁定）')
      return
    }

    console.log(`\n 正在重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 停止容器
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止（PID 文件被删除）
    const stopped = await waitForStopped(containerName, ENGINE)
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

    console.log(`   已重命名为 "${renamedContainerName}"，端口 ${testPorts[2]}`)
  })

  it('应验证重命名后数据依然存在', async (t) => {
    // 在 Windows 上跳过 — 依赖被跳过的重命名测试
    if (process.platform === 'win32') {
      t.skip('重命名后验证在 Windows 上跳过（重命名测试已跳过）')
      return
    }

    console.log(`\n 正在验证重命名后数据依然存在...`)

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')

    // 启动重命名后的容器
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[2], 90000)
    assert(ready, '重命名后的 CockroachDB 应已就绪')

    // 验证行数反映删除结果
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '重命名后行数应保持不变')

    console.log(`   数据仍存在：${rowCount} 行`)
  })

  it('应妥善处理端口冲突', async (t) => {
    // 在 Windows 上跳过 — CockroachDB 端口冲突会导致不可恢复的状态，
    // 原有容器无法重启
    if (isWindows()) {
      t.skip('端口冲突测试在 Windows 上跳过（会导致不可恢复的状态）')
      return
    }

    console.log(`\n 正在测试端口冲突处理...`)

    const engine = getEngine(ENGINE)

    // 使用 try/finally 确保总是执行清理
    try {
      // 尝试在已被占用的端口（testPorts[2]）上创建容器
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 该端口正被重命名后的容器使用
        database: 'test_db', // 使用不同数据库，避免混淆
      })

      await engine.initDataDir(portConflictContainerName, TEST_VERSION, {
        port: testPorts[2],
      })

      // 验证容器已创建且端口为冲突端口
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, '容器应已创建')
      assertEqual(config?.port, testPorts[2], '端口最初应设置为冲突端口')

      // 尝试启动容器 — 应因端口冲突而失败
      // CockroachDB 使用 --background 模式，因此 start 命令可能返回，
      // 但服务器实际上因端口冲突而无法就绪
      let startFailed = false
      try {
        await engine.start(config!)
        // 如果启动未抛出错误，检查服务器是否真正就绪
        // 存在端口冲突时，CockroachDB 应该无法启动或报告未就绪
        const ready = await waitForReady(ENGINE, testPorts[2], 10000)
        if (!ready) {
          // 服务器未就绪，端口冲突的预期行为
          startFailed = true
        }
      } catch (error) {
        // 启动抛出错误，对于端口冲突也是可接受的
        startFailed = true
        console.log(
          `   启动如预期失败：${error instanceof Error ? error.message : error}`,
        )
      }

      console.log(
        startFailed
          ? '   端口冲突已检测到（启动失败或服务器未就绪）'
          : '   尽管有端口冲突，容器仍启动了（非预期，但已处理）',
      )

      // 若容器部分启动，则尝试停止
      try {
        await engine.stop(config!)
      } catch {
        // 忽略停止时的错误
      }
    } finally {
      // 始终清理端口冲突容器
      try {
        await containerManager.delete(portConflictContainerName, {
          force: true,
        })
        console.log(`   已清理端口冲突容器`)
      } catch {
        // 忽略清理错误 — 最终清理会处理
      }

      // 始终确保重命名后的容器为下一测试保持运行
      // 在 Windows 上，端口冲突可能导致两个容器都崩溃
      const renamedConfig =
        await containerManager.getConfig(renamedContainerName)
      if (renamedConfig) {
        const renamedRunning = await processManager.isRunning(
          renamedContainerName,
          { engine: ENGINE },
        )
        if (!renamedRunning) {
          console.log('   端口冲突测试后正在重启重命名后的容器...')
          await engine.start(renamedConfig)
          const ready = await waitForReady(ENGINE, testPorts[2], 90000)
          if (!ready) {
            console.log('   警告：重命名后的容器重启失败')
          } else {
            await containerManager.updateConfig(renamedContainerName, {
              status: 'running',
            })
            console.log('   重命名后的容器已成功重启')
          }
        }
      }
    }
  })

  it('启动已运行的容器时应显示警告', async (t) => {
    console.log(`\n 正在测试对已运行容器的启动操作...`)

    const config = await containerManager.getConfig(renamedContainerName)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      t.skip('未找到容器 — 之前的测试可能已失败')
      return
    }

    const engine = getEngine(ENGINE)

    // 检查容器是否在运行 — 如果未运行（例如 Windows 上端口冲突后），先启动它
    const initiallyRunning = await processManager.isRunning(
      renamedContainerName,
      {
        engine: ENGINE,
      },
    )

    if (!initiallyRunning) {
      console.log('   容器未运行，正在先启动...')
      await engine.start(config)
      const ready = await waitForReady(ENGINE, testPorts[2], 90000)
      if (!ready) {
        t.skip('容器启动失败 — 跳过重复启动测试')
        return
      }
      await containerManager.updateConfig(renamedContainerName, {
        status: 'running',
      })
    }

    // 现在容器应该正在运行
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    // 再次尝试启动不应抛出错误（幂等行为）
    await engine.start(config)

    // 应仍处于运行状态
    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(stillRunning, '重复启动后容器应仍处于运行状态')

    console.log('   容器已在运行（重复启动已妥善处理）')
  })

  it('应妥善处理对已停止容器的停止操作', async (t) => {
    console.log(`\n 正在测试对已停止容器的停止操作...`)

    const config = await containerManager.getConfig(renamedContainerName)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      t.skip('未找到容器 — 之前的测试可能已失败')
      return
    }

    const engine = getEngine(ENGINE)

    // 首先停止容器
    await engine.stop(config)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'stopped',
    })

    // 等待容器完全停止
    const stopped = await waitForStopped(renamedContainerName, ENGINE)
    assert(stopped, '容器应已完全停止')

    // 现在已停止，验证
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, '容器应已停止')

    // 再次尝试停止不应抛出错误（幂等行为）
    await engine.stop(config)

    // 仍处于停止状态
    const stillStopped = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!stillStopped, '重复停止后容器应仍处于停止状态')

    console.log('   重复停止已妥善处理（幂等操作）')
  })

  it('应使用 --force 删除容器', async (t) => {
    // 在 Windows 上跳过 — CockroachDB 的 RocksDB 使用内存映射文件，
    // Windows 会长时间持有句柄，导致 EBUSY 错误
    if (process.platform === 'win32') {
      t.skip('强制删除测试在 Windows 上跳过（RocksDB 文件句柄锁定）')
      return
    }

    console.log(`\n 正在强制删除容器 "${renamedContainerName}"...`)

    const config = await containerManager.getConfig(renamedContainerName)
    if (!config) {
      // 容器不存在（之前的测试可能已失败）
      console.log('   未找到容器 — 跳过删除测试')
      t.skip('未找到容器 — 之前的测试可能已失败')
      return
    }

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证已不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   容器已被强制删除')
  })

  it('应使用密码认证的安全本地模式进行备份和恢复', async () => {
    const sourceName = generateTestName('cockroachdb-auth-source-test')
    const targetName = generateTestName('cockroachdb-auth-target-test')
    const reservedPorts = await findConsecutiveFreePorts(
      4,
      TEST_PORTS.cockroachdb.base + 20,
    )
    const [sourcePort, , targetPort] = reservedPorts
    const username = 'auth_user'
    const sourcePassword = 'securepass123'
    const targetPassword = 'securepass456'

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `cockroachdb-auth-backup-${Date.now()}.sql`,
    )

    try {
      const engine = getEngine(ENGINE)

      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, {
        port: sourcePort,
      })

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应存在')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), '源容器应已就绪')

      await runScriptFile(sourceName, SEED_FILE, DATABASE)

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: sourcePassword,
        database: DATABASE,
      })
      await saveCredentials(sourceName, ENGINE, sourceCreds)

      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, '源容器配置应依然存在')
      const sourceRows = await engine.executeQuery(
        sourceConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username,
          password: sourcePassword,
        },
      )
      assertEqual(
        sourceRows.rowCount,
        EXPECTED_ROW_COUNT,
        '使用密码认证的源容器应仍可查询',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, {
        port: targetPort,
      })

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), '目标容器应已就绪')

      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: targetPassword,
        database: DATABASE,
      })
      await saveCredentials(targetName, ENGINE, targetCreds)

      const backupResult = await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'sql',
      })
      assertEqual(backupResult.format, 'sql', '备份应使用 SQL 格式')

      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应依然存在')
      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      const restoredRows = await engine.executeQuery(
        targetConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username,
          password: targetPassword,
        },
      )
      assertEqual(
        restoredRows.rowCount,
        EXPECTED_ROW_COUNT,
        '安全本地恢复应保留所有行',
      )
    } finally {
      await rm(backupPath, { force: true })
      await containerManager.delete(sourceName, { force: true }).catch(() => {})
      await containerManager.delete(targetName, { force: true }).catch(() => {})
    }
  })

  it('应确认没有残留的测试容器', async (t) => {
    // 在 Windows 上跳过 — 删除测试被跳过，因此容器会保留
    if (process.platform === 'win32') {
      t.skip('清理验证在 Windows 上跳过（删除测试已跳过）')
      return
    }

    console.log(`\n 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
