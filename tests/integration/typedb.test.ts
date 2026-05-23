/**
 * TypeDB 系统集成测试
 *
 * 使用真实 TypeDB 进程测试完整的容器生命周期。
 * TypeDB 是一个强类型数据库，用于知识表示和推理，
 * 拥有自己的查询语言 (TypeQL)。
 *
 * TODO: 一旦我们拥有远程 TypeDB 实例的测试环境，
 * 添加 dumpFromConnectionString 的集成测试。
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
  executeQuery,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import {
  getDefaultUsername,
  saveCredentials,
} from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.TypeDB
const DATABASE = 'test_tdb' // 与 sample-db.tqls 中的数据库名匹配
const SEED_FILE = join(__dirname, '../fixtures/typedb/seeds/sample-db.tqls')
const EXPECTED_ROW_COUNT = 5 // 5 个 test_user 实体
const TEST_VERSION = '3' // 主版本

/**
 * 使用控制台通过 reduce count 查询获取 TypeDB 实体计数。
 * TypeDB 控制台 --command 模式不支持多步事务流程，
 * 因此我们使用临时脚本文件配合 --script。
 */
async function getTypeDBRowCount(
  port: number,
  database: string,
  entityType: string,
): Promise<number> {
  const { spawn } = await import('child_process')
  const { writeFile, unlink } = await import('fs/promises')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { getConsoleBaseArgs } = await import('../../engines/typedb/cli-utils')

  const engine = getEngine(ENGINE)
  const consolePath = await engine
    .getTypeDBConsolePath(TEST_VERSION)
    .catch(() => {
      throw new Error('未找到 TypeDB 控制台二进制文件')
    })

  const query = `match $u isa ${entityType}; reduce $c = count;`
  const scriptContent = `transaction read ${database}\n\n${query}\n\nclose\n`
  const tempScript = join(
    tmpdir(),
    `spindb-typedb-count-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
  )

  try {
    await writeFile(tempScript, scriptContent, 'utf-8')

    const stdout = await new Promise<string>((resolve, reject) => {
      const args = [...getConsoleBaseArgs(port), '--script', tempScript]
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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
    })

    // 从 TypeDB 输出中解析计数 - 格式: "$c | 5"
    const countMatch = stdout.match(/\$c\s*\|\s*(\d+)/)
    if (countMatch) {
      return parseInt(countMatch[1], 10)
    }

    logDebug(`无法从输出中解析 TypeDB 计数: ${stdout}`)
    return 0
  } catch (error) {
    console.error('获取 TypeDB 行数时出错:', error)
    return 0
  } finally {
    await unlink(tempScript).catch(() => {})
  }
}

describe('TypeDB 集成测试', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string
  // 在 Windows 上，重命名被跳过，因此容器保持其原始名称
  const getActiveContainerName = () =>
    process.platform === 'win32' ? containerName : renamedContainerName

  before(async () => {
    console.log('\n 清理中，删除所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    console.log('\n 查找可用测试端口...')
    // TypeDB 每个容器使用 1 个主端口（HTTP 端口为主端口 + 6271）
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.typedb.base)
    // 同时验证 HTTP 端口（主端口 + 6271）是否空闲
    const { portManager } = await import('../../core/port-manager')
    for (const port of testPorts) {
      const httpPort = port + 6271
      const httpFree = await portManager.isPortAvailable(httpPort)
      if (!httpFree) {
        throw new Error(
          `HTTP 端口 ${httpPort}（主端口 ${port}）正在使用中；无法继续 TypeDB 测试。`,
        )
      }
    }
    console.log(`   使用端口: ${testPorts.join(', ')}`)

    containerName = generateTestName('typedb-test')
    clonedContainerName = generateTestName('typedb-test-clone')
    renamedContainerName = generateTestName('typedb-test-renamed')
    portConflictContainerName = generateTestName('typedb-test-conflict')
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }
  })

  it('应该创建容器但不启动 (--no-start)', async () => {
    console.log(`\n 创建容器 "${containerName}" 但不启动...`)

    // 首先确保 TypeDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 TypeDB 二进制文件可用...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

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

    console.log('   容器已创建但未运行')
  })

  it('应该启动容器', async () => {
    console.log(`\n 启动容器 "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // 等待 TypeDB 就绪（慢速 CI 运行器 60 秒超时）
    const ready = await waitForReady(ENGINE, testPorts[0], 60000)
    assert(ready, 'TypeDB 应该就绪以接受连接')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, '容器应该正在运行')

    console.log('   容器已启动并就绪')
  })

  it('应该创建数据库', async () => {
    console.log(`\n 创建数据库 "${DATABASE}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.createDatabase(config!, DATABASE)

    console.log(`   数据库 "${DATABASE}" 已创建`)
  })

  it('应该使用 runScript 用测试数据填充数据库', async () => {
    console.log(`\n 使用 engine.runScript 用测试数据填充数据库...`)

    // 使用 runScriptFile，它内部调用 engine.runScript
    // 种子文件 (.tqls) 包含 schema + 数据的事务命令
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getTypeDBRowCount(
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '填充后应有正确的行数',
    )

    console.log(`   已填充 ${rowCount} 个实体，使用 engine.runScript`)
  })

  it('应该使用 executeQuery 查询已填充的数据', async () => {
    logDebug('使用 engine.executeQuery 查询已填充的数据...')

    // 测试基本 fetch 查询 (TypeQL 语法)
    const result = await executeQuery(
      containerName,
      'match $u isa test_user; fetch { "name": $u.name };',
      DATABASE,
    )

    // TypeDB 返回原始控制台输出作为单个结果
    assertEqual(result.rowCount, 1, '应返回原始结果')

    // 结果应包含用户名
    const output = result.rows[0].result as string
    assert(output.includes('Alice'), '结果应包含 Alice')
    assert(output.includes('Bob'), '结果应包含 Bob')

    logDebug('查询返回了预期数据')
  })

  it('应该创建用户', async () => {
    console.log(`\n 测试 createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)

    const creds = await engine.createUser(config!, {
      username: 'testuser',
      password: 'testpass123',
      database: DATABASE,
    })
    assertEqual(creds.username, 'testuser', '用户名应该匹配')
    assertEqual(creds.password, 'testpass123', '密码应该匹配')
    console.log('   用户创建成功')
  })

  // BUG-13 回归测试：createUser 的 "已存在" 回退路径使用了
  // 错误的控制台子命令（`user password-update` 而非
  // 规范的 `user update-password`），因此每次对
  // 已有用户的密码轮换都会静默失败。Layerbase-cloud 在每次
  // 新 TypeDB 部署时通过 setup-database.sh 的
  // `spindb users create <db> admin --password <pw>` 调用此路径 —
  // 失败会导致 TypeDB 保持默认的 `admin/password`，而云端存储轮换后的
  // 值，表现为每次查询时出现 401 AUT1 错误。
  //
  // 我们在此避免轮换内置 admin，因为后续测试
  // （以及测试工具的清理路径）以 admin/password 身份认证。
  // 相反，创建一个新用户两次并使用不同密码 —
  // 第二次调用会走 "已存在" → update-password 分支。
  it('应该对已有用户轮换密码（BUG-13 回归测试）', async () => {
    console.log(`\n 测试对已有用户进行 createUser 密码轮换...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    const rotationUser = 'bug13user'

    // 第一次调用走 `user create` 正常路径。
    await engine.createUser(config!, {
      username: rotationUser,
      password: 'initial-pw-456',
      database: DATABASE,
    })

    // 第二次调用触发 `user create` → "已存在" → 进入
    // `user update-password <name> <newpw>`。在 BUG-13 修复前，
    // 这会抛出 `Failed to update user password: Unrecognised 'user'
    // subcommand: 'password-update bug13user rotated-pw-789'`。
    const rotated = await engine.createUser(config!, {
      username: rotationUser,
      password: 'rotated-pw-789',
      database: DATABASE,
    })
    assertEqual(rotated.username, rotationUser, '用户名应该匹配')
    assertEqual(
      rotated.password,
      'rotated-pw-789',
      '返回的密码应该是轮换后的密码',
    )

    console.log('   对已有用户的密码轮换成功')
  })

  it('应该使用备份/恢复克隆容器', async () => {
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
    assert(ready, '克隆的 TypeDB 应该就绪')

    // 从源创建备份
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `typedb-test-backup-${Date.now()}.typeql`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, '源容器配置应该存在')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'typeql',
      })

      // 恢复到克隆容器（TypeDB 导入会创建数据库）
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      // 清理备份文件（TypeDB 创建 schema + data 文件）
      const schemaPath = backupPath.replace(/\.typeql$/, '-schema.typeql')
      const dataPath = backupPath.replace(/\.typeql$/, '-data.typeql')
      await rm(backupPath, { force: true })
      await rm(schemaPath, { force: true })
      await rm(dataPath, { force: true })
    }

    console.log('   容器已通过备份/恢复克隆')
  })

  it('应该验证恢复的数据与源匹配', async () => {
    console.log(`\n 验证恢复的数据...`)

    const rowCount = await getTypeDBRowCount(
      testPorts[1],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '恢复的数据应有相同的行数',
    )

    console.log(`   已在恢复的容器中验证 ${rowCount} 个实体`)
  })

  it('应该使用保存的 TypeDB 凭据备份和恢复', async () => {
    console.log('\n 测试认证支持的 TypeDB 备份/恢复...')

    const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.typedb.base + 20)
    const targetPort = allPorts[2]
    const targetName = generateTestName('typedb-auth-test-target')
    const username = getDefaultUsername(ENGINE)
    const sourcePassword = 'typedbSourcePass123'
    const targetPassword = 'typedbTargetPass456'
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `typedb-auth-backup-${Date.now()}.typeql`)
    const engine = getEngine(ENGINE)

    try {
      const { portManager } = await import('../../core/port-manager')
      const targetHttpPort = targetPort + 6271
      const targetHttpFree = await portManager.isPortAvailable(targetHttpPort)
      assert(
        targetHttpFree,
        `TypeDB sidecar HTTP 端口 ${targetHttpPort} 应该空闲`,
      )

      const sourceConfig = await containerManager.getConfig(containerName)
      assert(sourceConfig !== null, '源容器配置应该存在')

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: sourcePassword,
      })
      await saveCredentials(containerName, ENGINE, sourceCreds)

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, '目标容器配置应该存在')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })

      const targetReady = await waitForReady(ENGINE, targetPort, 60000)
      assert(targetReady, '目标 TypeDB 应该就绪')

      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: targetPassword,
      })
      await saveCredentials(targetName, ENGINE, targetCreds)

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'typeql',
      })

      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      const restored = await engine.executeQuery(
        targetConfig!,
        'match $u isa test_user; fetch { "name": $u.name };',
        {
          username: targetCreds.username,
          password: targetCreds.password,
        },
      )

      assertEqual(restored.rowCount, 1, 'TypeDB executeQuery 应返回原始输出')
      const output = restored.rows[0].result as string
      assert(output.includes('Alice'), '恢复的 TypeDB 数据应包含 Alice')
      assert(output.includes('Bob'), '恢复的 TypeDB 数据应包含 Bob')

      console.log('   保存凭据的 TypeDB 备份/恢复成功')
    } finally {
      const schemaPath = backupPath.replace(/\.typeql$/, '-schema.typeql')
      const dataPath = backupPath.replace(/\.typeql$/, '-data.typeql')
      await rm(backupPath, { force: true }).catch(() => {})
      await rm(schemaPath, { force: true }).catch(() => {})
      await rm(dataPath, { force: true }).catch(() => {})

      const targetConfig = await containerManager.getConfig(targetName)
      if (targetConfig) {
        await engine.stop(targetConfig).catch(() => {})
        await waitForStopped(targetName, ENGINE, 90000).catch(() => false)
        await containerManager.delete(targetName, { force: true }).catch(
          () => {},
        )
      }
    }
  })

  it('应该停止并删除已恢复的容器', async (t) => {
    // 在 Windows 上跳过 - Rust 二进制文件可能持有文件句柄
    if (process.platform === 'win32') {
      t.skip('删除测试在 Windows 上跳过（文件句柄锁定）')
      return
    }

    console.log(`\n 删除已恢复的容器 "${clonedContainerName}"...`)

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

  it('应该使用 runScript 内联命令修改数据', async () => {
    console.log(
      `\n 删除一个实体，使用 engine.runScript 内联命令...`,
    )

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    await engine.runScript(config, {
      sql: 'match $u isa test_user, has id 5; delete $u;',
      transactionType: 'write',
      database: DATABASE,
    })

    const rowCount = await getTypeDBRowCount(
      testPorts[0],
      DATABASE,
      'test_user',
    )
    // 现在应该有 4 个实体
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应该少一个实体')

    console.log(`   实体已删除，现有 ${rowCount} 个实体`)
  })

  it('应该停止、重命名容器并更改端口', async (t) => {
    // 在 Windows 上跳过 - Rust 二进制文件可能持有文件句柄
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

  it('应该验证重命名后数据持久化', async (t) => {
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
    assert(ready, '重命名的 TypeDB 应该就绪')

    // 验证行数反映删除
    const rowCount = await getTypeDBRowCount(
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      '重命名后实体数应保持不变',
    )

    console.log(`   数据已持久化: ${rowCount} 个实体`)
  })

  it('应该优雅处理端口冲突', async () => {
    console.log(`\n 测试端口冲突处理...`)

    try {
      // 尝试在已使用的端口上创建容器 (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // 此端口被重命名后的容器使用
        database: 'test_db',
      })

      // 容器应该被创建，但当我们尝试启动时，应该检测到冲突
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, '容器应该被创建')
      assertEqual(
        config?.port,
        testPorts[2],
        '端口最初应设置为冲突端口',
      )

      console.log(
        '   容器已使用冲突端口创建（启动时会自动重新分配）',
      )
    } finally {
      // 始终清理此测试容器
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // 清理期间忽略错误
        })
    }
  })

  it('启动已运行容器时应该显示警告', async (t) => {
    console.log(`\n 测试启动已运行容器...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
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

    // 再次尝试启动不应抛出异常（幂等行为）
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

  it('应该优雅处理停止已停止的容器', async (t) => {
    console.log(`\n 测试停止已停止的容器...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      t.skip('容器未找到 - 之前的测试可能已失败')
      return
    }

    const engine = getEngine(ENGINE)

    // 首先停止容器
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

    // 再次尝试停止不应抛出异常（幂等行为）
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

  it('应该使用 --force 删除容器', async (t) => {
    // 在 Windows 上跳过 - Rust 二进制文件可能持有文件句柄
    if (process.platform === 'win32') {
      t.skip('强制删除测试在 Windows 上跳过（文件句柄锁定）')
      return
    }

    const activeContainer = getActiveContainerName()
    console.log(`\n 强制删除容器 "${activeContainer}"...`)

    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
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

  it('不应该有测试容器残留', async (t) => {
    // 在 Windows 上跳过 - 删除测试被跳过，容器会残留
    if (process.platform === 'win32') {
      t.skip('清理验证在 Windows 上跳过（删除测试已跳过）')
      return
    }

    console.log(`\n 验证中没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
