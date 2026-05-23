/**
 * CouchDB 恢复模块单元测试
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/couchdb/restore'

describe('CouchDB Restore Module', () => {
  const testDir = join(tmpdir(), 'couchdb-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误 (例如，如果已清理则忽略 ENOENT)
    }
  })

  describe('detectBackupFormat', () => {
    it('应通过扩展名检测 .json 文件', async () => {
      await mkdir(testDir, { recursive: true })
      const jsonPath = join(testDir, 'backup.json')
      await writeFile(jsonPath, JSON.stringify({ version: '1', databases: [] }))

      const format = await detectBackupFormat(jsonPath)
      assertEqual(format.format, 'json', '应检测为 json')
      assert(
        format.description.includes('JSON'),
        '描述应提及 JSON',
      )

      await rm(jsonPath, { force: true })
    })

    it('应通过扩展名检测 .couchdb 文件', async () => {
      await mkdir(testDir, { recursive: true })
      const couchdbPath = join(testDir, 'backup.couchdb')
      await writeFile(
        couchdbPath,
        JSON.stringify({ version: '1', databases: [] }),
      )

      const format = await detectBackupFormat(couchdbPath)
      assertEqual(format.format, 'json', '应检测为 json')

      await rm(couchdbPath, { force: true })
    })

    it('应通过结构检测 JSON 内容', async () => {
      await mkdir(testDir, { recursive: true })
      const backupPath = join(testDir, 'backup.bak')
      await writeFile(
        backupPath,
        JSON.stringify({ version: '1', databases: [] }),
      )

      const format = await detectBackupFormat(backupPath)
      assertEqual(format.format, 'json', '应通过内容检测 JSON')

      await rm(backupPath, { force: true })
    })

    it('对非 JSON 文件应返回 unknown', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a JSON backup')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('对目录应返回 unknown', async () => {
      await mkdir(testDir, { recursive: true })
      const dirPath = join(testDir, 'backup-dir')
      await mkdir(dirPath, { recursive: true })

      const format = await detectBackupFormat(dirPath)
      assertEqual(
        format.format,
        'unknown',
        '应将目录检测为 unknown',
      )
      assert(
        format.description.includes('Directory'),
        '描述应提及目录',
      )

      await rm(dirPath, { recursive: true, force: true })
    })

    it('对不存在的文件应抛出', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.json')
        assert(false, '应已抛出')
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
      const result = parseConnectionString('http://127.0.0.1:5984')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 5984, '端口应为 5984')
      assertEqual(result.protocol, 'http', '协议应为 http')
    })

    it('应解析 https 连接字符串', () => {
      const result = parseConnectionString('https://couchdb.example.com:6984')
      assertEqual(result.host, 'couchdb.example.com', '主机应为正确值')
      assertEqual(result.port, 6984, '端口应为 6984')
      assertEqual(result.protocol, 'https', '协议应保留 https')
    })

    it('应解析带数据库的连接字符串', () => {
      const result = parseConnectionString('http://127.0.0.1:5984/mydb')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 5984, '端口应为 5984')
      assertEqual(result.database, 'mydb', '数据库应为 mydb')
    })

    it('未指定时应使用 CouchDB 默认端口', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        5984,
        '默认端口应为 5984 (CouchDB 默认)',
      )
    })

    it('对无效连接字符串应抛出', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应已抛出')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('对不支持的协议应抛出', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:5984')
        assert(false, '应已抛出')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应提及不支持的协议',
        )
      }
    })

    it('对空连接字符串应抛出', () => {
      try {
        parseConnectionString('')
        assert(false, '应已抛出')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })
})
