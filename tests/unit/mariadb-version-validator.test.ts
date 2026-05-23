import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseVersion,
  extractDumpVersion,
  validateRestoreCompatibility,
} from '../../engines/mariadb/version-validator'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(__dirname, '../fixtures/mariadb/dumps')

// =============================================================================
// parseVersion 测试
// =============================================================================

describe('MariaDB parseVersion', () => {
  it('应解析完整 MariaDB 版本字符串', () => {
    const result = parseVersion('11.8.5')
    assert.equal(result.major, 11)
    assert.equal(result.minor, 8)
    assert.equal(result.patch, 5)
    assert.equal(result.full, '11.8.5')
  })

  it('应解析 MariaDB 10.x 版本', () => {
    const result = parseVersion('10.11.6')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 11)
    assert.equal(result.patch, 6)
    assert.equal(result.full, '10.11.6')
  })

  it('应解析无 patch 号的版本', () => {
    const result = parseVersion('11.4')
    assert.equal(result.major, 11)
    assert.equal(result.minor, 4)
    assert.equal(result.patch, 0)
  })

  it('应解析单数字版本', () => {
    const result = parseVersion('10.5.8')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 5)
    assert.equal(result.patch, 8)
  })

  it('应处理四段版本号', () => {
    const result = parseVersion('10.11.6.1')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 11)
    assert.equal(result.patch, 6)
  })
})

// =============================================================================
// extractDumpVersion 测试
// =============================================================================

describe('MariaDB extractDumpVersion', () => {
  it('应从 MariaDB 10.11 dump 中提取版本', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-10.11-plain.sql')
    const result = await extractDumpVersion(dumpPath)

    assert.ok(result, '期望 result 已定义')
    assert.equal(result.isMariaDB, true)
    // 版本字符串应包含 10.11
    assert.ok(result.version.startsWith('10.11'))
  })

  it('应从 MariaDB 11.4 dump 中提取版本', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await extractDumpVersion(dumpPath)

    assert.ok(result, '期望 result 已定义')
    assert.equal(result.isMariaDB, true)
    // 版本字符串应包含 11.4
    assert.ok(result.version.startsWith('11.4'))
  })

  it('不存在的文件应返回 null', async () => {
    const result = await extractDumpVersion('/nonexistent/path/dump.sql')
    assert.equal(result, null)
  })
})

// =============================================================================
// validateRestoreCompatibility 测试
// =============================================================================

describe('MariaDB validateRestoreCompatibility', () => {
  it('将旧版本 dump 恢复到新版本时应为兼容', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-10.11-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
    assert.equal(result.warning, undefined)
  })

  it('相同主版本号应为兼容', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
  })

  it('无法确定 dump 版本时应允许恢复', async () => {
    const result = await validateRestoreCompatibility({
      dumpPath: '/nonexistent/path/dump.sql',
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
    assert.ok(result.warning?.includes('Could not determine'))
  })

  it('未指定目标版本时应为兼容', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
    })

    assert.equal(result.compatible, true)
  })
})
