/**
 * InfluxDB 恢复模块单元测试
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  encodeFieldValue,
  parseConnectionString,
} from '../../engines/influxdb/restore'

describe('InfluxDB Restore Module', () => {
  const testDir = join(tmpdir(), 'influxdb-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已经清理则忽略 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    before(async () => {
      await mkdir(testDir, { recursive: true })
    })

    it('应通过扩展名检测 .sql 文件', async () => {
      const sqlPath = join(testDir, 'test.sql')
      await writeFile(
        sqlPath,
        '-- InfluxDB SQL Backup\nINSERT INTO "cpu" VALUES (1);',
      )

      const format = await detectBackupFormat(sqlPath)
      assertEqual(format.format, 'sql', '应检测为 sql')
      assert(
        format.description.includes('SQL'),
        '描述应提及 SQL',
      )

      await rm(sqlPath, { force: true })
    })

    it('应通过魔术内容检测 SQL 内容', async () => {
      const contentPath = join(testDir, 'backup.dat')
      await writeFile(
        contentPath,
        '-- InfluxDB SQL Backup\nINSERT INTO "cpu" VALUES (1);',
      )

      const format = await detectBackupFormat(contentPath)
      assertEqual(format.format, 'sql', '应通过内容检测 SQL')

      await rm(contentPath, { force: true })
    })

    it('应检测通用 SQL 内容并附带警告描述', async () => {
      const genericPath = join(testDir, 'generic.dat')
      await writeFile(
        genericPath,
        'INSERT INTO "cpu" ("time", "value") VALUES (\'2024-01-01\', 42);',
      )

      const format = await detectBackupFormat(genericPath)
      assertEqual(format.format, 'sql', '应检测为 sql')
      assert(
        format.description.includes('generic markers'),
        '描述应提及通用标记',
      )

      await rm(genericPath, { force: true })
    })

    it('应返回 unknown 用于非 SQL 文件', async () => {
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a SQL dump')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('应抛出异常用于不存在的文件', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.sql')
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

  describe('encodeFieldValue', () => {
    it('应编码普通整数并附加尾随 "i"', () => {
      assertEqual(encodeFieldValue('123'), '123i', '"123" 应为整数')
      assertEqual(encodeFieldValue('0'), '0i', '"0" 应为整数')
      assertEqual(encodeFieldValue('-42'), '-42i', '"-42" 应为整数')
    })

    it('应将带小数点的值编码为 float（无 "i"）', () => {
      assertEqual(encodeFieldValue('123.0'), '123', '"123.0" 应为 float')
      assertEqual(encodeFieldValue('3.14'), '3.14', '"3.14" 应为 float')
      assertEqual(encodeFieldValue('-0.5'), '-0.5', '"-0.5" 应为 float')
    })

    it('应将指数表示法的值编码为 float（无 "i"）', () => {
      assertEqual(encodeFieldValue('1e3'), '1000', '"1e3" 应为 float')
      assertEqual(encodeFieldValue('1E3'), '1000', '"1E3" 应为 float')
      assertEqual(encodeFieldValue('2.5e2'), '250', '"2.5e2" 应为 float')
    })

    it('应无引号编码 boolean', () => {
      assertEqual(encodeFieldValue('true'), 'true', 'true 应无引号')
      assertEqual(
        encodeFieldValue('false'),
        'false',
        'false 应无引号',
      )
    })

    it('应使用双引号并转义编码字符串', () => {
      assertEqual(
        encodeFieldValue('hello'),
        '"hello"',
        '字符串应加引号',
      )
      assertEqual(
        encodeFieldValue('say "hi"'),
        '"say \\"hi\\""',
        '嵌入式引号应转义',
      )
      assertEqual(
        encodeFieldValue('back\\slash'),
        '"back\\\\slash"',
        '反斜杠应转义',
      )
    })

    it('应将空字符串编码为带引号的空字符串', () => {
      assertEqual(
        encodeFieldValue(''),
        '""',
        '空字符串应加引号为空',
      )
    })
  })

  describe('parseConnectionString', () => {
    it('应解析 http 连接字符串', () => {
      const result = parseConnectionString('http://127.0.0.1:8086')
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.port, 8086, 'Port 应为 8086')
      assertEqual(result.protocol, 'http', 'Protocol 应为 http')
    })

    it('应解析 https 连接字符串', () => {
      const result = parseConnectionString('https://influxdb.example.com:8086')
      assertEqual(result.host, 'influxdb.example.com', 'Host 应正确')
      assertEqual(result.port, 8086, 'Port 应为 8086')
      assertEqual(result.protocol, 'https', 'Protocol 应保留 https')
    })

    it('应将 influxdb:// 方案解析为 http', () => {
      const result = parseConnectionString('influxdb://127.0.0.1:8086')
      assertEqual(result.host, '127.0.0.1', 'Host 应为 127.0.0.1')
      assertEqual(result.port, 8086, 'Port 应为 8086')
      assertEqual(result.protocol, 'http', 'influxdb:// 应映射为 http')
    })

    it('应对无显式端口的 http 使用 InfluxDB 默认端口', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        8086,
        '默认端口应为 8086（InfluxDB 默认值，而非标准 HTTP 80）',
      )
    })

    it('应从查询参数解析数据库', () => {
      const result = parseConnectionString('http://127.0.0.1:8086?db=mydb')
      assertEqual(result.database, 'mydb', '应从查询中提取数据库')
    })

    it('应对无效连接字符串抛出异常', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('应对不支持的协议抛出异常', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:8086')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '错误应提及不支持的协议',
        )
      }
    })

    it('应对空连接字符串抛出异常', () => {
      try {
        parseConnectionString('')
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })
})
