import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/valkey/restore'
import { assert, assertEqual } from '../utils/assertions'

// 测试夹具 - Valkey 使用与 Redis 相同的 RDB 格式
const RDB_MAGIC = Buffer.from([0x52, 0x45, 0x44, 0x49, 0x53]) // "REDIS"

let testDir: string

describe('Valkey 恢复', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-valkey-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已清理则为 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('应通过魔数检测有效的 RDB 文件', async () => {
      const filePath = join(testDir, 'valid.rdb')
      const content = Buffer.concat([RDB_MAGIC, Buffer.from('0009test-data')])
      await writeFile(filePath, content)

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', '格式应为 rdb')
      assert(format.description.includes('RDB 快照'), '描述应提及 RDB 快照')
    })

    it('应通过扩展名回退检测 RDB 文件', async () => {
      const filePath = join(testDir, 'extension.rdb')
      await writeFile(filePath, 'not-real-rdb-content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', '格式应为 rdb')
      assert(format.description.includes('扩展名'), '描述应提及通过扩展名检测')
    })

    it('对非 RDB 文件应返回 unknown', async () => {
      const filePath = join(testDir, 'invalid.txt')
      await writeFile(filePath, 'just some text content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'unknown', '格式应为 unknown')
    })

    it('对不存在的文件应抛出异常', async () => {
      let threw = false
      try {
        await detectBackupFormat('/nonexistent/path/file.rdb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('未找到'),
          '错误应提及文件未找到',
        )
      }
      assert(threw, '应对不存在的文件抛出异常')
    })
  })

  describe('parseConnectionString', () => {
    it('应解析简单的 Valkey URL（redis:// 协议）', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 6379, '端口应为 6379')
      assertEqual(result.database, '0', '数据库应为 0')
      assertEqual(result.password, undefined, '密码应为 undefined')
    })

    it('应解析带密码的 URL', () => {
      const result = parseConnectionString(
        'redis://:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 6379, '端口应为 6379')
      assertEqual(result.database, '0', '数据库应为 0')
      assertEqual(result.password, 'mypassword', '密码应为 mypassword')
    })

    it('应解析带用户名和密码的 URL', () => {
      const result = parseConnectionString(
        'redis://user:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.password, 'mypassword', '密码应为 mypassword')
    })

    it('应解析指定不同数据库的 URL', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/5')
      assertEqual(result.database, '5', '数据库应为 5')
    })

    it('未指定端口时应使用默认端口', () => {
      const result = parseConnectionString('redis://127.0.0.1/0')
      assertEqual(result.port, 6379, '端口应默认为 6379')
    })

    it('未指定数据库时应使用默认数据库', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379')
      assertEqual(result.database, '0', '数据库应默认为 0')
    })

    it('未指定主机时应使用默认主机', () => {
      const result = parseConnectionString('redis:///0')
      assertEqual(result.host, '127.0.0.1', '主机应默认为 127.0.0.1')
    })

    it('应处理 rediss:// 协议（TLS）', () => {
      const result = parseConnectionString('rediss://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 6379, '端口应为 6379')
    })

    it('无效的数据库编号应抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/16')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          '错误应提及有效范围 0-15',
        )
      }
      assert(threw, '数据库 > 15 时应抛出异常')
    })

    it('负数数据库编号应抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/-1')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          '错误应提及有效范围 0-15',
        )
      }
      assert(threw, '负数数据库应抛出异常')
    })

    it('非 redis 协议应抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('postgresql://127.0.0.1:5432/mydb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('不支持的协议'),
          '错误应提及不支持的协议',
        )
      }
      assert(threw, '非 redis 协议应抛出异常')
    })

    it('无效的 URL 应抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('无效'),
          '错误应提及无效的连接字符串',
        )
      }
      assert(threw, '无效的 URL 应抛出异常')
    })

    it('空字符串应抛出异常', () => {
      let threw = false
      try {
        parseConnectionString('')
      } catch {
        threw = true
      }
      assert(threw, '空字符串应抛出异常')
    })

    it('错误消息中应脱敏凭证', () => {
      let errorMessage = ''
      try {
        // 使用将导致解析失败的无效格式
        parseConnectionString('redis://user:secretpass@:invalid')
      } catch (error) {
        errorMessage = (error as Error).message
      }
      assert(!errorMessage.includes('secretpass'), '错误不应包含明文密码')
    })
  })
})
