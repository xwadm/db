import { describe, it, after } from 'node:test'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assertEqual } from '../utils/assertions'
import { detectLocationType } from '../../cli/commands/create'
import { Engine } from '../../types'

describe('detectLocationType', () => {
  describe('connection string 检测', () => {
    it('应检测 postgresql:// connection string', () => {
      const result = detectLocationType('postgresql://localhost:5432/mydb')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(
        result.inferredEngine,
        Engine.PostgreSQL,
        '应推断 PostgreSQL',
      )
    })

    it('应检测 postgres:// connection string', () => {
      const result = detectLocationType('postgres://user:pass@host:5432/db')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(
        result.inferredEngine,
        Engine.PostgreSQL,
        '应推断 PostgreSQL',
      )
    })

    it('应检测 mysql:// connection string', () => {
      const result = detectLocationType('mysql://localhost:3306/mydb')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.MySQL, '应推断 MySQL')
    })

    it('应检测 sqlite:// connection string', () => {
      const result = detectLocationType('sqlite:///path/to/db.sqlite')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.SQLite, '应推断 SQLite')
    })

    it('应检测 duckdb:// connection string', () => {
      const result = detectLocationType('duckdb:///path/to/db.duckdb')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.DuckDB, '应推断 DuckDB')
    })

    it('应检测 redis:// connection string', () => {
      const result = detectLocationType('redis://localhost:6379')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.Redis, '应推断 Redis')
    })

    it('应检测 rediss:// connection string (TLS)', () => {
      const result = detectLocationType('rediss://secure.redis.host:6379')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.Redis, '应推断 Redis')
    })

    it('应检测 valkey:// connection string', () => {
      const result = detectLocationType('valkey://localhost:6379')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.Valkey, '应推断 Valkey')
    })

    it('应检测 valkeys:// connection string (TLS)', () => {
      const result = detectLocationType('valkeys://secure.valkey.host:6379')
      assertEqual(result.type, 'connection', '应为 connection type')
      assertEqual(result.inferredEngine, Engine.Valkey, '应推断 Valkey')
    })
  })

  describe('文件 extension 检测', () => {
    const testFiles: string[] = []

    // 创建临时文件并记录路径以便后续清理
    function createTempFile(extension: string): string {
      const filename = `test-detect-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)
      return filepath
    }

    // 测试结束后清理所有临时文件
    after(() => {
      for (const file of testFiles) {
        if (existsSync(file)) {
          unlinkSync(file)
        }
      }
    })

    it('应检测 .sqlite 文件为 SQLite', () => {
      const filepath = createTempFile('sqlite')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.SQLite, '应推断 SQLite')
    })

    it('应检测 .sqlite3 文件为 SQLite', () => {
      const filepath = createTempFile('sqlite3')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.SQLite, '应推断 SQLite')
    })

    it('应检测 .SQLITE 文件为 SQLite（大小写不敏感）', () => {
      // 创建小写文件名，用大写名称进行测试
      const filename = `TEST-DETECT-${Date.now()}.SQLITE`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)

      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.SQLite, '应推断 SQLite')
    })

    it('应检测 .duckdb 文件为 DuckDB', () => {
      const filepath = createTempFile('duckdb')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, '应推断 DuckDB')
    })

    it('应检测 .ddb 文件为 DuckDB', () => {
      const filepath = createTempFile('ddb')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, '应推断 DuckDB')
    })

    it('应检测 .DUCKDB 文件为 DuckDB（大小写不敏感）', () => {
      const filename = `TEST-DETECT-${Date.now()}.DUCKDB`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)

      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, '应推断 DuckDB')
    })

    it('不应从 .db extension 推断 DuckDB（通常由 SQLite 使用）', () => {
      const filepath = createTempFile('db')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(
        result.inferredEngine,
        undefined,
        '不应从 .db extension 推断 engine',
      )
    })

    it('未知 extension 应返回 file type 但不推断 engine', () => {
      const filepath = createTempFile('txt')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', '应为 file type')
      assertEqual(
        result.inferredEngine,
        undefined,
        '未知 extension 不应推断 engine',
      )
    })
  })

  describe('不存在的 path', () => {
    it('不存在的文件 path 应返回 not_found', () => {
      const result = detectLocationType('/path/that/does/not/exist.sqlite')
      assertEqual(result.type, 'not_found', '应为 not_found type')
      assertEqual(
        result.inferredEngine,
        undefined,
        '不存在的 path 不应推断 engine',
      )
    })

    it('没有 connection string 前缀的 path 应返回 not_found', () => {
      const result = detectLocationType('some-random-string')
      assertEqual(result.type, 'not_found', '应为 not_found type')
    })

    it('空类 path 应返回 not_found', () => {
      const result = detectLocationType('./nonexistent.db')
      assertEqual(result.type, 'not_found', '应为 not_found type')
    })
  })
})
