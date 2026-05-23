import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat as detectPgBackupFormat,
  assertCompatibleFormat as assertPgCompatibleFormat,
} from '../../engines/postgresql/restore'
import {
  detectBackupFormat as detectMysqlBackupFormat,
  assertCompatibleFormat as assertMysqlCompatibleFormat,
} from '../../engines/mysql/restore'
import { SpinDBError } from '../../core/error-handler'

// =============================================================================
// 测试固件
// =============================================================================

const MYSQL_DUMP_HEADER = `-- MySQL dump 10.13  Distrib 8.0.36, for macos14.2 (arm64)
--
-- Host: 127.0.0.1    Database: testdb
-- Server version	8.0.36

CREATE TABLE test (id int);
`

const MYSQL_57_DUMP_HEADER = `-- MySQL dump 10.13  Distrib 5.7.44, for Linux (x86_64)
--
-- Host: 127.0.0.1    Database: testdb
-- Server version	5.7.44

CREATE TABLE test (id int(11));
`

const MARIADB_DUMP_HEADER = `-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: 127.0.0.1    Database: testdb
-- Server version	10.11.6-MariaDB-1

CREATE TABLE test (id int);
`

const POSTGRES_SQL_DUMP_HEADER = `--
-- PostgreSQL database dump
--

-- Dumped from database version 17.0
-- Dumped by pg_dump version 17.0

SET statement_timeout = 0;
CREATE TABLE test (id serial PRIMARY KEY);
`

const POSTGRES_SQL_DUMP_WITH_PGDUMP = `-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
CREATE TABLE test (id serial PRIMARY KEY);
`

// PostgreSQL 自定义格式的 PGDMP 魔术字节
const PGDMP_MAGIC = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50]) // "PGDMP"

const GENERIC_SQL = `CREATE TABLE test (id int);
INSERT INTO test VALUES (1);
`

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00]) // gzip 魔术字节

// =============================================================================
// 测试设置
// =============================================================================

let testDir: string

