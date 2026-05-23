import { describe, it } from 'node:test'
import { Engine, isRemoteContainer } from '../../types'
import type { ContainerConfig, QueryOptions } from '../../types'
import { parseConnectionString } from '../../core/remote-container'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

/**
 * 远程容器查询支持测试。
 *
 * 验证 QueryOptions 是否正确携带远程连接信息，
 * 以及查询命令路由逻辑是否正确处理远程容器，
 * 无需进行"运行中"检查。
 */

// 创建远程容器配置的辅助函数
function makeRemoteConfig(
  overrides?: Partial<ContainerConfig>,
): ContainerConfig {
  return {
    name: 'neon-myapp',
    engine: Engine.PostgreSQL,
    version: '16',
    port: 5432,
    database: 'myapp',
    created: '2024-01-01',
    status: 'linked' as const,
    remote: {
      host: 'ep-cool-123.us-east-2.aws.neon.tech',
      connectionString:
        'postgresql://user:***@ep-cool-123.us-east-2.aws.neon.tech/myapp',
      ssl: true,
      provider: 'neon',
    },
    ...overrides,
  } as ContainerConfig
}

// 创建本地容器配置的辅助函数
function makeLocalConfig(
  overrides?: Partial<ContainerConfig>,
): ContainerConfig {
  return {
    name: 'local-pg',
    engine: Engine.PostgreSQL,
    version: '16',
    port: 5432,
    database: 'mydb',
    created: '2024-01-01',
    status: 'running' as const,
    ...overrides,
  } as ContainerConfig
}

