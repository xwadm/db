/**
 * Meilisearch 恢复模块单元测试
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/meilisearch/restore'

describe('Meilisearch 恢复模块', () => {
  const testDir = join(tmpdir(), 'meilisearch-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如已清理时的 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    it('应通过扩展名检测 .snapshot 文件', async () => {
      await mkdir(testDir, { recursive: true })
      const snapshotPath = join(testDir, 'test.snapshot')
      // 写入类似 gzip 的内容（仅用于测试）
      await writeFile(snapshotPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))

      const format = await detectBackupFormat(snapshotPath)
      assertEqual(format.format, 'snapshot', '应检测为 snapshot')
      assert(
        format.description.includes('snapshot'),
        '描述应提及 snapshot',
      )

      await rm(snapshotPath, { force: true })
    })

    it('应通过 magic bytes 检测 gzip 内容', async () => {
      await mkdir(testDir, { recursive: true })
      const gzipPath = join(testDir, 'backup.gz')
      // 写入 gzip magic bytes
      await writeFile(gzipPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))

      const format = await detectBackupFormat(gzipPath)
      assertEqual(format.format, 'snapshot', '应将 gzip 检测为 snapshot')

      await rm(gzipPath, { force: true })
    })

    it('非 snapshot 文件应返回 unknown', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a snapshot')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('不存在的文件应抛出异常', async () => {
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
    it('应解析 http 连接字符串', () => {
      const result = parseConnectionString('http://127.0.0.1:7700')
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.port, 7700, 'Port 应为 7700')
      assertEqual(result.protocol, 'http', 'Protocol 应为 http')
    })

    it('应解析 https 连接字符串', () => {
      const result = parseConnectionString(
        'https://meilisearch.example.com:7700',
      )
      assertEqual(
        result.host,
        'meilisearch.example.com',
        'Host 应正确',
      )
      assertEqual(result.port, 7700, 'Port 应为 7700')
      assertEqual(result.protocol, 'https', 'Protocol 应保留 https')
    })

    it('应将 meilisearch:// 协议解析为 http', () => {
      const result = parseConnectionString('meilisearch://127.0.0.1:7700')
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.port, 7700, 'Port 应为 7700')
      assertEqual(result.protocol, 'http', 'meilisearch:// 应映射为 http')
    })

    it('http 无显式端口时应使用 Meilisearch 默认端口', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        7700,
        '默认端口应为 7700（Meilisearch 默认值，而非标准 HTTP 80）',
      )
    })

    it('https 无显式端口时应使用 Meilisearch 默认端口', () => {
      const result = parseConnectionString('https://127.0.0.1')
      assertEqual(
        result.port,
        7700,
        '默认端口应为 7700（Meilisearch 默认值，而非标准 HTTPS 443）',
      )
    })

    it('无效连接字符串应抛出异常', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('不支持的协议应抛出异常', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:7700')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应提及不支持的协议',
        )
      }
    })

    it('空连接字符串应抛出异常', () => {
      try {
        parseConnectionString('')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })
})
