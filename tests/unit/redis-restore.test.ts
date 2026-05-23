import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/redis/restore'
import { assert, assertEqual } from '../utils/assertions'

// 测试固件
const RDB_MAGIC = Buffer.from([0x52, 0x45, 0x44, 0x49, 0x53]) // "REDIS"

let testDir: string

describe('Redis Restore', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-redis-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已清理则返回 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('should detect valid RDB file by magic bytes', async () => {
      const filePath = join(testDir, 'valid.rdb')
      const content = Buffer.concat([RDB_MAGIC, Buffer.from('0009test-data')])
      await writeFile(filePath, content)

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', '格式应该是 rdb')
      assert(
        format.description.includes('RDB snapshot'),
        '描述应该提及 RDB snapshot',
      )
    })

    it('should detect RDB file by extension as fallback', async () => {
      const filePath = join(testDir, 'extension.rdb')
      await writeFile(filePath, 'not-real-rdb-content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', '格式应该是 rdb')
      assert(
        format.description.includes('extension'),
        '描述应该提及通过扩展名检测',
      )
    })

    it('should return unknown for non-RDB files', async () => {
      const filePath = join(testDir, 'invalid.txt')
      await writeFile(filePath, 'just some text content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'unknown', '格式应该是 unknown')
    })

    it('should throw for non-existent file', async () => {
      let threw = false
      try {
        await detectBackupFormat('/nonexistent/path/file.rdb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('not found'),
          '错误应该提及文件未找到',
        )
      }
      assert(threw, '不存在的文件应该抛出异常')
    })
  })

  describe('parseConnectionString', () => {
    it('should parse simple Redis URL', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', '主机应该是 127.0.0.1')
      assertEqual(result.port, 6379, '端口应该是 6379')
      assertEqual(result.database, '0', '数据库应该是 0')
      assertEqual(result.password, undefined, '密码应该是 undefined')
    })

    it('should parse Redis URL with password', () => {
      const result = parseConnectionString(
        'redis://:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', '主机应该是 127.0.0.1')
      assertEqual(result.port, 6379, '端口应该是 6379')
      assertEqual(result.database, '0', '数据库应该是 0')
      assertEqual(
        result.password,
        'mypassword',
        '密码应该是 mypassword',
      )
    })

    it('should parse Redis URL with username and password', () => {
      const result = parseConnectionString(
        'redis://user:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', '主机应该是 127.0.0.1')
      assertEqual(
        result.password,
        'mypassword',
        '密码应该是 mypassword',
      )
    })

    it('should parse Redis URL with different database', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/5')
      assertEqual(result.database, '5', '数据库应该是 5')
    })

    it('should use default port when not specified', () => {
      const result = parseConnectionString('redis://127.0.0.1/0')
      assertEqual(result.port, 6379, '端口应该默认为 6379')
    })

    it('should use default database when not specified', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379')
      assertEqual(result.database, '0', '数据库应该默认为 0')
    })

    it('should use default host when not specified', () => {
      const result = parseConnectionString('redis:///0')
      assertEqual(result.host, '127.0.0.1', '主机应该默认为 127.0.0.1')
    })

    it('should handle rediss:// protocol (TLS)', () => {
      const result = parseConnectionString('rediss://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', '主机应该是 127.0.0.1')
      assertEqual(result.port, 6379, '端口应该是 6379')
    })

    it('should throw for invalid database number', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/16')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          '错误应该提及有效范围 0-15',
        )
      }
      assert(threw, '数据库大于 15 应该抛出异常')
    })

    it('should throw for negative database number', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/-1')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          '错误应该提及有效范围 0-15',
        )
      }
      assert(threw, '负数数据库应该抛出异常')
    })

    it('should throw for non-redis protocol', () => {
      let threw = false
      try {
        parseConnectionString('postgresql://127.0.0.1:5432/mydb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应该提及不支持的协议',
        )
      }
      assert(threw, '非 Redis 协议应该抛出异常')
    })

    it('should throw for invalid URL', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('Invalid Redis connection string'),
          '错误应该提及无效的连接字符串',
        )
      }
      assert(threw, '无效 URL 应该抛出异常')
    })

    it('should throw for empty string', () => {
      let threw = false
      try {
        parseConnectionString('')
      } catch {
        threw = true
      }
      assert(threw, '空字符串应该抛出异常')
    })

    it('should mask credentials in error messages', () => {
      let errorMessage = ''
      try {
        // 使用无效格式，会导致解析失败
        parseConnectionString('redis://user:secretpass@:invalid')
      } catch (error) {
        errorMessage = (error as Error).message
      }
      assert(
        !errorMessage.includes('secretpass'),
        '错误信息不应该包含明文密码',
      )
    })
  })
})
