/**
 * DuckDB 集成测试
 *
 * 测试 DuckDB 的完整容器生命周期。
 * 与 SQLite 类似，DuckDB 基于文件，没有服务器进程。
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, renameSync } from 'fs'
import { rm, mkdir } from 'fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { generateTestName, cleanupTestContainers } from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import { configManager } from '../../core/config-manager'
import { Engine } from '../../types'

// 从引擎获取 duckdb 可执行文件路径的辅助函数
async function getDuckDBPath(): Promise<string> {
  const engine = getEngine(Engine.DuckDB)
  const path = await engine.getDuckDBPath()
  if (!path) {
    throw new Error('未找到 duckdb。请运行：spindb engines download duckdb')
  }
  return path
}

// 验证我们使用的是下载的二进制文件，而不是系统自带的
async function verifyUsingDownloadedBinaries(): Promise<void> {
  const config = await configManager.getBinaryConfig('duckdb')
  if (!config) {
    throw new Error('未配置 duckdb。请运行：spindb engines download duckdb')
  }
  if (config.source === 'system') {
    throw new Error(
      '测试正在使用系统自带的 duckdb，而非下载的二进制文件。' +
        '这会导致测试在发现解压错误时不可靠。' +
        '请运行：spindb engines download duckdb 1',
    )
  }
}

// 检查 DuckDB 文件是否存在的辅助函数
function duckdbFileExists(filePath: string): boolean {
  return existsSync(filePath)
}

// 对 DuckDB 数据库文件执行 SQL 查询的辅助函数
async function queryDuckDB(dbPath: string, sql: string): Promise<string> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  const duckdb = await getDuckDBPath()

  const { stdout } = await execFileAsync(duckdb, [
    dbPath,
    '-noheader',
    '-list',
    '-c',
    sql,
  ])
  return stdout.trim()
}

const ENGINE = Engine.DuckDB
const SEED_FILE = join(__dirname, '../fixtures/duckdb/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5
const TEST_DIR_BASE = join(__dirname, '../.test-duckdb')

describe('DuckDB 集成测试', () => {
  let testDir: string
  let containerName: string
  let backupContainerName: string
  let renamedContainerName: string
  let dbPath: string
  let backupDbPath: string

  before(async () => {
    // 首先确保 DuckDB 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 DuckDB 二进制文件可用...')
    await engine.ensureBinaries('1', ({ message }) => {
      console.log(`   ${message}`)
    })

    // 验证我们使用的是下载的二进制文件，而不是系统自带的
    // 这能确保测试实际验证了二进制文件的解压流程
    await verifyUsingDownloadedBinaries()

    console.log('\n 正在清理现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    // 每次运行创建唯一的测试目录，以避免冲突
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testDir = `${TEST_DIR_BASE}-${runId}`
    await mkdir(testDir, { recursive: true })

    containerName = generateTestName('duckdb-test')
    backupContainerName = generateTestName('duckdb-test-backup')
    renamedContainerName = generateTestName('duckdb-test-renamed')
    dbPath = join(testDir, `${containerName}.duckdb`)
    backupDbPath = join(testDir, `${backupContainerName}.duckdb`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除：${deleted.join(', ')}`)
    }

    // 清理测试目录
    if (testDir && existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('应使用 --path 选项创建 DuckDB 数据库', async () => {
    console.log(`\n 正在创建 DuckDB 数据库 "${containerName}"...`)

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '1',
      port: 0, // DuckDB 不使用端口
      database: dbPath,
    })

    // 初始化数据库（创建文件）
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, '1', { path: dbPath })

    // 验证容器已存在
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')
    assertEqual(config?.database, dbPath, '数据库路径应匹配')

    // 验证文件已存在
    assert(duckdbFileExists(dbPath), 'DuckDB 数据库文件应存在')

    console.log(`   数据库已创建于 ${dbPath}`)
  })

  it('应以 "available" 状态列出 DuckDB 容器', async () => {
    console.log(`\n 正在列出 DuckDB 容器...`)

    const containers = await containerManager.list()
    const duckdbContainers = containers.filter((c) => c.engine === ENGINE)

    assert(duckdbContainers.length > 0, '应至少有一个 DuckDB 容器')

    const ourContainer = duckdbContainers.find((c) => c.name === containerName)
    assert(ourContainer !== undefined, '应找到我们的测试容器')

    // DuckDB 使用 'running' 状态表示文件存在
    assertEqual(
      ourContainer?.status,
      'running',
      '状态应为 "running"（文件存在）',
    )

    console.log(`   找到 ${duckdbContainers.length} 个 DuckDB 容器`)
  })

  it('应使用 runScript 填充测试数据', async () => {
    console.log(`\n 正在填充测试数据...`)

    // 使用 engine.runScript 填充数据库
    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    await engine.runScript(config!, { file: SEED_FILE })

    // 直接通过 duckdb 查询行数
    const rowCount = parseInt(
      await queryDuckDB(dbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(rowCount, EXPECTED_ROW_COUNT, '填充后应具有正确的行数')

    console.log(`   已填充 ${rowCount} 行数据`)
  })

  it('应使用 runScript 运行内联 SQL', async () => {
    console.log(`\n 正在运行内联 SQL...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    // 删除一行
    await engine.runScript(config!, {
      sql: "DELETE FROM test_user WHERE email = 'eve@example.com'",
    })

    // 验证删除操作
    const rowCount = parseInt(
      await queryDuckDB(dbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应比之前少一行')

    console.log(`   已删除一行，当前行数为 ${rowCount}`)
  })

  it('应备份数据库（二进制格式）并恢复', async () => {
    console.log(`\n 正在创建二进制备份并恢复...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')

    const engine = getEngine(ENGINE)
    const backupPath = join(testDir, 'backup.duckdb')

    // 创建二进制备份
    const result = await engine.backup(config!, backupPath, {
      format: 'binary',
      database: config!.database,
    })
    assert(existsSync(result.path), '备份文件应存在')

    // 创建新容器并恢复
    await containerManager.create(backupContainerName, {
      engine: ENGINE,
      version: '1',
      port: 0,
      database: backupDbPath,
    })
    await engine.initDataDir(backupContainerName, '1', { path: backupDbPath })

    const backupConfig = await containerManager.getConfig(backupContainerName)
    assert(backupConfig !== null, '备份容器的配置应存在')

    await engine.restore(backupConfig!, backupPath)

    // 验证恢复的数据
    const rowCount = parseInt(
      await queryDuckDB(backupDbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '恢复的数据应与源数据匹配')

    // 清理备份文件
    await rm(backupPath, { force: true })

    console.log(`   已创建二进制备份并恢复，包含 ${rowCount} 行数据`)
  })

  it('应迁移数据库文件并更新注册表', async () => {
    console.log(`\n 正在迁移数据库文件...`)

    // 为迁移创建子目录
    const relocateDir = join(testDir, 'relocated')
    await mkdir(relocateDir, { recursive: true })

    const newDbPath = join(relocateDir, `${containerName}.duckdb`)

    // 获取当前配置
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应存在')
    const originalPath = config!.database

    // 验证文件在原位置存在
    assert(existsSync(originalPath), '文件应在原位置存在')

    // 移动文件（模拟 UI 操作）
    renameSync(originalPath, newDbPath)

    // 更新容器配置和注册表（container-handlers.ts 中的操作）
    await containerManager.updateConfig(containerName, { database: newDbPath })
    await duckdbRegistry.update(containerName, { filePath: newDbPath })

    // 验证文件在新位置存在
    assert(existsSync(newDbPath), '文件应在新位置存在')
    assert(!existsSync(originalPath), '文件不应在原位置存在')

    // 验证容器配置已更新
    const updatedConfig = await containerManager.getConfig(containerName)
    assertEqual(updatedConfig?.database, newDbPath, '容器配置应包含新路径')

    // 验证注册表已更新
    const registryEntry = await duckdbRegistry.get(containerName)
    assertEqual(registryEntry?.filePath, newDbPath, '注册表应包含新路径')

    // 验证容器仍显示为可用（而非丢失）
    const containers = await containerManager.list()
    const ourContainer = containers.find((c) => c.name === containerName)
    assertEqual(ourContainer?.status, 'running', '迁移后容器应仍为可用状态')

    // 验证数据完整
    const rowCount = parseInt(
      await queryDuckDB(newDbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '迁移后数据应保持完整')

    // 更新 dbPath 以供后续测试使用
    dbPath = newDbPath

    console.log(`   已从 ${originalPath} 迁移到 ${newDbPath}`)
  })

  it('应重命名容器', async () => {
    console.log(`\n 正在重命名容器...`)

    // 重命名容器
    await containerManager.rename(containerName, renamedContainerName)

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应存在')
    assertEqual(newConfig?.database, dbPath, '数据库路径应保持不变')

    console.log(`   已重命名为 "${renamedContainerName}"`)
  })

  it('应删除容器并移除文件', async () => {
    console.log(`\n 正在删除容器...`)

    // 先删除备份容器
    await containerManager.delete(backupContainerName, { force: true })
    assert(!duckdbFileExists(backupDbPath), '备份数据库文件应已删除')

    // 删除重命名后的容器
    await containerManager.delete(renamedContainerName, { force: true })
    assert(!duckdbFileExists(dbPath), '原数据库文件应已删除')

    // 验证容器已从列表中移除
    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))
    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   容器和文件已删除')
  })

  it('应确认没有残留的测试容器', async () => {
    console.log(`\n 正在验证没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   所有测试容器已清理')
  })
})
