import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseToolVersion,
  parseDumpVersion,
  checkVersionCompatibility,
} from '../../engines/mysql/version-validator'
import type {
  VersionInfo,
  DumpInfo,
} from '../../engines/mysql/version-validator'
import { getMajorVersion } from '../../engines/mysql/binary-detection'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mysqlFixturesDir = path.join(__dirname, '../fixtures/mysql/dumps')
const mariadbFixturesDir = path.join(__dirname, '../fixtures/mariadb/dumps')
// 为向后兼容现有测试的别名
const fixturesDir = mysqlFixturesDir

// =============================================================================
// parseToolVersion 测试
// =============================================================================

describe('parseToolVersion', () => {
  it('应解析 MySQL 版本字符串', () => {
    const result = parseToolVersion(
      'mysql  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)',
    )
    assert.equal(result.version.major, 8)
    assert.equal(result.version.minor, 0)
    assert.equal(result.version.patch, 35)
    assert.equal(result.variant, 'mysql')
  })

  it('应解析带 Distrib 的 MariaDB 版本字符串', () => {
    const result = parseToolVersion(
      'mysql  Ver 15.1 Distrib 10.11.6-MariaDB, for osx10.19 (arm64)',
    )
    assert.equal(result.version.major, 10)
    assert.equal(result.version.minor, 11)
    assert.equal(result.version.patch, 6)
    assert.equal(result.variant, 'mariadb')
  })

  it('应解析带 from 的新版 MariaDB 版本字符串', () => {
    const result = parseToolVersion(
      'mysql from 11.4.3-MariaDB, client 15.2 for osx10.20 (arm64)',
    )
    assert.equal(result.version.major, 11)
    assert.equal(result.version.minor, 4)
    assert.equal(result.version.patch, 3)
    assert.equal(result.variant, 'mariadb')
  })

  it('应解析无 patch 号的 MySQL 版本', () => {
    const result = parseToolVersion('mysql  Ver 8.0 for linux on x86_64')
    assert.equal(result.version.major, 8)
    assert.equal(result.version.minor, 0)
    assert.equal(result.version.patch, 0)
    assert.equal(result.variant, 'mysql')
  })

  it('应解析 MySQL 5.7 版本字符串', () => {
    const result = parseToolVersion(
      'mysql  Ver 14.14 Distrib 5.7.44, for Linux (x86_64)',
    )
    assert.equal(result.version.major, 5)
    assert.equal(result.version.minor, 7)
    assert.equal(result.version.patch, 44)
    assert.equal(result.variant, 'mysql')
  })

  it('应抛出异常当版本字符串无效', () => {
    assert.throws(() => parseToolVersion('mysql version unknown'), {
      message: /Cannot parse version/,
    })
  })
})

// =============================================================================
// parseDumpVersion 测试
// =============================================================================

describe('parseDumpVersion', () => {
  describe('MySQL dumps', () => {
    it('应解析 MySQL 8.0 dump 文件头', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.0-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 0)
      assert.equal(result.version?.patch, 36)
    })

    it('应解析 MySQL 8.4 dump 文件头', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.4-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 4)
      assert.equal(result.version?.patch, 3)
    })

    it('应解析 MySQL 9 dump 文件头', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-9-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 9)
      assert.equal(result.version?.minor, 0)
      assert.equal(result.version?.patch, 1)
    })

    it('应从 MySQL dump 中提取 server 版本', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.0-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      // Server version 行: "-- Server version	8.0.36"
      assert.ok(result.serverVersion?.includes('8.0.36'))
    })
  })

  describe('MariaDB dumps', () => {
    it('应解析 MariaDB 10.11 dump 文件头', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-10.11-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mariadb')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 10)
      assert.equal(result.version?.minor, 11)
      assert.equal(result.version?.patch, 6)
    })

    it('应解析 MariaDB 11.4 dump 文件头', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-11.4-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mariadb')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 11)
      assert.equal(result.version?.minor, 4)
      assert.equal(result.version?.patch, 3)
    })

    it('应从文件头检测 MariaDB variant', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-10.11-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      // 应从 "MariaDB dump" 或 "-MariaDB" 检测
      assert.equal(result.variant, 'mariadb')
    })
  })

  describe('错误处理', () => {
    it('应返回 null 版本当文件不存在', async () => {
      const result = await parseDumpVersion('/nonexistent/path/dump.sql')

      assert.equal(result.version, null)
      assert.equal(result.variant, 'unknown')
    })

    it('应从包含 dump 头的非 dump 文件中解析版本', async () => {
      // 测试 parseDumpVersion 能否从包含 dump 头的文件中提取版本信息
      // 这些文件在前 30 行包含 dump 头但不是真正的 dump 文件
      const result = await parseDumpVersion(
        path.join(fixturesDir, 'embedded-header-example.txt'),
      )

      // 应解析示例 dump 头
      // 示例: "-- MySQL dump 10.13  Distrib 8.0.36, for macos14.2 (arm64)"
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 0)
    })
  })
})