describe('备份格式检测', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    // 清理测试文件
    const files = [
      'mysql.sql',
      'mysql57.sql',
      'mariadb.sql',
      'postgres.sql',
      'postgres-pgdump.sql',
      'pgdmp.dump',
      'generic.sql',
      'compressed.sql.gz',
    ]
    for (const file of files) {
      try {
        await unlink(join(testDir, file))
      } catch {
        // 如果文件不存在则忽略
      }
    }
  })

  // ===========================================================================
  // PostgreSQL 格式检测
  // ===========================================================================

  describe('PostgreSQL detectBackupFormat', () => {
    it('应该检测出 MySQL 转储格式', async () => {
      const filePath = join(testDir, 'mysql.sql')
      await writeFile(filePath, MYSQL_DUMP_HEADER)

      const format = await detectPgBackupFormat(filePath)
      assert.equal(format.format, 'mysql_sql')
      assert.ok(format.description.includes('MySQL'))
      assert.equal(format.restoreCommand, 'mysql')
    })

    it('应该检测出 MariaDB 转储格式', async () => {
      const filePath = join(testDir, 'mariadb.sql')
      await writeFile(filePath, MARIADB_DUMP_HEADER)

      const format = await detectPgBackupFormat(filePath)
      assert.equal(format.format, 'mysql_sql')
      assert.ok(
        format.description.includes('MySQL') ||
          format.description.includes('MariaDB'),
      )
    })

    it('应该检测出 PostgreSQL SQL 转储格式', async () => {
      const filePath = join(testDir, 'postgres.sql')
      await writeFile(filePath, POSTGRES_SQL_DUMP_HEADER)

      const format = await detectPgBackupFormat(filePath)
      assert.equal(format.format, 'sql')
      assert.equal(format.restoreCommand, 'psql')
    })

    it('应该检测出 PostgreSQL 自定义格式 (PGDMP)', async () => {
      const filePath = join(testDir, 'pgdmp.dump')
      // 创建一个最小化的 PGDMP 文件（仅包含魔术字节和一些数据）
      const content = Buffer.concat([
        PGDMP_MAGIC,
        Buffer.from('fake dump data'),
      ])
      await writeFile(filePath, content)

      const format = await detectPgBackupFormat(filePath)
      assert.equal(format.format, 'custom')
      assert.equal(format.restoreCommand, 'pg_restore')
    })

    it('应该将通用 SQL 检测为普通格式', async () => {
      const filePath = join(testDir, 'generic.sql')
      await writeFile(filePath, GENERIC_SQL)

      const format = await detectPgBackupFormat(filePath)
      // 以 CREATE 开头的通用 SQL 应该被检测为 SQL
      assert.ok(['sql', 'unknown'].includes(format.format))
    })
  })

  describe('PostgreSQL assertCompatibleFormat', () => {
    it('对于 MySQL 转储应该抛出 SpinDBError', () => {
      const format = {
        format: 'mysql_sql',
        description: 'MySQL dump',
        restoreCommand: 'mysql',
      }

      assert.throws(
        () => assertPgCompatibleFormat(format),
        (error: unknown) => {
          assert.ok(error instanceof SpinDBError)
          assert.equal((error as SpinDBError).code, 'WRONG_ENGINE_DUMP')
          assert.ok(
            (error as SpinDBError).suggestion?.includes('--engine mysql'),
          )
          return true
        },
      )
    })

    it('对于 PostgreSQL 格式不应该抛出异常', () => {
      const formats = [
        {
          format: 'custom',
          description: 'PostgreSQL custom',
          restoreCommand: 'pg_restore',
        },
        {
          format: 'sql',
          description: 'PostgreSQL SQL',
          restoreCommand: 'psql',
        },
        {
          format: 'unknown',
          description: 'Unknown',
          restoreCommand: 'pg_restore',
        },
      ]

      for (const format of formats) {
        assert.doesNotThrow(() => assertPgCompatibleFormat(format))
      }
    })
  })

  // ===========================================================================
  // MySQL 格式检测
  // ===========================================================================

  describe('MySQL detectBackupFormat', () => {
    it('应该检测出 PostgreSQL 自定义格式 (PGDMP)', async () => {
      const filePath = join(testDir, 'pgdmp.dump')
      const content = Buffer.concat([
        PGDMP_MAGIC,
        Buffer.from('fake dump data'),
      ])
      await writeFile(filePath, content)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'postgresql_custom')
      assert.ok(format.description.includes('PostgreSQL'))
      assert.equal(format.restoreCommand, 'pg_restore')
    })

    it('应该检测出 PostgreSQL SQL 转储格式', async () => {
      const filePath = join(testDir, 'postgres.sql')
      await writeFile(filePath, POSTGRES_SQL_DUMP_HEADER)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'postgresql_sql')
      assert.ok(format.description.includes('PostgreSQL'))
      assert.equal(format.restoreCommand, 'psql')
    })

    it('应该通过 pg_dump 标记检测出 PostgreSQL 转储', async () => {
      const filePath = join(testDir, 'postgres-pgdump.sql')
      await writeFile(filePath, POSTGRES_SQL_DUMP_WITH_PGDUMP)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'postgresql_sql')
    })

    it('应该检测出 MySQL 转储格式', async () => {
      const filePath = join(testDir, 'mysql.sql')
      await writeFile(filePath, MYSQL_DUMP_HEADER)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'sql')
      assert.equal(format.restoreCommand, 'mysql')
    })

    it('应该检测出 MySQL 5.7 转储格式', async () => {
      const filePath = join(testDir, 'mysql57.sql')
      await writeFile(filePath, MYSQL_57_DUMP_HEADER)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'sql')
    })

    it('应该检测出 MariaDB 转储格式', async () => {
      const filePath = join(testDir, 'mariadb.sql')
      await writeFile(filePath, MARIADB_DUMP_HEADER)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'sql')
    })

    it('应该检测出 gzip 压缩格式', async () => {
      const filePath = join(testDir, 'compressed.sql.gz')
      await writeFile(filePath, GZIP_HEADER)

      const format = await detectMysqlBackupFormat(filePath)
      assert.equal(format.format, 'compressed')
    })
  })

  describe('MySQL assertCompatibleFormat', () => {
    it('对于 PostgreSQL 自定义转储应该抛出 SpinDBError', () => {
      const format = {
        format: 'postgresql_custom',
        description: 'PostgreSQL custom dump',
        restoreCommand: 'pg_restore',
      }

      assert.throws(
        () => assertMysqlCompatibleFormat(format),
        (error: unknown) => {
          assert.ok(error instanceof SpinDBError)
          assert.equal((error as SpinDBError).code, 'WRONG_ENGINE_DUMP')
          assert.ok(
            (error as SpinDBError).suggestion?.includes('--engine postgresql'),
          )
          return true
        },
      )
    })

    it('对于 PostgreSQL SQL 转储应该抛出 SpinDBError', () => {
      const format = {
        format: 'postgresql_sql',
        description: 'PostgreSQL SQL dump',
        restoreCommand: 'psql',
      }

      assert.throws(
        () => assertMysqlCompatibleFormat(format),
        (error: unknown) => {
          assert.ok(error instanceof SpinDBError)
          assert.equal((error as SpinDBError).code, 'WRONG_ENGINE_DUMP')
          return true
        },
      )
    })

    it('对于 MySQL/MariaDB 格式不应该抛出异常', () => {
      const formats = [
        { format: 'sql', description: 'MySQL dump', restoreCommand: 'mysql' },
        {
          format: 'compressed',
          description: 'Gzip compressed',
          restoreCommand: 'mysql',
        },
        { format: 'unknown', description: 'Unknown', restoreCommand: 'mysql' },
      ]

      for (const format of formats) {
        assert.doesNotThrow(() => assertMysqlCompatibleFormat(format))
      }
    })
  })
})
