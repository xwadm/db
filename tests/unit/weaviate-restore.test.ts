/**
 * Weaviate 恢复模块单元测试
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/weaviate/restore'

describe('Weaviate Restore Module', () => {
  const testDir = join(tmpdir(), 'weaviate-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已被清理则忽略 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('应该通过扩展名检测 .snapshot 文件', async () => {
      await mkdir(testDir, { recursive: true })
      const snapshotPath = join(testDir, 'test.snapshot')
      // 写入一些类似 gzip 的内容（仅用于测试）
      await writeFile(snapshotPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))

      const format = await detectBackupFormat(snapshotPath)
      assertEqual(format.format, 'snapshot', '应该检测为 snapshot')
      assert(
        format.description.includes('snapshot'),
        '描述应该提及 snapshot',
      )

      await rm(snapshotPath, { force: true })
    })

    it('应该通过魔数检测 gzip 内容', async () => {
      await mkdir(testDir, { recursive: true })
      const gzipPath = join(testDir, 'backup.gz')
      // 写入 gzip 魔数
      await writeFile(gzipPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))

      const format = await detectBackupFormat(gzipPath)
      assertEqual(format.format, 'snapshot', '应该将 gzip 检测为 snapshot')

      await rm(gzipPath, { force: true })
    })

    it('应该检测 .json 备份元数据', async () => {
      await mkdir(testDir, { recursive: true })
      const jsonPath = join(testDir, 'backup_config.json')
      await writeFile(jsonPath, '{"id": "test-backup", "status": "SUCCESS"}')

      const format = await detectBackupFormat(jsonPath)
      assertEqual(format.format, 'snapshot', '应该将 JSON 检测为 snapshot')

      await rm(jsonPath, { force: true })
    })

    it('应该对非 snapshot 文件返回 unknown', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a snapshot')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应该检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('应该对不存在的文件抛出错误', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.snapshot')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
        assert(
          (error as Error).message.includes('not found'),
          '错误应该提及文件未找到',
        )
      }
    })
  })

  describe('parseConnectionString', () => {
    it('应该解析 http 连接字符串', () => {
      const result = parseConnectionString('http://127.0.0.1:8080')
      assertEqual(result.host, '127.0.0.1', 'Host 应该是 127.0.0.1')
      assertEqual(result.port, 8080, 'Port 应该是 8080')
      assertEqual(result.protocol, 'http', 'Protocol 应该是 http')
    })

    it('应该解析 https 连接字符串', () => {
      const result = parseConnectionString('https://weaviate.example.com:8080')
      assertEqual(result.host, 'weaviate.example.com', 'Host 应该是正确的')
      assertEqual(result.port, 8080, 'Port 应该是 8080')
      assertEqual(result.protocol, 'https', 'Protocol 应该保留 https')
    })

    it('应该对 http 使用默认端口', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(result.port, 8080, '默认 HTTP 端口应该是 8080')
    })

    it('应该对无效的连接字符串抛出错误', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
      }
    })

    it('应该对不支持的协议抛出错误', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:8080')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应该提及不支持的协议',
        )
      }
    })

    it('应该对空连接字符串抛出错误', () => {
      try {
        parseConnectionString('')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
      }
    })
  })
})