// =============================================================================
// checkVersionCompatibility 测试
// =============================================================================

describe('checkVersionCompatibility', () => {
  const mysqlTool: VersionInfo = {
    major: 8,
    minor: 0,
    patch: 35,
    full: '8.0.35',
  }
  const mariadbTool: VersionInfo = {
    major: 10,
    minor: 11,
    patch: 6,
    full: '10.11.6',
  }

  describe('兼容场景', () => {
    it('应为兼容当版本完全匹配', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.error, undefined)
      assert.equal(result.warning, undefined)
    })

    it('应为兼容当工具版本比 dump 新', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 5, minor: 7, patch: 0, full: '5.7.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.error, undefined)
    })

    it('应为兼容当 major 相同但 minor 不同', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 20, full: '8.0.20' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
    })

    it('应为兼容当 dump 版本为 null', () => {
      const dumpInfo: DumpInfo = {
        version: null,
        variant: 'unknown',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not detect dump version'))
    })
  })

  describe('不兼容场景', () => {
    it('应为不兼容当使用 MySQL 5.x 客户端恢复 MySQL 8 dump', () => {
      const oldMysqlTool: VersionInfo = {
        major: 5,
        minor: 7,
        patch: 0,
        full: '5.7.0',
      }
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, oldMysqlTool, 'mysql')
      assert.equal(result.compatible, false)
      assert.ok(result.error?.includes('MySQL 8'))
      assert.ok(result.error?.includes('version 5'))
    })
  })

  describe('警告场景', () => {
    it('应警告当 MariaDB dump 恢复到 MySQL', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 10, minor: 11, patch: 6, full: '10.11.6' },
        variant: 'mariadb',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MariaDB'))
      assert.ok(result.warning?.includes('MySQL'))
    })

    it('应警告当 MySQL dump 恢复到 MariaDB', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mariadbTool, 'mariadb')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MySQL'))
      assert.ok(result.warning?.includes('MariaDB'))
    })

    it('应警告当 MariaDB 10.x dump 恢复到 MySQL', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 10, minor: 5, patch: 0, full: '10.5.0' },
        variant: 'mariadb',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MariaDB'))
    })

    it('应警告当 dump 比工具新（相同 variant）', () => {
      const newerDump: DumpInfo = {
        version: { major: 9, minor: 0, patch: 0, full: '9.0.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(newerDump, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('9.0.0'))
      assert.ok(result.warning?.includes('8.0.35'))
    })

    it('应警告当 dump 非常旧（MySQL 5.5）', () => {
      const oldDump: DumpInfo = {
        version: { major: 5, minor: 5, patch: 0, full: '5.5.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(oldDump, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('very old'))
    })
  })

  describe('边界情况', () => {
    it('应优雅处理未知 variant', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 0, full: '8.0.0' },
        variant: 'unknown',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      // 当一方为 unknown 时不产生 variant 警告
      assert.equal(result.compatible, true)
    })

    it('应在结果中返回正确的版本', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 20, full: '8.0.20' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.deepEqual(result.dumpInfo, dumpInfo)
      assert.deepEqual(result.toolVersion, mysqlTool)
      assert.equal(result.toolVariant, 'mysql')
    })

    it('应正确处理 null dump 版本', () => {
      const dumpInfo: DumpInfo = {
        version: null,
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.dumpInfo.version, null)
    })
  })
})

// =============================================================================
// getMajorVersion 测试
// =============================================================================

describe('getMajorVersion', () => {
  describe('标准版本字符串', () => {
    it('应从完整版本中提取 major.minor', () => {
      assert.equal(getMajorVersion('8.0.35'), '8.0')
    })

    it('应从三段式版本中提取 major.minor', () => {
      assert.equal(getMajorVersion('9.5.0'), '9.5')
    })

    it('应处理四段式版本', () => {
      assert.equal(getMajorVersion('10.11.6.1'), '10.11')
    })
  })

  describe('边界情况', () => {
    it('应处理空字符串', () => {
      assert.equal(getMajorVersion(''), '')
    })

    it('应处理单个数字版本', () => {
      assert.equal(getMajorVersion('8'), '8')
    })

    it('应处理带 "v" 前缀的版本', () => {
      assert.equal(getMajorVersion('v8.0.35'), '8.0')
    })

    it('应处理带 "V" 前缀（大写）的版本', () => {
      assert.equal(getMajorVersion('V9.5.0'), '9.5')
    })

    it('应处理带空白的版本', () => {
      assert.equal(getMajorVersion('  8.0.35  '), '8.0')
    })

    it('应处理带 "v" 前缀的单个数字', () => {
      assert.equal(getMajorVersion('v8'), '8')
    })

    it('应处理两段式版本', () => {
      assert.equal(getMajorVersion('8.0'), '8.0')
    })

    it('应处理仅含空白的字符串', () => {
      assert.equal(getMajorVersion('   '), '')
    })
  })
})
