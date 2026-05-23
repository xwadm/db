/**
 * FerretDB 系统集成测试
 *
 * 使用真实的 FerretDB 进程测试完整的容器生命周期。
 * FerretDB 是一个兼容 MongoDB 的代理，将数据存储在 PostgreSQL 中。
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
const TEST_VERSION = '2' // 主版本号 - 将通过版本映射解析为完整版本

describe('FerretDB 集成测试', () => {
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

    console.log('\n🔍 正在查找可用测试端口...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.ferretdb.base)
    console.log(`   使用端口：${testPorts.join(', ')}`)

    containerName = generateTestName('ferretdb-test')
    clonedContainerName = generateTestName('ferretdb-test-clone')
    renamedContainerName = generateTestName('ferretdb-test-renamed')
    portConflictContainerName = generateTestName('ferretdb-test-conflict')
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

    // 首先确保 FerretDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 FerretDB 二进制文件可用...')
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
    assert(ready, 'FerretDB 应准备好接受连接')

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

    // 测试基本 find 查询（FerretDB 使用 MongoDB JavaScript 语法）
    // 按 id 字段排序（而非 _id，后者自动生成）
    // 必须调用 .toArray() 将游标转为数组，以便 JSON 序列化
    const result = await executeQuery(
      containerName,
      'test_user.find({}).sort({id: 1}).toArray()',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, '应返回所有文档')

    // 验证第一条文档数据（按 id 排序，所以 id:1 = Alice Johnson）
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      '第一条文档应为 Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      '第一条文档的邮箱应匹配',
    )

    // 测试过滤查询
    const filteredResult = await executeQuery(
      containerName,
      'test_user.find({email: /bob/}).toArray()',
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, '应返回 Bob 所在的一条文档')
    assertEqual(filteredResult.rows[0].name, 'Bob Smith', '应找到 Bob Smith')

    // 验证列中包含预期字段
    assertTruthy(result.columns.includes('name'), '列应包含 name')
    assertTruthy(result.columns.includes('email'), '列应包含 email')

    logDebug(`查询返回了 ${result.rowCount} 条文档，数据正确`)
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
    console.log('   ✓ 已使用初始密码创建用户')

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', '密码应已更新')
    console.log('   ✓ 已使用新密码重新创建用户（幂等操作）')
  })

  it('应通过备份/恢复克隆容器', async () => {
    console.log(`\n📋 正在通过备份/恢复创建容器 "${clonedContainerName}"...`)

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
    assert(ready, '克隆出的 FerretDB 应已就绪')

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应存在')

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const dumpPath = join(tmpdir(), `ferretdb-test-dump-${Date.now()}.archive`)

    await engine.backup(sourceConfig!, dumpPath, {
      database: DATABASE,
      format: 'archive',
    })

    try {
      await engine.restore(config!, dumpPath, {
        database: DATABASE,
      })
    } finally {
      // 无论恢复成功与否，都清理转储文件
      await rm(dumpPath, { force: true })
    }

    console.log('   ✓ 已通过备份/恢复克隆容器')
  })

  it('应验证恢复的数据与源数据匹配', async () => {
    console.log(`\n🔍 正在验证恢复的数据...`)
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      DATABASE,
      'test_user',
    )

    assertEqual(rowCount, EXPECTED_ROW_COUNT, '恢复后的数据应具有相同的文档数')
    console.log(`   ✓ 已验证恢复容器中的 ${rowCount} 条文档`)
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

    // 验证不在容器列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === clonedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   ✓ 容器已删除且文件系统已清理')
  })

  it('应使用 runScript 内联 JavaScript 修改数据', async () => {
    console.log(`\n✏️ 正在使用 engine.runScript 内联 JS 删除一条文档...`)

    // 对兼容 MongoDB 的引擎 (FerretDB) 使用 runScriptJS
    // 这是 runScriptSQL 的别名，使意图更清晰
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
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应减少一条文档')

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
    assert(oldConfig === null, '旧容器名不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应存在')
    assertEqual(newConfig?.port, testPorts[2], '端口应已更新')

    console.log(
      `   ✓ 已重命名为 "${renamedContainerName}"，端口 ${testPorts[2]}`,
    )
  })

  it('应验证重命名后数据仍然存在', async () => {
    console.log(`\n🔍 正在验证重命名后数据是否仍然存在...`)

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
    assert(ready, '重命名后的 FerretDB 应已就绪')

    // 验证文档数反映了删除操作
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '重命名后文档数应保持不变')

    console.log(`   ✓ 数据仍存在：${rowCount} 条文档`)
  })

  it('应妥善处理端口冲突', async () => {
    console.log(`\n⚠️ 正在测试端口冲突处理...`)

    // 尝试在已被占用的端口（testPorts[2]）上创建容器
    await containerManager.create(portConflictContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[2], // 此端口正被重命名后的容器使用
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

    // 容器应已创建，但启动时应检测到冲突
    const config = await containerManager.getConfig(portConflictContainerName)
    assert(config !== null, '容器应已创建')
    assertEqual(config?.port, testPorts[2], '端口最初应设置为冲突端口')

    try {
      // 尝试启动容器 - 这应该要么：
      // 1. 因端口冲突错误而失败，或
      // 2. 若引擎自动检测并处理冲突，则成功
      await engine.start(config!)
      await containerManager.updateConfig(portConflictContainerName, {
        status: 'running',
      })

      // 如果启动成功，验证容器正在运行
      const running = await processManager.isRunning(
        portConflictContainerName,
        {
          engine: ENGINE,
        },
      )

      if (running) {
        // 检查端口是否已重新分配（行为因引擎而异）
        const updatedConfig = await containerManager.getConfig(
          portConflictContainerName,
        )
        console.log(
          `   ✓ 容器已启动（端口：${updatedConfig?.port}，冲突处理成功）`,
        )

        // 清理前停止容器
        await engine.stop(updatedConfig!)
        await waitForStopped(portConflictContainerName, ENGINE)
      } else {
        console.log('   ✓ 容器启动尝试后未运行（已检测到端口冲突）')
      }
    } catch (error) {
      // 端口冲突错误是预期行为
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
      // 无论通过与否，清理此测试容器
      await containerManager.delete(portConflictContainerName, { force: true })
    }
  })

  it('启动已运行的容器时应显示警告', async () => {
    console.log(`\n⚠️ 正在测试对已运行容器的启动操作...`)

    // 容器应已从之前的测试中开始运行
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '容器应已处于运行状态')

    // 再次尝试启动不应抛出异常
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)

    // 这应当正常完成（幂等行为）
    await engine.start(config!)

    // 应仍处于运行状态
    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(stillRunning, '重复启动后容器应仍处于运行状态')

    console.log('   ✓ 容器已在运行（重复启动已妥善处理）')
  })

  it('应在部分关闭后重启（孤立的 PG 后端）', async () => {
    console.log(`\n🔄 正在测试部分关闭后的重启（代理被终止，PG 后端仍存活）...`)

    // 容器应已从之前的测试中开始运行
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, '容器配置应存在')
    assert(config!.backendPort !== undefined, 'backendPort 应已设置')

    const containerDir = paths.getContainerPath(renamedContainerName, {
      engine: ENGINE,
    })
    const ferretPidFile = join(containerDir, 'ferretdb.pid')

    // 1. 读取 FerretDB 代理 PID 并仅终止代理
    const pidContent = await readFile(ferretPidFile, 'utf8')
    const proxyPid = parseInt(pidContent.trim(), 10)
    assert(!isNaN(proxyPid), 'FerretDB 代理 PID 应有效')
    assert(
      platformService.isProcessRunning(proxyPid),
      'FerretDB 代理应正在运行',
    )

    // 直接终止代理进程（模拟崩溃）
    await platformService.terminateProcess(proxyPid, true)

    // 等待进程确实结束（SIGKILL 是异步的）
    const killStart = Date.now()
    while (
      platformService.isProcessRunning(proxyPid) &&
      Date.now() - killStart < 5000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await unlink(ferretPidFile).catch(() => {})

    // 2. 验证代理已死亡，但 PG 后端仍在 backendPort 上存活
    assert(
      !platformService.isProcessRunning(proxyPid),
      '终止后 FerretDB 代理应已死亡',
    )

    // processManager.isRunning 检查 ferretdb.pid 文件 — 现在应为 false
    const proxyRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!proxyRunning, 'processManager 应报告未运行（代理已死亡）')

    // 但 PG 后端应仍在监听
    const pgAlive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(config!.backendPort!, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.setTimeout(2000, () => {
        socket.destroy()
        resolve(false)
      })
    })
    assert(pgAlive, 'PostgreSQL 后端应仍在 backendPort 上运行')

    // 3. 再次调用 start() — 这应成功（检测到 PG 正在运行，仅启动代理）
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 4. 验证一切正常
    const ready = await waitForReady(ENGINE, config!.port)
    assert(ready, '重启后 FerretDB 应已就绪')

    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, '重启后 FerretDB 应正在运行')

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

    // 现已停止，验证
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, '容器应已停止')

    // 再次尝试停止不应抛出异常（幂等行为）
    await engine.stop(config!)
    console.log('   ✓ 容器已停止（重复停止已妥善处理）')
  })

  it('应使用 --force 删除容器', async () => {
    console.log(`\n🗑️ 正在强制删除容器 "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // 验证文件系统已清理
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, '容器数据目录应已删除')

    // 验证不在列表中
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, '容器不应出现在列表中')

    console.log('   ✓ 容器已强制删除')
  })

  it('应使用密码认证的本地 root 凭证进行备份和恢复', async () => {
    console.log(`\n🔐 正在测试本地容器上带认证的 FerretDB 备份/恢复...`)

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.ferretdb.base + 40,
    )
    const sourceName = generateTestName('ferretdb-auth-test-source')
    const targetName = generateTestName('ferretdb-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `ferretdb-auth-backup-${Date.now()}.archive`,
    )
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
      const connectionString = `mongodb://root:${encodeURIComponent(password)}@127.0.0.1:${port}/admin?authSource=admin`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=root',
          `DB_PASSWORD=${password}`,
          'DB_HOST=127.0.0.1',
          `DB_PORT=${port}`,
          'DB_NAME=admin',
          `DB_URL=${connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const waitForAuthedReady = async (
      containerName: string,
      timeoutMs = 30000,
    ): Promise<{ ready: boolean; lastError: string | null }> => {
      const startTime = Date.now()
      let lastError: string | null = null
      while (Date.now() - startTime < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(
              config,
              'db.runCommand({ ping: 1 })',
              {
                database: 'admin',
              },
            )
            if (result.rowCount === 1) {
              return { ready: true, lastError: null }
            }
          }
        } catch (error) {
          lastError =
            error instanceof Error ? error.message : '未知的认证就绪错误'
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
      assert(config !== null, '容器配置应存在')

      await runScriptJS(
        containerName,
        `db.getSiblingDB('admin').createUser({ user: 'root', pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] })`,
        'admin',
      )
      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, {
        status: 'stopped',
        authEnabled: true,
      })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, '认证重启前容器应完全停止')

      const updatedConfig = await containerManager.getConfig(containerName)
      assert(updatedConfig !== null, '更新后的容器配置应存在')
      await engine.start(updatedConfig!)
      await containerManager.updateConfig(containerName, {
        status: 'running',
      })

      const authReady = await waitForAuthedReady(containerName)
      assert(
        authReady.ready,
        `启用认证的 FerretDB 应已就绪（${authReady.lastError ?? '无错误'}）`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })

      await engine.initDataDir(sourceName, TEST_VERSION, {})
      await engine.initDataDir(targetName, TEST_VERSION, {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      const targetConfig = await containerManager.getConfig(targetName)
      assert(sourceConfig !== null, '源容器配置应存在')
      assert(targetConfig !== null, '目标容器配置应存在')

      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(sourceReady, '源 FerretDB 在启用认证前应已就绪')
      assert(targetReady, '目标 FerretDB 在启用认证前应已就绪')

      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      const seededCount = await getRowCount(
        ENGINE,
        sourcePort,
        DATABASE,
        'test_user',
      )
      assertEqual(
        seededCount,
        EXPECTED_ROW_COUNT,
        '已填充的源容器在认证前应包含预期的文档数',
      )

      await enablePasswordAuth(sourceName, sourcePort, sourcePassword)
      await enablePasswordAuth(targetName, targetPort, targetPassword)

      const authedSourceConfig = await containerManager.getConfig(sourceName)
      const authedTargetConfig = await containerManager.getConfig(targetName)
      assert(authedSourceConfig !== null, '认证源容器配置应存在')
      assert(authedTargetConfig !== null, '认证目标容器配置应存在')

      await engine.backup(authedSourceConfig!, backupPath, {
        database: DATABASE,
        format: 'archive',
      })

      await engine.restore(authedTargetConfig!, backupPath, {
        database: DATABASE,
        sourceDatabase: DATABASE,
      })

      const restoredResult = await executeQuery(
        targetName,
        'db.test_user.find({}).sort({id: 1})',
        DATABASE,
      )
      assertEqual(
        restoredResult.rowCount,
        EXPECTED_ROW_COUNT,
        '恢复后的 FerretDB 应包含预期的文档数',
      )
      assertEqual(
        restoredResult.rows[0].name,
        'Alice Johnson',
        '第一条恢复的文档应与源数据匹配',
      )

      console.log('   ✓ 备份和恢复在密码认证的 FerretDB 上正常工作')
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      for (const containerName of [sourceName, targetName]) {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager.isRunning(containerName, {
            engine: ENGINE,
          })
          if (running) {
            await engine.stop(config).catch(() => {})
          }
          await containerManager
            .delete(containerName, { force: true })
            .catch(() => {})
        }
      }
    }
  })

  it('应确认没有测试容器残留', async () => {
    console.log(`\n✅ 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 所有测试容器已清理')
  })
})
