/**
 * FerretDB v1 系统集成测试
 *
 * 使用真实的 FerretDB v1 进程测试完整的容器生命周期。
 * FerretDB v1 使用纯 PostgreSQL 作为后端（无 DocumentDB 扩展）。
 * v1 支持包括 Windows 在内的所有平台。
 */

import { describe, it, before, after } from 'node:test'
import net from 'net'
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
  runScriptJS,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { readFile, unlink } from 'fs/promises'

const ENGINE = Engine.FerretDB
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/ferretdb/seeds/sample-db.js')
const EXPECTED_ROW_COUNT = 5
const TEST_VERSION = '1' // FerretDB v1 - 使用纯 PostgreSQL 后端

describe('FerretDB v1 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n🧹 正在清理现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    console.log('\n🔍 正在查找可用的测试端口...')
    testPorts = await findConsecutiveFreePorts(
      3,
      TEST_PORTS['ferretdb-v1'].base,
    )
    console.log(`   使用端口：${testPorts.join(', ')}`)

    containerName = generateTestName('ferretdb-v1-test')
    clonedContainerName = generateTestName('ferretdb-v1-test-clone')
    renamedContainerName = generateTestName('ferretdb-v1-test-renamed')
    portConflictContainerName = generateTestName('ferretdb-v1-test-conflict')
  })

  after(async () => {
    console.log('\n🧹 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }
  })

  it('应创建容器但不启动（--no-start）', async () => {
    console.log(`\n📦 正在创建容器 "${containerName}" 但不启动...`)

    // 首先确保 FerretDB v1 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 FerretDB v1 二进制文件可用...')
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

    // 验证容器已存在但未运行
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')
    assertEqual(config?.status, 'created', '容器状态应为“created”')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, '容器不应处于运行状态')

    console.log('   ✓ 容器已创建且未运行')
  })

  it('应启动容器', async () => {
    console.log(`\n▶️ 正在启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 FerretDB 就绪
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'FerretDB v1 应准备好接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应正在运行')

    console.log('   ✓ 容器已启动并就绪')
  })

  it('应使用 runScript 填充测试数据', async () => {
    console.log(`\n🌱 正在使用 engine.runScript 填充测试数据...`)

    // 使用 runScriptFile，其内部调用 engine.runScript
    // 用于测试 `spindb run` 命令的功能
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT, '填充后应具有正确的文档数')

    console.log(`   ✓ 已通过 engine.runScript 填充 ${rowCount} 个文档`)
  })

  it('应使用 executeQuery 查询已填充的数据', async () => {
    logDebug('正在使用 engine.executeQuery 查询已填充的数据...')

    // 测试基本的 find 查询（FerretDB 使用 MongoDB JavaScript 语法）
    // 按 id 字段排序（而非 _id，因为 _id 是自动生成的）
    // 必须调用 .toArray() 将游标转换为数组以进行 JSON 序列化
    const result = await executeQuery(
      containerName,
      'test_user.find({}).sort({id: 1}).toArray()',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, '应返回所有文档')

    // 验证第一个文档的数据（按 id 排序，所以 id:1 = Alice Johnson）
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      '第一个文档应为 Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      '第一个文档的电子邮件应匹配',
    )

    // 测试过滤查询
    const filteredResult = await executeQuery(
      containerName,
      'test_user.find({email: /bob/}).toArray()',
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, '应返回 Bob 所在的一个文档')
    assertEqual(filteredResult.rows[0].name, 'Bob Smith', '应找到 Bob Smith')

    // 验证列包含预期的字段
    assertTruthy(result.columns.includes('name'), '列应包含 name')
    assertTruthy(result.columns.includes('email'), '列应包含 email')

    logDebug(`查询返回了 ${result.rowCount} 个文档，数据正确`)
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

  it('应通过连接字符串创建新容器（转储/恢复）', async () => {
    console.log(`\n📋 正在通过连接字符串创建容器 "${clonedContainerName}"...`)

    // 创建容器
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    // 初始化并启动
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {})

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '克隆容器的配置应存在')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, '克隆出的 FerretDB v1 应已就绪')

    // FerretDB 备份/恢复在后端使用 PostgreSQL 的 pg_dump/pg_restore
    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const dumpPath = join(tmpdir(), `ferretdb-v1-test-dump-${Date.now()}.dump`)

    await engine.backup(sourceConfig!, dumpPath, {
      database: DATABASE,
      format: 'archive',
    })

    // 启动后重新读取配置以获取 backendPort
    const updatedConfig = await containerManager.getConfig(clonedContainerName)
    assert(updatedConfig !== null, '更新后的克隆容器配置应存在')

    try {
      await engine.restore(updatedConfig!, dumpPath, {
        database: DATABASE,
      })
    } finally {
      // 无论恢复成功与否，都清理转储文件
      await rm(dumpPath, { force: true })
    }

    console.log('   ✓ 已通过连接字符串创建容器')
  })

  it('应验证恢复的数据与源数据匹配', async () => {
    console.log(`\n🔍 正在验证恢复的数据...`)

    // FerretDB v1 使用纯 PostgreSQL 后端（无 DocumentDB 扩展），
    // 因此 pg_dump/pg_restore 应该能干净地工作，不会出现
    // 影响 v2 postgresql-documentdb 后端的元数据冲突。
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      DATABASE,
      'test_user',
    )

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '恢复后的数据应具有相同的文档数（v1 使用纯 PostgreSQL - 无 DocumentDB 冲突）',
    )

    console.log(`   ✓ 已验证恢复的容器中有 ${rowCount} 个文档`)
  })

  it('应停止并删除已恢复的容器', async () => {
    console.log(`\n🗑️ 正在删除已恢复的容器 "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)

    // 等待容器完全停止
    const stopped = await waitForStopped(clonedContainerName, ENGINE)
    assert(stopped, '删除前容器应完全停止')

    await containerManager.delete(clonedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证已不在容器列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === clonedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   ✓ 容器已删除且文件系统已清理')
  })

  it('应使用 runScript 内联 JavaScript 修改数据', async () => {
    console.log(`\n✏️ 正在使用 engine.runScript 内联 JS 删除一个文档...`)

    // 对 MongoDB 兼容引擎（FerretDB）使用 runScriptJS
    await runScriptJS(
      containerName,
      "db.test_user.deleteOne({email: 'eve@example.com'})",
      DATABASE,
    )

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应比之前少一个文档')

    console.log(
      `   ✓ 已通过 engine.runScript 删除文档，当前文档数为 ${rowCount}`,
    )
  })

  it('应停止、重命名容器并更改端口', async () => {
    console.log(`\n📝 正在重命名容器并更改端口...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 停止容器
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // 等待容器完全停止（PID 文件已删除）
    const stopped = await waitForStopped(containerName, ENGINE)
    assert(stopped, '重命名前容器应完全停止')

    // 重命名容器并更改端口
    await containerManager.rename(containerName, renamedContainerName)
    await containerManager.updateConfig(renamedContainerName, {
      port: testPorts[2],
    })

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名称不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应存在')
    assertEqual(newConfig?.port, testPorts[2], '端口应已更新')

    console.log(
      `   ✓ 已重命名为 "${renamedContainerName}"，端口为 ${testPorts[2]}`,
    )
  })

  it('应验证重命名后数据依然存在', async () => {
    console.log(`\n🔍 正在验证重命名后数据依然存在...`)

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')

    // 启动重命名后的容器
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 等待就绪
    const ready = await waitForReady(ENGINE, testPorts[2])
    assert(ready, '重命名后的 FerretDB v1 应已就绪')

    // 验证文档数反映了删除操作
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '重命名后文档数应保持不变')

    console.log(`   ✓ 数据仍存在：${rowCount} 个文档`)
  })

  it('应妥善处理端口冲突', async () => {
    console.log(`\n⚠️ 正在测试端口冲突处理...`)

    // 尝试在已被占用的端口上创建容器（testPorts[2]）
    await containerManager.create(portConflictContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[2], // 该端口正被重命名后的容器使用
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

    // 容器应已创建，但当我们尝试启动时，应检测到冲突
    const config = await containerManager.getConfig(portConflictContainerName)
    assert(config !== null, '容器应已创建')
    assertEqual(config?.port, testPorts[2], '端口最初应设置为冲突端口')

    try {
      await engine.start(config!)
      await containerManager.updateConfig(portConflictContainerName, {
        status: 'running',
      })

      const running = await processManager.isRunning(
        portConflictContainerName,
        {
          engine: ENGINE,
        },
      )

      if (running) {
        const updatedConfig = await containerManager.getConfig(
          portConflictContainerName,
        )
        console.log(
          `   ✓ 容器已启动（端口：${updatedConfig?.port}，冲突处理成功）`,
        )

        await engine.stop(updatedConfig!)
        await waitForStopped(portConflictContainerName, ENGINE)
      } else {
        console.log('   ✓ 已尝试启动容器，但未运行（检测到端口冲突）')
      }
    } catch (error) {
      const e = error as Error
      assert(
        e.message.includes('port') ||
          e.message.includes('address') ||
          e.message.includes('EADDRINUSE') ||
          e.message.includes('in use'),
        `预期出现端口冲突错误，实际错误：${e.message}`,
      )
      console.log(`   ✓ 已检测到端口冲突，错误信息：${e.message}`)
    } finally {
      await containerManager.delete(portConflictContainerName, { force: true })
    }
  })

  it('启动已运行的容器时应显示警告', async () => {
    console.log(`\n⚠️ 正在测试对已运行容器的启动操作...`)

    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '容器应已处于运行状态')

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)

    // 此操作应正常完成（幂等行为）
    await engine.start(config!)

    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(stillRunning, '重复启动后容器应仍处于运行状态')

    console.log('   ✓ 容器已在运行（重复启动已妥善处理）')
  })

  it('部分关闭后应能重启（孤立的 PG 后端）', async () => {
    console.log(
      `\n🔄 正在测试部分关闭后的重启（代理进程被终止，PG 后端仍存活）...`,
    )

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')
    assert(config!.backendPort !== undefined, 'backendPort 应已设置')

    const containerDir = paths.getContainerPath(renamedContainerName, {
      engine: ENGINE,
    })
    const ferretPidFile = join(containerDir, 'ferretdb.pid')

    // 1. 读取 FerretDB 代理进程 PID 并只终止代理进程
    const pidContent = await readFile(ferretPidFile, 'utf8')
    const proxyPid = parseInt(pidContent.trim(), 10)
    assert(!isNaN(proxyPid), 'FerretDB 代理进程 PID 应有效')
    assert(
      platformService.isProcessRunning(proxyPid),
      'FerretDB 代理进程应正在运行',
    )

    // 直接终止代理进程（模拟崩溃）
    await platformService.terminateProcess(proxyPid, true)

    // 等待进程实际终止（SIGKILL 是异步的）
    const killStart = Date.now()
    while (
      platformService.isProcessRunning(proxyPid) &&
      Date.now() - killStart < 5000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await unlink(ferretPidFile).catch(() => {})

    // 2. 验证代理进程已终止，但 PG 后端在 backendPort 上仍存活
    assert(
      !platformService.isProcessRunning(proxyPid),
      '终止后 FerretDB 代理进程应已死亡',
    )

    const proxyRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!proxyRunning, 'processManager 应报告未运行（代理进程已死亡）')

    // 但 PG 后端应仍在监听
    const pgAlive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(config!.backendPort!, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.setTimeout(2000, () => {
        socket.destroy()
        resolve(false)
      })
    })
    assert(pgAlive, 'PostgreSQL 后端应仍在 backendPort 上运行')

    // 3. 再次调用 start() — 应成功（检测到 PG 正在运行，仅启动代理进程）
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 4. 验证一切正常
    const ready = await waitForReady(ENGINE, config!.port)
    assert(ready, '重启后 FerretDB v1 应已就绪')

    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '重启后 FerretDB v1 应正在运行')

    // 验证数据仍可访问
    const rowCount = await getRowCount(
      ENGINE,
      config!.port,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      '部分关闭重启后数据应完好无损',
    )

    console.log('   ✓ 部分关闭后重启成功，数据完好')
  })

  it('停止已停止的容器时应显示警告', async () => {
    console.log(`\n⚠️ 正在测试对已停止容器的停止操作...`)

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

    // 现在已停止，进行验证
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, '容器应已停止')

    // 再次尝试停止不应抛出错误（幂等行为）
    await engine.stop(config!)
    console.log('   ✓ 容器已停止（重复停止已妥善处理）')
  })

  it('应使用 --force 删除容器', async () => {
    console.log(`\n🗑️ 正在强制删除容器 "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证已不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   ✓ 容器已强制删除')
  })

  it('应确认没有残留的测试容器', async () => {
    console.log(`\n✅ 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 所有测试容器已清理')
  })
})
