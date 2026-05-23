/**
 * Qdrant restore 模块单元测试
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/qdrant/restore'

describe('Qdrant Restore Module', () => {
  const testDir = join(tmpdir(), 'qdrant-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已清理则 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('should detect .snapshot file by extension', async () => {
      await mkdir(testDir, { recursive: true })
      const snapshotPath = join(testDir, 'backup.snapshot')
      await writeFile(snapshotPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))

      const format = await detectBackupFormat(snapshotPath)
      assertEqual(format.format, 'snapshot', '应检测为 snapshot')
      assert(
        format.description.includes('snapshot'),
        '描述应提及 snapshot',
      )

      await rm(snapshotPath, { force: true })
    })

    it('should detect directory as snapshot format', async () => {
      const dirPath = join(testDir, 'backup-dir')
      await mkdir(dirPath, { recursive: true })

      const format = await detectBackupFormat(dirPath)
      assertEqual(format.format, 'snapshot', '应将目录检测为 snapshot')

      await rm(dirPath, { recursive: true, force: true })
    })

    it('should return unknown for non-snapshot files', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a snapshot')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.snapshot')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('not found'),
          '错误应提及文件未找到',
        )
      }
    })
  })

  describe('parseConnectionString', () => {
    it('should parse http connection string', () => {
      const result = parseConnectionString('http://127.0.0.1:6333')
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.port, 6333, 'Port 应为 6333')
      assertEqual(result.protocol, 'http', 'Protocol 应为 http')
    })

    it('should parse https connection string', () => {
      const result = parseConnectionString('https://qdrant.example.com:6333')
      assertEqual(result.host, 'qdrant.example.com', 'Host 应正确')
      assertEqual(result.port, 6333, 'Port 应为 6333')
      assertEqual(result.protocol, 'https', 'Protocol 应保留 https')
    })

    it('should use Qdrant default port when not specified', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        6333,
        '默认端口应为 6333（Qdrant 默认值，不是标准 HTTP 80）',
      )
    })

    it('should parse connection string with API key', () => {
      const result = parseConnectionString(
        'http://127.0.0.1:6333?api-key=secret123',
      )
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.apiKey, 'secret123', '应提取 API key')
    })

    it('should throw for invalid connection string', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('should throw for unsupported protocol', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:6333')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应提及不支持的协议',
        )
      }
    })

    it('should throw for empty connection string', () => {
      try {
        parseConnectionString('')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })
})
