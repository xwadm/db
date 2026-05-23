import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../../types/index'
import {
  detectEngineFromPath,
  getExtensionsForEngine,
  getAllFileBasedExtensions,
  isValidExtensionForEngine,
  formatExtensionsForEngine,
  formatAllExtensions,
  deriveContainerName,
  getRegistryForEngine,
  FILE_BASED_EXTENSION_REGEX,
} from '../../engines/file-based-utils'

describe('file-based-utils', () => {
  describe('detectEngineFromPath', () => {
    it('应从 .sqlite extension 检测 SQLite', () => {
      assert.equal(detectEngineFromPath('/path/to/db.sqlite'), Engine.SQLite)
    })

    it('应从 .sqlite3 extension 检测 SQLite', () => {
      assert.equal(detectEngineFromPath('/path/to/db.sqlite3'), Engine.SQLite)
    })

    it('应从 .db extension 检测 SQLite', () => {
      assert.equal(detectEngineFromPath('/path/to/db.db'), Engine.SQLite)
    })

    it('应从 .duckdb extension 检测 DuckDB', () => {
      assert.equal(detectEngineFromPath('/path/to/db.duckdb'), Engine.DuckDB)
    })

    it('应从 .ddb extension 检测 DuckDB', () => {
      assert.equal(detectEngineFromPath('/path/to/db.ddb'), Engine.DuckDB)
    })

    it('对于无法识别的 extension 应返回 null', () => {
      assert.equal(detectEngineFromPath('/path/to/db.txt'), null)
    })

    it('对于无 extension 应返回 null', () => {
      assert.equal(detectEngineFromPath('/path/to/mydb'), null)
    })

    it('应为大小写不敏感', () => {
      assert.equal(detectEngineFromPath('/path/to/db.SQLITE'), Engine.SQLite)
      assert.equal(detectEngineFromPath('/path/to/db.DuckDB'), Engine.DuckDB)
    })
  })

  describe('getExtensionsForEngine', () => {
    it('应返回 SQLite extensions', () => {
      const exts = getExtensionsForEngine(Engine.SQLite)
      assert.deepEqual(exts, ['.sqlite', '.sqlite3', '.db'])
    })

    it('应返回 DuckDB extensions', () => {
      const exts = getExtensionsForEngine(Engine.DuckDB)
      assert.deepEqual(exts, ['.duckdb', '.ddb'])
    })
  })

  describe('getAllFileBasedExtensions', () => {
    it('应返回所有 extensions', () => {
      const exts = getAllFileBasedExtensions()
      assert.ok(exts.includes('.sqlite'))
      assert.ok(exts.includes('.sqlite3'))
      assert.ok(exts.includes('.db'))
      assert.ok(exts.includes('.duckdb'))
      assert.ok(exts.includes('.ddb'))
      assert.equal(exts.length, 5)
    })
  })

  describe('isValidExtensionForEngine', () => {
    it('应接受 SQLite 的 .sqlite extension', () => {
      assert.ok(isValidExtensionForEngine('/path/db.sqlite', Engine.SQLite))
    })

    it('应拒绝 SQLite 的 .duckdb extension', () => {
      assert.ok(!isValidExtensionForEngine('/path/db.duckdb', Engine.SQLite))
    })

    it('应接受 DuckDB 的 .duckdb extension', () => {
      assert.ok(isValidExtensionForEngine('/path/db.duckdb', Engine.DuckDB))
    })

    it('应拒绝 DuckDB 的 .sqlite extension', () => {
      assert.ok(!isValidExtensionForEngine('/path/db.sqlite', Engine.DuckDB))
    })

    it('应为大小写不敏感', () => {
      assert.ok(isValidExtensionForEngine('/path/db.SQLITE', Engine.SQLite))
      assert.ok(isValidExtensionForEngine('/path/db.DUCKDB', Engine.DuckDB))
    })
  })

  describe('formatExtensionsForEngine', () => {
    it('应格式化 SQLite extensions', () => {
      const result = formatExtensionsForEngine(Engine.SQLite)
      assert.ok(result.includes('.sqlite'))
      assert.ok(result.includes('.sqlite3'))
      assert.ok(result.includes('.db'))
    })

    it('应格式化 DuckDB extensions', () => {
      const result = formatExtensionsForEngine(Engine.DuckDB)
      assert.ok(result.includes('.duckdb'))
      assert.ok(result.includes('.ddb'))
    })
  })

  describe('formatAllExtensions', () => {
    it('应包含所有 extensions', () => {
      const result = formatAllExtensions()
      assert.ok(result.includes('.sqlite'))
      assert.ok(result.includes('.duckdb'))
    })
  })

  describe('FILE_BASED_EXTENSION_REGEX', () => {
    it('应匹配 SQLite extensions', () => {
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.sqlite'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.sqlite3'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.db'))
    })

    it('应匹配 DuckDB extensions', () => {
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.duckdb'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.ddb'))
    })

    it('应不匹配其他 extensions', () => {
      assert.ok(!FILE_BASED_EXTENSION_REGEX.test('test.sql'))
      assert.ok(!FILE_BASED_EXTENSION_REGEX.test('test.txt'))
    })
  })

  describe('getRegistryForEngine', () => {
    it('应为 SQLite 返回一个 registry', () => {
      const registry = getRegistryForEngine(Engine.SQLite)
      assert.ok(registry)
      assert.ok(typeof registry.add === 'function')
      assert.ok(typeof registry.get === 'function')
      assert.ok(typeof registry.remove === 'function')
      assert.ok(typeof registry.exists === 'function')
      assert.ok(typeof registry.isPathRegistered === 'function')
    })

    it('应为 DuckDB 返回一个 registry', () => {
      const registry = getRegistryForEngine(Engine.DuckDB)
      assert.ok(registry)
      assert.ok(typeof registry.add === 'function')
    })

    it('对于非 file-based engine 应抛出异常', () => {
      assert.throws(
        () => getRegistryForEngine(Engine.PostgreSQL),
        /not a file-based engine/,
      )
    })
  })

  describe('deriveContainerName', () => {
    it('应去除 .sqlite extension', () => {
      assert.equal(deriveContainerName('mydb.sqlite', Engine.SQLite), 'mydb')
    })

    it('应去除 .sqlite3 extension', () => {
      assert.equal(deriveContainerName('mydb.sqlite3', Engine.SQLite), 'mydb')
    })

    it('应去除 .db extension', () => {
      assert.equal(deriveContainerName('mydb.db', Engine.SQLite), 'mydb')
    })

    it('应去除 .duckdb extension', () => {
      assert.equal(deriveContainerName('mydb.duckdb', Engine.DuckDB), 'mydb')
    })

    it('应去除 .ddb extension', () => {
      assert.equal(deriveContainerName('mydb.ddb', Engine.DuckDB), 'mydb')
    })

    it('应不去除错误 engine 的 extension', () => {
      // 当 engine 为 SQLite 时，.duckdb 不应被去除
      assert.equal(
        deriveContainerName('mydb.duckdb', Engine.SQLite),
        'mydb-duckdb',
      )
    })

    it('应将空格替换为连字符', () => {
      assert.equal(
        deriveContainerName('my database.sqlite', Engine.SQLite),
        'my-database',
      )
    })

    it('若以数字开头则添加 db- 前缀', () => {
      assert.equal(
        deriveContainerName('123test.sqlite', Engine.SQLite),
        'db-123test',
      )
    })

    it('对于空结果应返回回退值 (SQLite)', () => {
      assert.equal(deriveContainerName('.sqlite', Engine.SQLite), 'sqlite-db')
    })

    it('对于空结果应返回回退值 (DuckDB)', () => {
      assert.equal(deriveContainerName('.duckdb', Engine.DuckDB), 'duckdb-db')
    })

    it('应处理连续连字符', () => {
      assert.equal(deriveContainerName('my--db.sqlite', Engine.SQLite), 'my-db')
    })
  })
})
