import { describe, it } from 'node:test'
import {
  parseConnectionString,
  detectEngineFromConnectionString,
  detectProvider,
  isLocalhost,
  generateRemoteContainerName,
  redactConnectionString,
  buildRemoteConfig,
  getDefaultPortForEngine,
} from '../../core/remote-container'
import { Engine, isRemoteContainer } from '../../types'
import type { ContainerConfig } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

describe('remote-container', () => {
  describe('parseConnectionString', () => {
    it('应该解析 PostgreSQL 连接字符串', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.example.com:5432/mydb',
      )
      assertEqual(result.scheme, 'postgresql', 'scheme 应为 postgresql')
      assertEqual(result.host, 'host.example.com', 'host 应匹配')
      assertEqual(result.port, 5432, 'port 应为 5432')
      assertEqual(result.database, 'mydb', 'database 应为 mydb')
      assertEqual(result.username, 'user', 'username 应为 user')
      assertEqual(result.password, 'pass', 'password 应为 pass')
    })

    it('应该解析 postgres:// 协议', () => {
      const result = parseConnectionString(
        'postgres://admin:secret@db.neon.tech/app',
      )
      assertEqual(result.scheme, 'postgres', 'scheme 应为 postgres')
      assertEqual(result.host, 'db.neon.tech', 'host 应匹配')
      assertNullish(result.port, '省略时 port 应为 null')
      assertEqual(result.database, 'app', 'database 应为 app')
    })

    it('应该解析 MySQL 连接字符串', () => {
      const result = parseConnectionString(
        'mysql://root:password@mysql.example.com:3306/testdb',
      )
      assertEqual(result.scheme, 'mysql', 'scheme 应为 mysql')
      assertEqual(result.host, 'mysql.example.com', 'host 应匹配')
      assertEqual(result.port, 3306, 'port 应为 3306')
      assertEqual(result.database, 'testdb', 'database 应为 testdb')
    })

    it('应该解析 MongoDB 连接字符串', () => {
      const result = parseConnectionString(
        'mongodb://user:pass@mongo.example.com:27017/myapp',
      )
      assertEqual(result.scheme, 'mongodb', 'scheme 应为 mongodb')
      assertEqual(result.host, 'mongo.example.com', 'host 应匹配')
      assertEqual(result.port, 27017, 'port 应为 27017')
    })

    it('应该解析 mongodb+srv 连接字符串', () => {
      const result = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
      )
      assertEqual(result.scheme, 'mongodb+srv', 'scheme 应为 mongodb+srv')
      assertEqual(result.host, 'cluster.mongodb.net', 'host 应匹配')
    })

    it('应该解析 Redis 连接字符串', () => {
      const result = parseConnectionString(
        'redis://default:mypass@redis.upstash.io:6379',
      )
      assertEqual(result.scheme, 'redis', 'scheme 应为 redis')
      assertEqual(result.host, 'redis.upstash.io', 'host 应匹配')
      assertEqual(result.port, 6379, 'port 应为 6379')
    })

    it('应该解析 rediss (TLS Redis) 连接字符串', () => {
      const result = parseConnectionString(
        'rediss://default:pass@redis.upstash.io:6380',
      )
      assertEqual(result.scheme, 'rediss', 'scheme 应为 rediss')
    })

    it('应该处理密码中的 URL 编码特殊字符', () => {
      const result = parseConnectionString(
        'postgresql://user:p%40ss%23w0rd@host.com/db',
      )
      assertEqual(result.password, 'p@ss#w0rd', '密码应被解码')
    })

    it('应该处理没有端口的连接字符串', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.example.com/mydb',
      )
      assertNullish(result.port, '省略时 port 应为 null')
    })

    it('应该处理带有查询参数的连接字符串', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.com/db?sslmode=require&connect_timeout=10',
      )
      assertEqual(
        result.params.sslmode,
        'require',
        'sslmode 参数应存在',
      )
      assertEqual(
        result.params.connect_timeout,
        '10',
        'connect_timeout 参数应存在',
      )
    })

    it('应该对无效连接字符串抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch {
        threw = true
      }
      assert(threw, '应对无效连接字符串抛出异常')
    })

    it('应该保留原始连接字符串', () => {
      const raw = 'postgresql://user:pass@host.com:5432/db'
      const result = parseConnectionString(raw)
      assertEqual(result.raw, raw, 'raw 应与原始输入匹配')
    })
  })

  describe('detectEngineFromConnectionString', () => {
    it('应该从 postgresql:// 检测到 PostgreSQL', () => {
      const result = detectEngineFromConnectionString(
        'postgresql://user:pass@host/db',
      )
      assertEqual(result, Engine.PostgreSQL, '应检测到 postgresql')
    })

    it('应该从 postgres:// 检测到 PostgreSQL', () => {
      const result = detectEngineFromConnectionString(
        'postgres://user:pass@host/db',
      )
      assertEqual(result, Engine.PostgreSQL, '应检测到 postgres')
    })

    it('应该从 mysql:// 检测到 MySQL', () => {
      const result = detectEngineFromConnectionString(
        'mysql://user:pass@host/db',
      )
      assertEqual(result, Engine.MySQL, '应检测到 mysql')
    })

    it('应该从 mongodb:// 检测到 MongoDB', () => {
      const result = detectEngineFromConnectionString(
        'mongodb://user:pass@host/db',
      )
      assertEqual(result, Engine.MongoDB, '应检测到 mongodb')
    })

    it('应该从 mongodb+srv:// 检测到 MongoDB', () => {
      const result = detectEngineFromConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/db',
      )
      assertEqual(result, Engine.MongoDB, '应检测到 mongodb+srv')
    })

    it('应该从 redis:// 检测到 Redis', () => {
      const result = detectEngineFromConnectionString(
        'redis://user:pass@host:6379',
      )
      assertEqual(result, Engine.Redis, '应检测到 redis')
    })

    it('应该从 rediss:// 检测到 Redis', () => {
      const result = detectEngineFromConnectionString(
        'rediss://user:pass@host:6380',
      )
      assertEqual(result, Engine.Redis, '应检测到 rediss')
    })

    it('应该对 http:// 返回 null (不明确)', () => {
      const result = detectEngineFromConnectionString(
        'http://localhost:8080/api',
      )
      assertNullish(result, '对 http 应返回 null')
    })

    it('应该对未知协议返回 null', () => {
      const result = detectEngineFromConnectionString(
        'ftp://user:pass@host/path',
      )
      assertNullish(result, '对 ftp 应返回 null')
    })
  })

  describe('detectProvider', () => {
    it('应该从主机名检测到 Neon', () => {
      assertEqual(
        detectProvider('ep-cool-123.us-east-2.aws.neon.tech'),
        'neon',
        '应检测到 neon',
      )
    })

    it('应该从主机名检测到 Supabase', () => {
      assertEqual(
        detectProvider('db.abcdefgh.supabase.co'),
        'supabase',
        '应检测到 supabase .co',
      )
      assertEqual(
        detectProvider('db.abcdefgh.supabase.com'),
        'supabase',
        '应检测到 supabase .com',
      )
    })

    it('应该从主机名检测到 PlanetScale', () => {
      assertEqual(
        detectProvider('aws.connect.psdb.cloud.planetscale.com'),
        'planetscale',
        '应检测到 planetscale',
      )
    })

    it('应该从主机名检测到 Upstash', () => {
      assertEqual(
        detectProvider('us1-merry-cat-12345.upstash.io'),
        'upstash',
        '应检测到 upstash',
      )
    })

    it('应该从主机名检测到 Railway', () => {
      assertEqual(
        detectProvider('monorail.proxy.rlwy.net.railway.app'),
        'railway',
        '应检测到 railway',
      )
    })

    it('应该从主机名检测到 Aiven', () => {
      assertEqual(
        detectProvider('pg-xxxx.aivencloud.com.aiven.io'),
        'aiven',
        '应检测到 aiven',
      )
    })

    it('应该从主机名检测到 CockroachDB Cloud', () => {
      assertEqual(
        detectProvider('free-xxxx.cockroachlabs.cloud'),
        'cockroachdb-cloud',
        '应检测到 cockroachdb-cloud',
      )
    })

    it('应该对未知主机返回 null', () => {
      assertNullish(
        detectProvider('my-custom-server.example.com'),
        '对未知主机应返回 null',
      )
    })

    it('应该对 localhost 返回 null', () => {
      assertNullish(
        detectProvider('localhost'),
        '对 localhost 应返回 null',
      )
    })
  })

  describe('isLocalhost', () => {
    it('应该检测到 127.0.0.1', () => {
      assert(isLocalhost('127.0.0.1'), '127.0.0.1 应为 localhost')
    })

    it('应该检测到 localhost', () => {
      assert(isLocalhost('localhost'), 'localhost 应为 localhost')
    })

    it('应该检测到 ::1', () => {
      assert(isLocalhost('::1'), '::1 应为 localhost')
    })

    it('应该检测到 [::1]', () => {
      assert(isLocalhost('[::1]'), '[::1] 应为 localhost')
    })

    it('应该不检测到远程主机', () => {
      assert(
        !isLocalhost('db.neon.tech'),
        'db.neon.tech 不应为 localhost',
      )
      assert(!isLocalhost('192.168.1.1'), '192.168.1.1 不应为 localhost')
    })
  })

  describe('generateRemoteContainerName', () => {
    it('当 provider 和 database 都可用时应使用 provider + database', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'ep-cool-123.neon.tech',
        database: 'myapp',
        provider: 'neon',
      })
      assertEqual(name, 'neon-myapp', '应为 provider-database')
    })

    it('当没有 database 时应使用 provider + engine', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'ep-cool-123.neon.tech',
        database: '',
        provider: 'neon',
      })
      assertEqual(name, 'neon-postgresql', '应为 provider-engine')
    })

    it('当没有 provider 时应使用 remote + database', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'custom-server.example.com',
        database: 'myapp',
      })
      assertEqual(name, 'remote-myapp', '应为 remote-database')
    })

    it('应回退到 remote + host 前缀', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'custom-server.example.com',
        database: '',
      })
      assertEqual(
        name,
        'remote-custom-server',
        '应使用 host 前缀回退',
      )
    })

    it('应该清理特殊字符', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.example.com',
        database: 'my.special@db',
        provider: null,
      })
      assert(
        /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name),
        `名称 "${name}" 应被清理`,
      )
    })
  })

  describe('redactConnectionString', () => {
    it('应该用 *** 替换密码', () => {
      const result = redactConnectionString(
        'postgresql://user:mysecretpass@host.com/db',
      )
      assert(
        result.includes(':***@'),
        '应包含密码脱敏标记',
      )
      assert(
        !result.includes('mysecretpass'),
        '不应包含原始密码',
      )
    })

    it('应该处理 URL 编码的密码', () => {
      const result = redactConnectionString(
        'postgresql://user:p%40ss%23word@host.com/db',
      )
      assert(
        !result.includes('p%40ss%23word'),
        '不应包含编码后的密码',
      )
      assert(result.includes(':***@'), '应包含脱敏标记')
    })

    it('应该不修改没有密码的字符串', () => {
      const url = 'postgresql://user@host.com/db'
      const result = redactConnectionString(url)
      assertEqual(result, url, '应返回未修改的 URL')
    })

    it('应该处理空密码', () => {
      const url = 'postgresql://user:@host.com/db'
      const result = redactConnectionString(url)
      assertEqual(
        result,
        url,
        '对空密码应返回未修改的 URL',
      )
    })
  })

  describe('buildRemoteConfig', () => {
    it('应该为远程主机构建启用 SSL 的配置', () => {
      const config = buildRemoteConfig({
        host: 'db.neon.tech',
        connectionString: 'postgresql://user:pass@db.neon.tech/mydb',
        provider: 'neon',
      })
      assertEqual(config.host, 'db.neon.tech', 'host 应匹配')
      assertEqual(config.origin, 'external', 'origin 应默认为 external')
      assertEqual(config.ssl, true, '远程主机的 SSL 应为 true')
      assertEqual(config.provider, 'neon', 'provider 应为 neon')
      assert(
        !config.connectionString.includes('pass'),
        '连接字符串应被脱敏',
      )
    })

    it('应该将 layerbase 链接标记为 cloud origin', () => {
      const config = buildRemoteConfig({
        host: 'pg-1.dev.cloud.layerbase.dev',
        connectionString:
          'postgresql://user:pass@pg-1.dev.cloud.layerbase.dev/mydb',
        provider: 'layerbase-staging',
      })
      assertEqual(
        config.origin,
        'layerbase-cloud',
        'origin 应将 layerbase 主机标记为 cloud 链接',
      )
    })

    it('应该为 localhost 禁用 SSL', () => {
      const config = buildRemoteConfig({
        host: 'localhost',
        connectionString: 'postgresql://user:pass@localhost/mydb',
      })
      assertEqual(config.ssl, false, 'localhost 的 SSL 应为 false')
    })

    it('应该为 127.0.0.1 禁用 SSL', () => {
      const config = buildRemoteConfig({
        host: '127.0.0.1',
        connectionString: 'postgresql://user:pass@127.0.0.1/mydb',
      })
      assertEqual(config.ssl, false, '127.0.0.1 的 SSL 应为 false')
    })

    it('应该允许显式 SSL 覆盖', () => {
      const config = buildRemoteConfig({
        host: 'localhost',
        connectionString: 'postgresql://user:pass@localhost/mydb',
        ssl: true,
      })
      assertEqual(config.ssl, true, 'SSL 应被覆盖为 true')
    })

    it('当 provider 为 null 时应省略', () => {
      const config = buildRemoteConfig({
        host: 'custom.example.com',
        connectionString: 'postgresql://user:pass@custom.example.com/mydb',
        provider: null,
      })
      assertEqual(
        config.provider,
        undefined,
        '当为 null 时 provider 应为 undefined',
      )
    })
  })

  describe('getDefaultPortForEngine', () => {
    it('应该为 PostgreSQL 返回 5432', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.PostgreSQL),
        5432,
        'PostgreSQL 默认端口',
      )
    })

    it('应该为 MySQL 返回 3306', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MySQL),
        3306,
        'MySQL 默认端口',
      )
    })

    it('应该为 MongoDB 返回 27017', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MongoDB),
        27017,
        'MongoDB 默认端口',
      )
    })

    it('应该为 Redis 返回 6379', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Redis),
        6379,
        'Redis 默认端口',
      )
    })

    it('应该为 Valkey 返回 6379', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Valkey),
        6379,
        'Valkey 默认端口',
      )
    })
  })

  describe('parseConnectionString - 边界情况', () => {
    it('应该处理没有用户名的连接字符串', () => {
      const result = parseConnectionString('redis://:mypass@host.io:6379')
      assertEqual(result.username, '', 'username 应为空')
      assertEqual(result.password, 'mypass', 'password 应为 mypass')
    })

    it('应该处理数据库路径为空的连接字符串', () => {
      const result = parseConnectionString('redis://default:pass@host.io:6379')
      assertEqual(result.database, '', 'database 应为空')
    })

    it('应该处理只有主机的连接字符串', () => {
      const result = parseConnectionString('postgresql://host.com')
      assertEqual(result.host, 'host.com', 'host 应匹配')
      assertEqual(result.username, '', 'username 应为空')
      assertEqual(result.password, '', 'password 应为空')
      assertEqual(result.database, '', 'database 应为空')
    })

    it('应该处理包含正则表达式特殊字符的密码', () => {
      const result = parseConnectionString(
        'postgresql://user:a%2Bb%24c%5Ed@host.com/db',
      )
      assertEqual(
        result.password,
        'a+b$c^d',
        '包含正则表达式字符的密码应被解码',
      )
    })

    it('应该处理非常长的主机名', () => {
      const longHost = 'a'.repeat(200) + '.example.com'
      const result = parseConnectionString(
        `postgresql://user:pass@${longHost}/db`,
      )
      assertEqual(result.host, longHost, '长主机名应被保留')
    })

    it('应该解析带有 localhost IPv4 的连接字符串', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@127.0.0.1:5432/mydb',
      )
      assertEqual(result.host, '127.0.0.1', 'host 应为 127.0.0.1')
      assertEqual(result.port, 5432, 'port 应为 5432')
    })

    it('应该处理包含斜杠的数据库名', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.com/my%2Fdb',
      )
      assertEqual(
        result.database,
        'my/db',
        '包含斜杠的数据库名应被解码',
      )
    })

    it('应该处理没有端口的 mongodb+srv', () => {
      const result = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb?retryWrites=true',
      )
      assertNullish(result.port, 'mongodb+srv 应没有端口')
      assertEqual(result.params.retryWrites, 'true', '参数应被解析')
    })
  })

  describe('redactConnectionString - 边界情况', () => {
    it('应该脱敏包含正则表达式特殊字符的密码', () => {
      const url = 'postgresql://user:a+b$c^d@host.com/db'
      const result = redactConnectionString(url)
      assert(!result.includes('a+b$c^d'), '不应包含原始密码')
      assert(result.includes(':***@'), '应包含脱敏标记')
    })

    it('应该脱敏包含正则表达式特殊字符的 URL 编码密码', () => {
      const url = 'postgresql://user:a%2Bb%24c%5Ed@host.com/db'
      const result = redactConnectionString(url)
      assert(
        !result.includes('a%2Bb%24c%5Ed'),
        '不应包含编码后的密码',
      )
      assert(result.includes(':***@'), '应包含脱敏标记')
    })

    it('应该处理包含 @ 符号的密码', () => {
      const url = 'postgresql://user:p%40ssword@host.com/db'
      const result = redactConnectionString(url)
      assert(
        !result.includes('p%40ssword'),
        '不应包含编码后的密码',
      )
      assert(result.includes(':***@'), '应包含脱敏标记')
    })

    it('应该在脱敏后保留协议和主机', () => {
      const result = redactConnectionString(
        'postgresql://user:secret@db.neon.tech:5432/mydb',
      )
      assert(result.startsWith('postgresql://'), '应保留协议')
      assert(result.includes('db.neon.tech'), '应保留主机')
      assert(result.includes('/mydb'), '应保留数据库')
    })
  })

  describe('generateRemoteContainerName - 边界情况', () => {
    it('应该截断非常长的名称', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.com',
        database: 'a'.repeat(100),
        provider: 'neon',
      })
      assert(name.length <= 50, `名称 "${name}" 应 <= 50 个字符`)
    })

    it('应该处理全数字的数据库名', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.com',
        database: '12345',
        provider: null,
      })
      assert(
        /^[a-zA-Z]/.test(name),
        `名称 "${name}" 应以字母开头`,
      )
    })

    it('应该处理空主机和数据库', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: '',
        database: '',
        provider: null,
      })
      assert(name.length > 0, '应返回非空名称')
      assert(
        /^[a-zA-Z]/.test(name),
        `名称 "${name}" 应以字母开头`,
      )
    })
  })

  describe('getDefaultPortForEngine - 完整覆盖', () => {
    it('应该为 TypeDB 返回 1729', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.TypeDB),
        1729,
        'TypeDB 默认端口',
      )
    })

    it('应该为 TigerBeetle 返回 3000', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.TigerBeetle),
        3000,
        'TigerBeetle 默认端口',
      )
    })

    it('应该为 SQLite 返回 0', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.SQLite),
        0,
        'SQLite 端口应为 0',
      )
    })

    it('应该为 DuckDB 返回 0', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.DuckDB),
        0,
        'DuckDB 端口应为 0',
      )
    })

    it('应该为 CockroachDB 返回 26257', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.CockroachDB),
        26257,
        'CockroachDB 默认端口',
      )
    })

    it('应该为 SurrealDB 返回 8000', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.SurrealDB),
        8000,
        'SurrealDB 默认端口',
      )
    })

    it('应该为 Qdrant 返回 6333', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Qdrant),
        6333,
        'Qdrant 默认端口',
      )
    })

    it('应该为 Meilisearch 返回 7700', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Meilisearch),
        7700,
        'Meilisearch 默认端口',
      )
    })

    it('应该为 CouchDB 返回 5984', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.CouchDB),
        5984,
        'CouchDB 默认端口',
      )
    })

    it('应该为 QuestDB 返回 8812', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.QuestDB),
        8812,
        'QuestDB 默认端口',
      )
    })

    it('应该为 InfluxDB 返回 8086', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.InfluxDB),
        8086,
        'InfluxDB 默认端口',
      )
    })

    it('应该为 Weaviate 返回 8080', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Weaviate),
        8080,
        'Weaviate 默认端口',
      )
    })

    it('应该为 ClickHouse 返回 8123', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.ClickHouse),
        8123,
        'ClickHouse 默认端口',
      )
    })

    it('应该为 FerretDB 返回 27017', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.FerretDB),
        27017,
        'FerretDB 默认端口',
      )
    })

    it('应该为 MariaDB 返回 3306', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MariaDB),
        3306,
        'MariaDB 默认端口',
      )
    })
  })

  describe('buildRemoteConfig - 边界情况', () => {
    it('应该处理没有密码的连接字符串', () => {
      const config = buildRemoteConfig({
        host: 'db.example.com',
        connectionString: 'postgresql://user@db.example.com/mydb',
      })
      assertEqual(config.ssl, true, '远程主机的 SSL 应为 true')
      assertEqual(
        config.connectionString,
        'postgresql://user@db.example.com/mydb',
        '没有密码的 URL 不应被修改',
      )
    })

    it('应该处理 IPv6 localhost', () => {
      const config = buildRemoteConfig({
        host: '::1',
        connectionString: 'postgresql://user:pass@[::1]/mydb',
      })
      assertEqual(config.ssl, false, 'IPv6 localhost 的 SSL 应为 false')
    })
  })

  describe('isRemoteContainer', () => {
    it('对有远程配置的容器应返回 true', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'linked' as const,
        remote: {
          host: 'db.neon.tech',
          connectionString: 'postgresql://user:***@db.neon.tech/mydb',
          ssl: true,
          provider: 'neon',
        },
      } as ContainerConfig
      assert(isRemoteContainer(config), '应为远程容器')
    })

    it('对本地容器应返回 false', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'running' as const,
      } as ContainerConfig
      assert(!isRemoteContainer(config), '不应为远程容器')
    })

    it('对没有 remote 字段的容器应返回 false', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'stopped' as const,
      } as ContainerConfig
      assert(!isRemoteContainer(config), '没有 remote 字段不应为远程容器')
    })
  })
})