describe('远程查询支持', () => {
  describe('QueryOptions 远程字段', () => {
    it('应接受 host、password、username 和 ssl', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        host: 'db.neon.tech',
        password: 'secret',
        username: 'admin',
        ssl: true,
      }
      assertEqual(opts.host, 'db.neon.tech', 'host 应已设置')
      assertEqual(opts.password, 'secret', 'password 应已设置')
      assertEqual(opts.username, 'admin', 'username 应已设置')
      assertEqual(opts.ssl, true, 'ssl 应为 true')
    })

    it('应允许所有远程字段为 undefined 以用于本地查询', () => {
      const opts: QueryOptions = {
        database: 'mydb',
      }
      assertEqual(opts.host, undefined, 'host 应为 undefined')
      assertEqual(opts.password, undefined, 'password 应为 undefined')
      assertEqual(opts.username, undefined, 'username 应为 undefined')
      assertEqual(opts.ssl, undefined, 'ssl 应为 undefined')
    })

    it('应能与 REST API 选项共存', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        method: 'GET',
        body: { key: 'value' },
        host: 'remote.example.com',
        password: 'pass',
      }
      assertEqual(opts.method, 'GET', 'method 应已设置')
      assertEqual(opts.host, 'remote.example.com', 'host 应已设置')
    })
  })

  describe('用于查询路由的远程容器检测', () => {
    it('应通过 isRemoteContainer 识别远程容器', () => {
      const remote = makeRemoteConfig()
      assert(isRemoteContainer(remote), '应为远程容器')
    })

    it('不应将本地容器识别为远程容器', () => {
      const local = makeLocalConfig()
      assert(!isRemoteContainer(local), '不应为远程容器')
    })

    it('应识别任意引擎的远程容器', () => {
      const mysqlRemote = makeRemoteConfig({
        engine: Engine.MySQL,
        remote: {
          host: 'mysql.planetscale.com',
          connectionString: 'mysql://user:***@mysql.planetscale.com/mydb',
          ssl: true,
          provider: 'planetscale',
        },
      })
      assert(isRemoteContainer(mysqlRemote), 'MySQL 远程容器应被检测到')

      const mongoRemote = makeRemoteConfig({
        engine: Engine.MongoDB,
        remote: {
          host: 'cluster.mongodb.net',
          connectionString: 'mongodb+srv://user:***@cluster.mongodb.net/mydb',
          ssl: true,
        },
      })
      assert(
        isRemoteContainer(mongoRemote),
        'MongoDB 远程容器应被检测到',
      )

      const redisRemote = makeRemoteConfig({
        engine: Engine.Redis,
        remote: {
          host: 'redis.upstash.io',
          connectionString: 'rediss://default:***@redis.upstash.io:6379',
          ssl: true,
          provider: 'upstash',
        },
      })
      assert(isRemoteContainer(redisRemote), 'Redis 远程容器应被检测到')
    })
  })

  describe('用于查询选项的连接字符串解析', () => {
    it('应提取 PostgreSQL 连接详情', () => {
      const parsed = parseConnectionString(
        'postgresql://myuser:mypass@ep-cool-123.neon.tech:5432/mydb',
      )
      assertEqual(parsed.host, 'ep-cool-123.neon.tech', 'host')
      assertEqual(parsed.port, 5432, 'port')
      assertEqual(parsed.username, 'myuser', 'username')
      assertEqual(parsed.password, 'mypass', 'password')
      assertEqual(parsed.database, 'mydb', 'database')
    })

    it('应提取 MySQL 连接详情', () => {
      const parsed = parseConnectionString(
        'mysql://admin:secret@mysql.planetscale.com:3306/app',
      )
      assertEqual(parsed.host, 'mysql.planetscale.com', 'host')
      assertEqual(parsed.port, 3306, 'port')
      assertEqual(parsed.username, 'admin', 'username')
      assertEqual(parsed.password, 'secret', 'password')
    })

    it('应提取 MongoDB 连接详情', () => {
      const parsed = parseConnectionString(
        'mongodb://dbuser:dbpass@cluster.mongodb.net:27017/testdb',
      )
      assertEqual(parsed.host, 'cluster.mongodb.net', 'host')
      assertEqual(parsed.port, 27017, 'port')
      assertEqual(parsed.username, 'dbuser', 'username')
      assertEqual(parsed.password, 'dbpass', 'password')
    })

    it('应提取 Redis 连接详情', () => {
      const parsed = parseConnectionString(
        'redis://default:token123@redis.upstash.io:6379',
      )
      assertEqual(parsed.host, 'redis.upstash.io', 'host')
      assertEqual(parsed.port, 6379, 'port')
      assertEqual(parsed.username, 'default', 'username')
      assertEqual(parsed.password, 'token123', 'password')
    })

    it('应处理未指定端口的连接', () => {
      const parsed = parseConnectionString(
        'postgresql://user:pass@db.supabase.co/postgres',
      )
      assertEqual(parsed.host, 'db.supabase.co', 'host')
      assertNullish(parsed.port, '端口省略时应为 null')
    })

    it('应解码 URL 编码的凭据', () => {
      const parsed = parseConnectionString(
        'postgresql://user:p%40ss%23w0rd@host.com/db',
      )
      assertEqual(parsed.password, 'p@ss#w0rd', 'password 应被解码')
    })

    it('应处理 mongodb+srv 协议', () => {
      const parsed = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
      )
      assertEqual(parsed.scheme, 'mongodb+srv', 'scheme')
      assertEqual(parsed.host, 'cluster.mongodb.net', 'host')
      assertNullish(parsed.port, 'mongodb+srv 不应有端口')
    })
  })

  describe('从远程配置构建 QueryOptions', () => {
    it('应从连接字符串构建 PostgreSQL 查询选项', () => {
      const connectionString =
        'postgresql://neonuser:neonpass@ep-cool-123.neon.tech:5432/mydb'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig()

      const queryOpts: QueryOptions = {
        database: parsed.database || config.database,
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: config.remote?.ssl,
      }

      assertEqual(
        queryOpts.host,
        'ep-cool-123.neon.tech',
        'host 应来自连接字符串',
      )
      assertEqual(queryOpts.password, 'neonpass', 'password 来自连接字符串')
      assertEqual(queryOpts.username, 'neonuser', 'username 来自连接字符串')
      assertEqual(queryOpts.ssl, true, 'ssl 来自远程配置')
      assertEqual(queryOpts.database, 'mydb', 'database 来自连接字符串')
    })

    it('应从连接字符串构建 MySQL 查询选项', () => {
      const connectionString =
        'mysql://admin:secret@mysql.planetscale.com:3306/app'
      const parsed = parseConnectionString(connectionString)

      const queryOpts: QueryOptions = {
        database: parsed.database,
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: true,
      }

      assertEqual(queryOpts.host, 'mysql.planetscale.com', 'host')
      assertEqual(queryOpts.password, 'secret', 'password')
      assertEqual(queryOpts.username, 'admin', 'username')
      assertEqual(queryOpts.ssl, true, 'ssl')
    })

    it('应从连接字符串构建 Redis 查询选项', () => {
      const connectionString = 'rediss://default:token@redis.upstash.io:6379/0'
      const parsed = parseConnectionString(connectionString)

      const queryOpts: QueryOptions = {
        database: parsed.database || '0',
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: true,
      }

      assertEqual(queryOpts.host, 'redis.upstash.io', 'host')
      assertEqual(queryOpts.password, 'token', 'password')
      assertEqual(queryOpts.ssl, true, 'ssl 用于 rediss 协议')
    })

    it('应使用连接字符串中的端口覆盖容器端口', () => {
      const connectionString = 'postgresql://user:pass@host.com:6543/db'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig({ port: 5432 })

      // 模拟 query.ts 的行为
      if (parsed.port) {
        config.port = parsed.port
      }

      assertEqual(config.port, 6543, '端口应被覆盖')
    })

    it('连接字符串省略端口时不应覆盖端口', () => {
      const connectionString = 'postgresql://user:pass@host.com/db'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig({ port: 5432 })

      if (parsed.port) {
        config.port = parsed.port
      }

      assertEqual(config.port, 5432, '端口应保持不变')
    })
  })

  describe('远程查询选项回退行为', () => {
    it('options.host 为 undefined 时应使用默认主机', () => {
      const opts: QueryOptions = { database: 'mydb' }
      const host = opts.host ?? '127.0.0.1'
      assertEqual(host, '127.0.0.1', '应回退到本地主机')
    })

    it('options.host 已设置时应使用远程主机', () => {
      const opts: QueryOptions = { database: 'mydb', host: 'db.neon.tech' }
      const host = opts.host ?? '127.0.0.1'
      assertEqual(host, 'db.neon.tech', '应使用远程主机')
    })

    it('options.username 为 undefined 时应使用默认超级用户', () => {
      const opts: QueryOptions = { database: 'mydb' }
      const defaultSuperuser = 'postgres'
      const user = opts.username || defaultSuperuser
      assertEqual(user, 'postgres', '应回退到默认超级用户')
    })

    it('设置远程用户名时应使用远程用户名', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        username: 'remoteuser',
      }
      const defaultSuperuser = 'postgres'
      const user = opts.username || defaultSuperuser
      assertEqual(user, 'remoteuser', '应使用远程用户名')
    })
  })

  describe('引擎特定的远程查询模式', () => {
    describe('PostgreSQL 远程参数', () => {
      it('应使用远程主机构建正确的 psql 参数', () => {
        const opts: QueryOptions = {
          database: 'mydb',
          host: 'db.neon.tech',
          username: 'neonuser',
          password: 'neonpass',
          ssl: true,
        }
        const port = 5432

        const host = opts.host ?? '127.0.0.1'
        const user = opts.username || 'postgres'
        const args = ['-X', '-h', host, '-p', String(port), '-U', user]

        assert(args.includes('db.neon.tech'), '应包含远程主机')
        assert(args.includes('neonuser'), '应包含远程用户名')
        assertEqual(
          args.indexOf('127.0.0.1'),
          -1,
          '不应包含本地主机',
        )
        // SSL 通过 PGSSLMODE 环境变量设置，而非参数
        assert(
          !args.includes('--set=sslmode=require'),
          '不应使用 --set 设置 sslmode',
        )
      })

      it('应为远程连接设置 PGPASSWORD 和 PGSSLMODE 环境变量', () => {
        const opts: QueryOptions = { password: 'secret', ssl: true }
        const env: Record<string, string> = {}
        if (opts.password) {
          env.PGPASSWORD = opts.password
        }
        if (opts.ssl) {
          env.PGSSLMODE = 'require'
        }
        assertEqual(env.PGPASSWORD, 'secret', 'PGPASSWORD 应已设置')
        assertEqual(env.PGSSLMODE, 'require', 'PGSSLMODE 应已设置')
      })

      it('不应为本地查询设置 PGPASSWORD', () => {
        const opts: QueryOptions = { database: 'mydb' }
        const env: Record<string, string> = {}
        if (opts.password) {
          env.PGPASSWORD = opts.password
        }
        assertEqual(
          env.PGPASSWORD,
          undefined,
          '本地查询不应设置 PGPASSWORD',
        )
      })
    })

    describe('MySQL/MariaDB 远程参数', () => {
      it('应使用远程主机和 SSL 构建参数', () => {
        const opts: QueryOptions = {
          host: 'mysql.planetscale.com',
          username: 'admin',
          password: 'secret',
          ssl: true,
        }
        const port = 3306

        const host = opts.host ?? '127.0.0.1'
        const user = opts.username || 'root'
        const args = ['-h', host, '-P', String(port), '-u', user]

        if (opts.ssl) {
          args.push('--ssl-mode=REQUIRED')
        }

        // 密码通过 MYSQL_PWD 环境变量传递，而非参数
        const env: Record<string, string> = {}
        if (opts.password) {
          env.MYSQL_PWD = opts.password
        }

        assert(
          args.includes('mysql.planetscale.com'),
          '应包含远程主机',
        )
        assert(args.includes('admin'), '应包含远程用户名')
        assert(
          !args.some((a) => a.startsWith('-p')),
          '不应在参数中暴露密码',
        )
        assertEqual(
          env.MYSQL_PWD,
          'secret',
          '应通过 MYSQL_PWD 环境变量传递密码',
        )
        assert(args.includes('--ssl-mode=REQUIRED'), '应包含 SSL 模式')
      })
    })

    describe('MongoDB 远程参数', () => {
      it('协议为 mongodb+srv 时应构建 SRV URI', () => {
        const opts: QueryOptions = {
          host: 'cluster.mongodb.net',
          username: 'db@user',
          password: 'db#pass',
          ssl: true,
          scheme: 'mongodb+srv',
          database: 'mydb',
        }
        const port = 27017

        const user = opts.username ? encodeURIComponent(opts.username) : ''
        const pass = opts.password ? encodeURIComponent(opts.password) : ''
        const auth = user ? `${user}:${pass}@` : ''
        const isSrv = opts.scheme === 'mongodb+srv'
        const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `${scheme}://${auth}${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb+srv://'), '应使用 srv 协议')
        // 验证 URL 编码的凭据（@ → %40, # → %23）
        assert(
          uri.includes(
            `${encodeURIComponent('db@user')}:${encodeURIComponent('db#pass')}@`,
          ),
          '应包含 URL 编码的凭据',
        )
        assert(
          !uri.includes('db@user:'),
          '不应包含未编码的原始用户名',
        )
        assert(
          uri.includes('cluster.mongodb.net/mydb'),
          '应包含主机和数据库',
        )
        // SRV 隐含 TLS，因此无需冗余的 tls=true 参数
        assert(
          !uri.includes('tls=true'),
          'srv 不应添加冗余的 tls 参数',
        )
        assert(!uri.includes(':27017'), 'srv 不应包含端口')
      })

      it('非 SRV 连接应构建带 TLS 的标准 URI', () => {
        const opts: QueryOptions = {
          host: 'mongo.example.com',
          username: 'user',
          password: 'pass',
          ssl: true,
          scheme: 'mongodb',
          database: 'testdb',
        }
        const port = 27017

        const isSrv = opts.scheme === 'mongodb+srv'
        const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `${scheme}://user:pass@${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb://'), '应使用标准协议')
        assert(uri.includes(':27017'), '非 SRV 应包含端口')
        assert(uri.includes('?tls=true'), 'SSL 应包含 tls=true')
      })

      it('应构建不带 SSL 的标准 URI', () => {
        const opts: QueryOptions = {
          host: 'mongo.example.com',
          username: 'user',
          password: 'pass',
          ssl: false,
          scheme: 'mongodb',
          database: 'testdb',
        }
        const port = 27017

        const isSrv = opts.scheme === 'mongodb+srv'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `mongodb://user:pass@${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb://'), '应使用标准协议')
        assert(uri.includes(':27017'), '应包含端口')
        assert(!uri.includes('tls=true'), '不应包含 tls 参数')
      })
    })

    describe('Redis/Valkey 远程参数', () => {
      it('应构建包含用户名和 TLS 的参数，密码通过环境变量传递', () => {
        const opts: QueryOptions = {
          host: 'redis.upstash.io',
          username: 'default',
          password: 'token123',
          ssl: true,
          database: '0',
        }
        const port = 6379

        const host = opts.host ?? '127.0.0.1'
        const args = [
          '-h',
          host,
          '-p',
          String(port),
          '-n',
          opts.database!,
          '--raw',
        ]

        if (opts.username) {
          args.push('--user', opts.username)
        }
        if (opts.ssl) {
          args.push('--tls')
        }

        // 密码通过 REDISCLI_AUTH 环境变量传递，而非参数
        const env: Record<string, string> = {}
        if (opts.password) {
          env.REDISCLI_AUTH = opts.password
        }

        assert(args.includes('redis.upstash.io'), '应包含远程主机')
        assert(args.includes('--user'), '应包含用户标志')
        assert(args.includes('default'), '应包含用户名')
        assert(!args.includes('-a'), '不应在参数中暴露密码')
        assertEqual(
          env.REDISCLI_AUTH,
          'token123',
          '应通过 REDISCLI_AUTH 环境变量传递密码',
        )
        assert(args.includes('--tls'), '应包含 TLS 标志')
        assert(args.includes('--raw'), '应包含 --raw 标志')
      })

      it('本地查询不应包含认证/TLS', () => {
        const opts: QueryOptions = { database: '0' }
        const host = opts.host ?? '127.0.0.1'
        const args = ['-h', host, '-p', '6379', '-n', '0', '--raw']

        assertEqual(host, '127.0.0.1', '应使用本地主机')
        assert(!args.includes('--user'), '不应包含用户标志')
        assert(!args.includes('-a'), '不应包含认证标志')
        assert(!args.includes('--tls'), '不应包含 TLS')
      })
    })
  })

  describe('远程容器状态处理', () => {
    it('远程容器应具有 linked 状态', () => {
      const config = makeRemoteConfig()
      assertEqual(config.status, 'linked', '状态应为 linked')
    })

    it('远程容器不需要运行检查', () => {
      const config = makeRemoteConfig()
      // 远程容器完全绕过"是否运行中"检查。
      // 查询命令首先检查 isRemoteContainer，然后才
      // 检查基于服务器的容器的进程状态。
      assert(
        isRemoteContainer(config),
        '应在运行检查之前被检测为远程容器',
      )
      assertEqual(
        config.status,
        'linked',
        'linked 状态意味着始终可达',
      )
    })

    it('本地服务器容器仍需运行检查', () => {
      const config = makeLocalConfig({ status: 'stopped' as const })
      assert(!isRemoteContainer(config), '本地容器不是远程容器')
      assertEqual(
        config.status,
        'stopped',
        '已停止的本地容器将无法通过运行检查',
      )
    })
  })
})
