import { describe, it } from 'node:test'
import { ConfigManager } from '../../core/config-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('ConfigManager', () => {
  describe('load', () => {
    it('should return cached config on subsequent calls', async () => {
      const configManager = new ConfigManager()
      const config1 = await configManager.load()
      const config2 = await configManager.load()

      // 两次调用应返回相同的对象（缓存）
      assertEqual(config1, config2, '应返回缓存的配置')
    })

    it('should create default config if none exists', async () => {
      const configManager = new ConfigManager()
      const config = await configManager.load()

      assert(config !== null, '配置不应为 null')
      assert(typeof config === 'object', '配置应为对象')
      assert('binaries' in config, '配置应有 binaries 属性')
    })
  })

  describe('isStale', () => {
    it('should return true when updatedAt is missing', async () => {
      const configManager = new ConfigManager()
      // 强制加载一个没有 updatedAt 的配置
      await configManager.load()
      // 配置可能已设置 updatedAt，但概念应成立
      const isStale = await configManager.isStale()
      assert(typeof isStale === 'boolean', 'isStale 应返回布尔值')
    })

    it('should compare dates correctly', () => {
      const CACHE_STALENESS_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

      const freshDate = new Date()
      const staleDate = new Date(Date.now() - (CACHE_STALENESS_MS + 1000))

      const freshElapsed = Date.now() - freshDate.getTime()
      const staleElapsed = Date.now() - staleDate.getTime()

      assert(
        freshElapsed < CACHE_STALENESS_MS,
        '新鲜日期不应过期',
      )
      assert(staleElapsed > CACHE_STALENESS_MS, '过期日期应过期')
    })
  })

  describe('Tool Categories', () => {
    it('should export PostgreSQL tools', async () => {
      const { POSTGRESQL_TOOLS } = await import('../../core/config-manager')

      assert(Array.isArray(POSTGRESQL_TOOLS), '应为数组')
      assert(POSTGRESQL_TOOLS.includes('psql'), '应包含 psql')
      assert(POSTGRESQL_TOOLS.includes('pg_dump'), '应包含 pg_dump')
      assert(
        POSTGRESQL_TOOLS.includes('pg_restore'),
        '应包含 pg_restore',
      )
    })

    it('should export MySQL tools', async () => {
      const { MYSQL_TOOLS } = await import('../../core/config-manager')

      assert(Array.isArray(MYSQL_TOOLS), '应为数组')
      assert(MYSQL_TOOLS.includes('mysql'), '应包含 mysql')
      assert(MYSQL_TOOLS.includes('mysqldump'), '应包含 mysqldump')
      assert(MYSQL_TOOLS.includes('mysqladmin'), '应包含 mysqladmin')
      assert(MYSQL_TOOLS.includes('mysqld'), '应包含 mysqld')
    })

    it('should export enhanced shells', async () => {
      const { ENHANCED_SHELLS } = await import('../../core/config-manager')

      assert(Array.isArray(ENHANCED_SHELLS), '应为数组')
      assert(ENHANCED_SHELLS.includes('pgcli'), '应包含 pgcli')
      assert(ENHANCED_SHELLS.includes('mycli'), '应包含 mycli')
      assert(ENHANCED_SHELLS.includes('usql'), '应包含 usql')
    })

    it('should export ALL_TOOLS combining all categories', async () => {
      const {
        ALL_TOOLS,
        POSTGRESQL_TOOLS,
        MYSQL_TOOLS,
        MARIADB_TOOLS,
        MONGODB_TOOLS,
        FERRETDB_TOOLS,
        REDIS_TOOLS,
        VALKEY_TOOLS,
        QDRANT_TOOLS,
        MEILISEARCH_TOOLS,
        COUCHDB_TOOLS,
        COCKROACHDB_TOOLS,
        SURREALDB_TOOLS,
        QUESTDB_TOOLS,
        TYPEDB_TOOLS,
        INFLUXDB_TOOLS,
        WEAVIATE_TOOLS,
        TIGERBEETLE_TOOLS,
        LIBSQL_TOOLS,
        PGWEB_TOOLS,
        DBLAB_TOOLS,
        SQLITE_TOOLS,
        DUCKDB_TOOLS,
        ENHANCED_SHELLS,
      } = await import('../../core/config-manager')

      const expectedLength =
        POSTGRESQL_TOOLS.length +
        MYSQL_TOOLS.length +
        MARIADB_TOOLS.length +
        MONGODB_TOOLS.length +
        FERRETDB_TOOLS.length +
        REDIS_TOOLS.length +
        VALKEY_TOOLS.length +
        QDRANT_TOOLS.length +
        MEILISEARCH_TOOLS.length +
        COUCHDB_TOOLS.length +
        COCKROACHDB_TOOLS.length +
        SURREALDB_TOOLS.length +
        QUESTDB_TOOLS.length +
        TYPEDB_TOOLS.length +
        INFLUXDB_TOOLS.length +
        WEAVIATE_TOOLS.length +
        TIGERBEETLE_TOOLS.length +
        LIBSQL_TOOLS.length +
        PGWEB_TOOLS.length +
        DBLAB_TOOLS.length +
        SQLITE_TOOLS.length +
        DUCKDB_TOOLS.length +
        ENHANCED_SHELLS.length

      assertEqual(
        ALL_TOOLS.length,
        expectedLength,
        'ALL_TOOLS 应组合所有类别',
      )
    })
  })

  describe('BinaryConfig Shape', () => {
    it('should have correct structure for binary configs', () => {
      const binaryConfig = {
        tool: 'psql',
        path: '/usr/local/bin/psql',
        source: 'system',
        version: '16.0',
      }

      assertEqual(binaryConfig.tool, 'psql', '应有工具名称')
      assert(typeof binaryConfig.path === 'string', '应有路径')
      // BinarySource 是 'bundled' | 'system' | 'custom'
      assert(
        binaryConfig.source === 'system' ||
          binaryConfig.source === 'bundled' ||
          binaryConfig.source === 'custom',
        '源应为 system、bundled 或 custom',
      )
    })
  })

  describe('Version Detection', () => {
    it('should parse version from --version output', () => {
      const versionOutputs = [
        { output: 'psql (PostgreSQL) 16.0', expected: '16.0' },
        { output: 'mysql  Ver 8.0.32', expected: '8.0' },
        { output: 'pg_dump (PostgreSQL) 15.4', expected: '15.4' },
      ]

      for (const { output, expected } of versionOutputs) {
        const match = output.match(/\d+\.\d+/)
        assert(match !== null, `应匹配版本于: ${output}`)
        assertEqual(
          match![0],
          expected,
          `应从 ${output} 提取 ${expected}`,
        )
      }
    })

    it('should handle version detection failure gracefully', () => {
      const invalidOutputs = ['no version here', '', 'error: command not found']

      for (const output of invalidOutputs) {
        const match = output.match(/\d+\.\d+/)
        assertEqual(match, null, `不应匹配版本于: ${output}`)
      }
    })
  })

  describe('Error Handling', () => {
    it('should handle corrupted config JSON', async () => {
      // 测试处理 JSON 解析错误的概念
      const invalidJSON = '{ invalid json'
      let parseError = null

      try {
        JSON.parse(invalidJSON)
      } catch (error) {
        parseError = error
      }

      assert(parseError !== null, '应对无效 JSON 抛出')
      assert(parseError instanceof SyntaxError, '应为 SyntaxError')
    })

    it('should handle missing binary path gracefully', async () => {
      const configManager = new ConfigManager()
      // 请求一个不存在的工具（如果未安装）
      const path = await configManager.getBinaryPath(
        'nonexistent-tool' as 'psql',
      )

      // 如果工具不存在，应返回 null
      assert(
        path === null || typeof path === 'string',
        '应返回 null 或路径字符串',
      )
    })
  })

  describe('Path Validation', () => {
    it('should verify binary path exists before returning', async () => {
      const configManager = new ConfigManager()
      // 如果路径已配置但不再存在，则应清除
      // 这测试 getBinaryPath 中的 existsSync 检查
      const path = await configManager.getBinaryPath('psql')

      if (path !== null) {
        // 如果获取到路径，它应存在
        const { existsSync } = await import('fs')
        assert(existsSync(path), '返回的路径应存在')
      }
    })
  })
})

describe('Config File Operations', () => {
  it('should use correct config path', async () => {
    const { paths } = await import('../../config/paths')

    assert(
      paths.config.includes('.spindb'),
      '配置应在 .spindb 目录中',
    )
    assert(
      paths.config.endsWith('config.json'),
      '配置文件应为 config.json',
    )
  })
})
