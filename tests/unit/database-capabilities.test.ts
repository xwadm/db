import { describe, it } from 'node:test'
import {
  getDatabaseCapabilities,
  canCreateDatabase,
  canRenameDatabase,
  canDropDatabase,
  getUnsupportedCreateMessage,
  getUnsupportedRenameMessage,
  getUnsupportedDropMessage,
} from '../../core/database-capabilities'
import { getEngine } from '../../engines'
import { Engine, ALL_ENGINES } from '../../types'
import { assert, assertEqual } from '../utils/assertions'

describe('数据库能力', () => {
  describe('getDatabaseCapabilities', () => {
    it('应该为所有 20 个 engine 返回能力信息', () => {
      for (const engine of ALL_ENGINES) {
        const caps = getDatabaseCapabilities(engine)
        assert(
          typeof caps.supportsCreate === 'boolean',
          `${engine} 应有布尔类型的 supportsCreate`,
        )
        assert(
          typeof caps.supportsDrop === 'boolean',
          `${engine} 应有布尔类型的 supportsDrop`,
        )
        assert(
          caps.supportsRename === 'native' ||
            caps.supportsRename === 'backup-restore' ||
            caps.supportsRename === false,
          `${engine} 应有有效的 supportsRename`,
        )
      }
    })

    it('不支持的 engine 应有 unsupportedReason', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        const caps = getDatabaseCapabilities(engine)
        assert(
          caps.unsupportedReason !== undefined &&
            caps.unsupportedReason.length > 0,
          `${engine} 应有非空的 unsupportedReason`,
        )
      }
    })

    it('支持的 engine 不应有 unsupportedReason', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.unsupportedReason,
          undefined,
          `${engine} 不应有 unsupportedReason`,
        )
      }
    })

    it('PostgreSQL、ClickHouse、CockroachDB 和 Meilisearch 应返回 native 重命名', () => {
      const nativeRename = ALL_ENGINES.filter(
        (e) => getDatabaseCapabilities(e).supportsRename === 'native',
      )
      assertEqual(
        nativeRename.length,
        4,
        '应有恰好 4 个支持 native 重命名的 engine',
      )
      assert(
        nativeRename.includes(Engine.PostgreSQL),
        'PostgreSQL 应支持 native 重命名',
      )
      assert(
        nativeRename.includes(Engine.ClickHouse),
        'ClickHouse 应支持 native 重命名',
      )
      assert(
        nativeRename.includes(Engine.CockroachDB),
        'CockroachDB 应支持 native 重命名',
      )
      assert(
        nativeRename.includes(Engine.Meilisearch),
        'Meilisearch 应支持 native 重命名',
      )
    })

    it('大多数支持的 engine 应返回 backup-restore 重命名', () => {
      const backupRestore = [
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Weaviate,
      ]
      for (const engine of backupRestore) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.supportsRename,
          'backup-restore',
          `${engine} 应使用 backup-restore 重命名`,
        )
      }
    })

    it('不支持的 engine 重命名应返回 false', () => {
      const noRename = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of noRename) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.supportsRename,
          false,
          `${engine} 不应支持重命名`,
        )
      }
    })
  })

  describe('canCreateDatabase', () => {
    it('支持的 engine 应返回 true', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canCreateDatabase(engine),
          true,
          `${engine} 应支持创建`,
        )
      }
    })

    it('不支持的 engine 应返回 false', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canCreateDatabase(engine),
          false,
          `${engine} 不应支持创建`,
        )
      }
    })
  })

  describe('canRenameDatabase', () => {
    it('支持的 engine 应返回 true', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canRenameDatabase(engine),
          true,
          `${engine} 应支持重命名`,
        )
      }
    })

    it('不支持的 engine 应返回 false', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canRenameDatabase(engine),
          false,
          `${engine} 不应支持重命名`,
        )
      }
    })
  })

  describe('canDropDatabase', () => {
    it('支持的 engine 应返回 true', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canDropDatabase(engine),
          true,
          `${engine} 应支持删除`,
        )
      }
    })

    it('不支持的 engine 应返回 false', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canDropDatabase(engine),
          false,
          `${engine} 不应支持删除`,
        )
      }
    })
  })

  describe('getUnsupportedCreateMessage', () => {
    it('支持的 engine 应返回空字符串', () => {
      assertEqual(
        getUnsupportedCreateMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL 创建应返回空字符串',
      )
    })

    it('SQLite 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), '应提及 SQLite')
      assert(msg.includes('file IS the database'), '应说明原因')
      assert(msg.includes('spindb create'), '应建议替代方案')
    })

    it('DuckDB 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.DuckDB)
      assert(msg.includes('DuckDB'), '应提及 DuckDB')
      assert(msg.includes('file IS the database'), '应说明原因')
    })

    it('Redis 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.Redis)
      assert(msg.includes('Redis'), '应提及 Redis')
      assert(msg.includes('0-15'), '应提及编号数据库')
    })

    it('Valkey 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.Valkey)
      assert(msg.includes('Valkey'), '应提及 Valkey')
      assert(msg.includes('0-15'), '应提及编号数据库')
    })

    it('QuestDB 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.QuestDB)
      assert(msg.includes('QuestDB'), '应提及 QuestDB')
      assert(msg.includes('single-database'), '应说明其模型')
    })

    it('TigerBeetle 应返回描述性消息', () => {
      const msg = getUnsupportedCreateMessage(Engine.TigerBeetle)
      assert(msg.includes('TigerBeetle'), '应提及 TigerBeetle')
      assert(msg.includes('single ledger'), '应说明其模型')
    })
  })

  describe('getUnsupportedRenameMessage', () => {
    it('支持的 engine 应返回空字符串', () => {
      assertEqual(
        getUnsupportedRenameMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL 重命名应返回空字符串',
      )
      assertEqual(
        getUnsupportedRenameMessage(Engine.ClickHouse),
        '',
        'ClickHouse 重命名应返回空字符串',
      )
    })

    it('SQLite 应返回描述性消息', () => {
      const msg = getUnsupportedRenameMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), '应提及 SQLite')
    })

    it('Redis 应返回描述性消息', () => {
      const msg = getUnsupportedRenameMessage(Engine.Redis)
      assert(msg.includes('Redis'), '应提及 Redis')
      assert(msg.includes('number'), '应提及编号数据库')
    })
  })

  describe('getUnsupportedDropMessage', () => {
    it('支持的 engine 应返回空字符串', () => {
      assertEqual(
        getUnsupportedDropMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL 删除应返回空字符串',
      )
    })

    it('SQLite 应返回描述性消息', () => {
      const msg = getUnsupportedDropMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), '应提及 SQLite')
      assert(msg.includes('spindb delete'), '应建议替代方案')
    })

    it('Redis 应返回描述性消息', () => {
      const msg = getUnsupportedDropMessage(Engine.Redis)
      assert(msg.includes('Redis'), '应提及 Redis')
      assert(msg.includes('FLUSHDB'), '应建议 FLUSHDB')
    })

    it('TigerBeetle 应返回描述性消息', () => {
      const msg = getUnsupportedDropMessage(Engine.TigerBeetle)
      assert(msg.includes('TigerBeetle'), '应提及 TigerBeetle')
      assert(msg.includes('spindb delete'), '应建议替代方案')
    })
  })

  describe('穷举覆盖', () => {
    it('应覆盖所有 21 个 engine', () => {
      assertEqual(ALL_ENGINES.length, 21, '应有恰好 21 个 engine')
      // 此测试确保 getDatabaseCapabilities 能处理所有 engine 而不抛出异常
      // （switch 中的 assertExhaustive 会在缺少任何 engine 时于运行时抛出异常）
      for (const engine of ALL_ENGINES) {
        const caps = getDatabaseCapabilities(engine)
        assert(caps !== undefined, `${engine} 应返回能力信息`)
      }
    })

    it('应有 14 个支持的 engine 和 6 个不支持的 engine', () => {
      const supported = ALL_ENGINES.filter((e) => canCreateDatabase(e))
      const unsupported = ALL_ENGINES.filter((e) => !canCreateDatabase(e))
      assertEqual(supported.length, 14, '应有 14 个支持的 engine')
      assertEqual(unsupported.length, 7, '应有 7 个不支持的 engine')
    })
  })

  describe('native 重命名 engine 实现', () => {
    const nativeRenameEngines = ALL_ENGINES.filter(
      (e) => getDatabaseCapabilities(e).supportsRename === 'native',
    )

    it('每个 native 重命名的 engine 都应覆写 renameDatabase', () => {
      for (const engineName of nativeRenameEngines) {
        const engine = getEngine(engineName)
        // 基础 engine 的 renameDatabase 会抛出 UnsupportedOperationError。
        // Native 重命名的 engine 必须用自己的实现来覆写它。
        // 通过检查该方法是否不是基类的默认实现来验证。
        const proto = Object.getPrototypeOf(engine)
        assert(
          Object.prototype.hasOwnProperty.call(proto, 'renameDatabase'),
          `${engineName} 具有 native 重命名能力但未覆写 renameDatabase()`,
        )
      }
    })

    it('backup-restore engine 不应覆写 renameDatabase', () => {
      const backupRestoreEngines = ALL_ENGINES.filter(
        (e) => getDatabaseCapabilities(e).supportsRename === 'backup-restore',
      )
      for (const engineName of backupRestoreEngines) {
        const engine = getEngine(engineName)
        const proto = Object.getPrototypeOf(engine)
        assertEqual(
          Object.prototype.hasOwnProperty.call(proto, 'renameDatabase'),
          false,
          `${engineName} 使用 backup-restore 但覆写了 renameDatabase() — 是否应改为 native？`,
        )
      }
    })

    it('应包含 PostgreSQL、ClickHouse、CockroachDB 和 Meilisearch', () => {
      const expected = [
        Engine.PostgreSQL,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.Meilisearch,
      ]
      for (const engine of expected) {
        assert(
          nativeRenameEngines.includes(engine),
          `${engine} 应在 native 重命名列表中`,
        )
      }
      assertEqual(
        nativeRenameEngines.length,
        expected.length,
        `应有恰好 ${expected.length} 个 native 重命名的 engine`,
      )
    })
  })
})
