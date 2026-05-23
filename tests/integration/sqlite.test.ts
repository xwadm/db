/**
 * SQLite 系统集成测试
 *
 * 测试 SQLite 的完整容器生命周期。
 * 与 PostgreSQL/MySQL 不同，SQLite 是基于文件的，没有服务器进程。
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, renameSync } from 'fs'
import { rm, mkdir } from 'fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  generateTestName,
  cleanupTestContainers,
  runScriptFile,
  runScriptSQL,
  sqliteFileExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { configManager } from '../../core/config-manager'
import { Engine } from '../../types'

// 从引擎获取 sqlite3 路径的辅助函数
async function getSqlite3Path(): Promise<string> {
  const engine = getEngine(Engine.SQLite)
  const path = await engine.getSqlite3Path()
  if (!path) {
    throw new Error('sqlite3 not found. Run: spindb engines download sqlite')
  }
  return path
}

// 验证我们使用的是下载的二进制文件，而不是系统自带的
async function verifyUsingDownloadedBinaries(): Promise<void> {
  const config = await configManager.getBinaryConfig('sqlite3')
  if (!config) {
    throw new Error(
      'sqlite3 not configured. Run: spindb engines download sqlite',
    )
  }
  if (config.source === 'system') {
    throw new Error(
      'Tests are using system sqlite3, not downloaded binaries. ' +
        'This makes tests unreliable for catching extraction bugs. ' +
        'Run: spindb engines download sqlite 3',
    )
  }
}

const ENGINE = Engine.SQLite
const SEED_FILE = join(__dirname, '../fixtures/sqlite/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5
const TEST_DIR = join(__dirname, '../.test-sqlite')

describe('SQLite 集成测试', () => {
  let containerName: string
  let backupContainerName: string
  let renamedContainerName: string
  let dbPath: string
  let backupDbPath: string

  before(async () => {
    // 确保 SQLite 二进制文件已下载
    const engine = getEngine(ENGINE)
    console.log('   正在确保 SQLite 二进制文件可用...')
    await engine.ensureBinaries('3', ({ message }) => {
      console.log(`   ${message}`)
    })

    // 验证我们使用的是下载的二进制文件，而不是系统自带的
    // 这确保测试实际验证二进制提取管道
    await verifyUsingDownloadedBinaries()

    console.log('\n🧹 清理中，删除所有现有测试容器...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    // 创建测试目录
    await mkdir(TEST_DIR, { recursive: true })

    containerName = generateTestName('sqlite-test')
    backupContainerName = generateTestName('sqlite-test-backup')
    renamedContainerName = generateTestName('sqlite-test-renamed')
    dbPath = join(TEST_DIR, `${containerName}.sqlite`)
    backupDbPath = join(TEST_DIR, `${backupContainerName}.sqlite`)
  })

  after(async () => {
    console.log('\n🧹 最终清理...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   已删除: ${deleted.join(', ')}`)
    }

    // 清理测试目录
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  it('should create SQLite database with --path option', async () => {
    console.log(`\n📦 创建 SQLite 数据库 "${containerName}"...`)

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '3',
      port: 0, // SQLite 不使用端口
      database: dbPath,
    })

    // 初始化数据库（创建文件）
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, '3', { path: dbPath })

    // 验证容器存在
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')
    assertEqual(config?.database, dbPath, 'Database path should match')

    // 验证文件存在
    assert(sqliteFileExists(dbPath), 'SQLite database file should exist')

    console.log(`   ✓ 数据库已创建于 ${dbPath}`)
  })

  it('should list SQLite container with "available" status', async () => {
    console.log(`\n📋 列出 SQLite 容器...`)

    const containers = await containerManager.list()
    const sqliteContainers = containers.filter((c) => c.engine === ENGINE)

    assert(
      sqliteContainers.length > 0,
      'Should have at least one SQLite container',
    )

    const ourContainer = sqliteContainers.find((c) => c.name === containerName)
    assert(ourContainer !== undefined, 'Should find our test container')

    // SQLite 使用 'running' 状态表示文件存在
    assertEqual(
      ourContainer?.status,
      'running',
      'Status should be "running" (file exists)',
    )

    console.log(`   ✓ 找到 ${sqliteContainers.length} 个 SQLite 容器`)
  })

  it('should seed database with test data using runScript', async () => {
    console.log(`\n🌱 正在用示例数据填充数据库...`)

    // 使用 runScriptFile，它内部调用 engine.runScript
    await runScriptFile(containerName, SEED_FILE)

    // 通过 sqlite3 直接查询行数
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      dbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      '填充后应有正确的行数',
    )

    console.log(`   ✓ 已填充 ${rowCount} 行`)
  })

  it('should run inline SQL using runScript', async () => {
    console.log(`\n✏️  运行内联 SQL...`)

    // 删除一行
    await runScriptSQL(
      containerName,
      "DELETE FROM test_user WHERE email = 'eve@example.com'",
    )

    // 验证删除
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      dbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, '应该少一行')

    console.log(`   ✓ 行已删除，现有 ${rowCount} 行`)
  })

  it('should backup database (SQL format)', async () => {
    console.log(`\n💾 创建 SQL 备份...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    const backupPath = join(TEST_DIR, 'backup.sql')

    const result = await engine.backup(config!, backupPath, {
      format: 'sql',
      database: config!.database,
    })

    assert(existsSync(result.path), 'Backup file should exist')
    assertEqual(result.format, 'sql', 'Backup format should be SQL')

    // 清理
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL 备份已创建（${result.size} 字节）`)
  })

  it('should backup database (binary format) and restore', async () => {
    console.log(`\n💾 创建二进制备份并恢复...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')

    const engine = getEngine(ENGINE)
    const backupPath = join(TEST_DIR, 'backup.sqlite')

    // 创建二进制备份
    const result = await engine.backup(config!, backupPath, {
      format: 'binary',
      database: config!.database,
    })
    assert(existsSync(result.path), 'Backup file should exist')

    // 创建新容器并恢复
    await containerManager.create(backupContainerName, {
      engine: ENGINE,
      version: '3',
      port: 0,
      database: backupDbPath,
    })
    await engine.initDataDir(backupContainerName, '3', { path: backupDbPath })

    const backupConfig = await containerManager.getConfig(backupContainerName)
    assert(backupConfig !== null, 'Backup container config should exist')

    await engine.restore(backupConfig!, backupPath)

    // 验证恢复的数据
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      backupDbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Restored data should match source',
    )

    // 清理备份文件
    await rm(backupPath, { force: true })

    console.log(`   ✓ 二进制备份已创建并恢复，共 ${rowCount} 行`)
  })

  it('should relocate database file and update registry', async () => {
    console.log(`\n📍 重定位数据库文件...`)

    // 为重定位创建子目录
    const relocateDir = join(TEST_DIR, 'relocated')
    await mkdir(relocateDir, { recursive: true })

    const newDbPath = join(relocateDir, `${containerName}.sqlite`)

    // 获取当前配置
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, '容器配置应该存在')
    const originalPath = config!.database

    // 验证文件存在于原始位置
    assert(existsSync(originalPath), 'File should exist at original location')

    // 移动文件（模拟 UI 的操作）
    renameSync(originalPath, newDbPath)

    // 更新容器配置和注册表（container-handlers.ts 的操作）
    await containerManager.updateConfig(containerName, { database: newDbPath })
    await sqliteRegistry.update(containerName, { filePath: newDbPath })

    // 验证文件存在于新位置
    assert(existsSync(newDbPath), 'File should exist at new location')
    assert(
      !existsSync(originalPath),
      'File should not exist at original location',
    )

    // 验证容器配置已更新
    const updatedConfig = await containerManager.getConfig(containerName)
    assertEqual(
      updatedConfig?.database,
      newDbPath,
      'Container config should have new path',
    )

    // 验证注册表已更新
    const registryEntry = await sqliteRegistry.get(containerName)
    assertEqual(
      registryEntry?.filePath,
      newDbPath,
      'Registry should have new path',
    )

    // 验证容器仍然显示为可用（不是缺失）
    const containers = await containerManager.list()
    const ourContainer = containers.find((c) => c.name === containerName)
    assertEqual(
      ourContainer?.status,
      'running',
      'Container should still be available after relocation',
    )

    // 验证数据完整
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      newDbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Data should be intact after relocation',
    )

    // 为后续测试更新 dbPath
    dbPath = newDbPath

    console.log(`   ✓ 已从 ${originalPath} 重定位到 ${newDbPath}`)
  })

  it('should rename container', async () => {
    console.log(`\n📝 重命名容器...`)

    // 重命名容器
    await containerManager.rename(containerName, renamedContainerName)

    // 验证重命名
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, '旧容器名不应存在')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, '重命名后的容器应该存在')
    assertEqual(
      newConfig?.database,
      dbPath,
      'Database path should be unchanged',
    )

    console.log(`   ✓ 已重命名为 "${renamedContainerName}"`)
  })

  it('should delete container and remove file', async () => {
    console.log(`\n🗑️  删除容器...`)

    // 先删除备份容器
    await containerManager.delete(backupContainerName, { force: true })
    assert(
      !sqliteFileExists(backupDbPath),
      'Backup database file should be deleted',
    )

    // 删除重命名后的容器
    await containerManager.delete(renamedContainerName, { force: true })
    assert(
      !sqliteFileExists(dbPath),
      'Original database file should be deleted',
    )

    // 验证容器已从列表中移除
    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))
    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 容器和文件已删除')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ 验证中，确认没有测试容器残留...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, '不应有测试容器残留')

    console.log('   ✓ 所有测试容器已清理')
  })
})
