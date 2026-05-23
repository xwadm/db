/**
 * TypeDB 恢复模块单元测试
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/typedb/restore'

describe('TypeDB 恢复模块', () => {
  const testDir = join(tmpdir(), 'typedb-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略错误（例如，如果已清理则为 ENOENT）
    }
  })

  describe('detectBackupFormat', () => {
    before(async () => {
      await mkdir(testDir, { recursive: true })
    })

    it('应通过扩展名检测 .typeql 文件', async () => {
      const typeqlPath = join(testDir, 'backup.typeql')
      await writeFile(
        typeqlPath,
        'define\n\nperson sub entity, owns name;\nname sub attribute, value string;',
      )

      const format = await detectBackupFormat(typeqlPath)
      assertEqual(format.format, 'typeql', '应检测为 typeql')
      assert(
        format.description.includes('TypeQL') ||
          format.description.includes('TypeDB'),
        '描述应提及 TypeQL 或 TypeDB',
      )

      await rm(typeqlPath, { force: true })
    })

    it('应通过扩展名检测 .tql 文件', async () => {
      const tqlPath = join(testDir, 'backup.tql')
      await writeFile(
        tqlPath,
        'define\n\nperson sub entity, owns name;\nname sub attribute, value string;',
      )

      const format = await detectBackupFormat(tqlPath)
      assertEqual(format.format, 'typeql', '应将 .tql 检测为 typeql')

      await rm(tqlPath, { force: true })
    })

    it('应通过关键字检测 TypeQL 内容', async () => {
      const backupPath = join(testDir, 'backup.bak')
      await writeFile(
        backupPath,
        'DEFINE\nperson SUB entity, OWNS name;\nname SUB attribute, value string;',
      )

      const format = await detectBackupFormat(backupPath)
      assertEqual(format.format, 'typeql', '应通过内容检测为 TypeQL')

      await rm(backupPath, { force: true })
    })

    it('应对非 TypeQL 文件返回 unknown', async () => {
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a TypeQL backup')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', '应检测为 unknown')

      await rm(textPath, { force: true })
    })

    it('应对不存在的文件抛出异常', async () => {
      try {
        await detectBackupFormat(join(testDir, 'nonexistent.typeql'))
        assert(false, '应该已抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })

  describe('parseConnectionString', () => {
    it('应解析 typedb 连接字符串', () => {
      const result = parseConnectionString('typedb://127.0.0.1:1729/mydb')
      assertEqual(result.host, '127.0.0.1', '主机应为 127.0.0.1')
      assertEqual(result.port, 1729, '端口应为 1729')
      assertEqual(result.database, 'mydb', '数据库应为 mydb')
    })

    it('未指定端口时应使用默认端口', () => {
      const result = parseConnectionString('typedb://127.0.0.1/mydb')
      assertEqual(result.port, 1729, '默认端口应为 1729')
    })

    it('未指定数据库时应使用默认数据库', () => {
      const result = parseConnectionString('typedb://127.0.0.1:1729')
      assertEqual(result.database, 'default', '默认数据库应为 default')
    })

    it('未指定主机时应使用默认主机', () => {
      const result = parseConnectionString('typedb:///mydb')
      assertEqual(result.host, '127.0.0.1', '默认主机应为 127.0.0.1')
    })

    it('应对无效连接字符串抛出异常', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应该已抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('应对非 typedb 协议抛出异常', () => {
      try {
        parseConnectionString('postgresql://127.0.0.1:1729/mydb')
        assert(false, '应该已抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          '应提及不支持的协议',
        )
      }
    })

    it('应对空连接字符串抛出异常', () => {
      try {
        parseConnectionString('')
        assert(false, '应该已抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })
})
