import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/clickhouse/restore'
import { assert, assertEqual } from '../utils/assertions'

let testDir: string

describe('ClickHouse 恢复', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-clickhouse-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已清理则 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('应通过扩展名检测 SQL 文件', async () => {
      const filePath = join(testDir, 'backup.sql')
      await writeFile(filePath, 'CREATE TABLE test (id Int32);')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'sql', '格式应为 sql')
      assert(
        format.description.includes('SQL'),
        '描述应提及 SQL',
      )
    })

    it('即使没有 .sql 扩展名也应检测 SQL 内容', async () => {
      const filePath = join(testDir, 'backup.txt')
      await writeFile(
        filePath,
        'CREATE TABLE test (id Int32) ENGINE = MergeTree();',
      )

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'sql', '格式应为 sql')
    })

    it('对非 SQL 文件应返回 unknown', async () => {
      const filePath = join(testDir, 'invalid.bin')
      await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]))

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'unknown', '格式应为 unknown')
    })

    it('对不存在的文件应抛出', async () => {
      let threw = false
      try {
        await detectBackupFormat('/nonexistent/path/file.sql')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('not found'),
          '错误应提及文件未找到',
        )
      }
      assert(threw, '应对不存在的文件抛出')
    })
  })

  describe('parseConnectionString', () => {
    it('应解析简单的 ClickHouse URL', () => {
      const result = parseConnectionString(
        'clickhouse://127.0.0.1:9000/default',
      )
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 9000, '端口应为 9000')
      assertEqual(result.database, 'default', '数据库应为 default')
      assertEqual(result.user, undefined, '用户应为 undefined')
      assertEqual(result.password, undefined, '密码应为 undefined')
    })

    it('应解析带凭据的 ClickHouse URL', () => {
      const result = parseConnectionString(
        'clickhouse://admin:secretpass@127.0.0.1:9000/analytics',
      )
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 9000, '端口应为 9000')
      assertEqual(result.database, 'analytics', '数据库应为 analytics')
      assertEqual(result.user, 'admin', '用户应为 admin')
      assertEqual(
        result.password,
        'secretpass',
        '密码应为 secretpass',
      )
    })

    it('未指定 clickhouse:// 时应使用默认端口 (9000)', () => {
      const result = parseConnectionString('clickhouse://127.0.0.1/default')
      assertEqual(result.port, 9000, '端口应默认为 9000')
    })

    it('未指定 http:// 时应使用默认端口 (8123)', () => {
      const result = parseConnectionString('http://127.0.0.1/default')
      assertEqual(result.port, 8123, 'HTTP 端口应默认为 8123')
    })

    it('未指定 https:// 时应使用默认端口 (8123)', () => {
      const result = parseConnectionString(
        'https://clickhouse.example.com/default',
      )
      assertEqual(result.port, 8123, 'HTTPS 端口应默认为 8123')
    })

    it('未指定时应使用默认数据库', () => {
      const result = parseConnectionString('clickhouse://127.0.0.1:9000')
      assertEqual(
        result.database,
        'default',
        '数据库应默认为 "default"',
      )
    })

    it('未指定时应使用默认主机', () => {
      const result = parseConnectionString('clickhouse:///mydb')
      assertEqual(result.host, '127.0.0.1', '主机应默认为 127.0.0.1')
    })

    it('应处理 http:// 协议', () => {
      const result = parseConnectionString('http://127.0.0.1:8123/mydb')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 8123, '端口应为 8123')
      assertEqual(result.database, 'mydb', '数据库应为 mydb')
    })

    it('应处理 https:// 协议', () => {
      const result = parseConnectionString(
        'https://clickhouse.example.com:8443/mydb',
      )
      assertEqual(
        result.host,
        'clickhouse.example.com',
        '主机应为 clickhouse.example.com',
      )
      assertEqual(result.port, 8443, '端口应为 8443')
    })

    it('对不支持的协议应抛出', () => {
      let threw = false
      try {
        parseConnectionString('postgresql://127.0.0.1:5432/mydb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应提及不支持的协议',
        )
      }
      assert(threw, '应对不支持的协议抛出')
    })

    it('对无效 URL 应抛出', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes(
            'Invalid ClickHouse connection string',
          ),
          '错误应提及无效连接字符串',
        )
      }
      assert(threw, '应对无效 URL 抛出')
    })

    it('对空字符串应抛出', () => {
      let threw = false
      try {
        parseConnectionString('')
      } catch {
        threw = true
      }
      assert(threw, '应对空字符串抛出')
    })

    it('应在错误消息中屏蔽凭据', () => {
      let errorMessage = ''
      try {
        // 使用会导致解析失败的无效格式
        parseConnectionString('clickhouse://admin:secretpass@:invalid')
      } catch (error) {
        errorMessage = (error as Error).message
      }
      assert(
        !errorMessage.includes('secretpass'),
        '错误不应包含明文密码',
      )
    })
  })
})
