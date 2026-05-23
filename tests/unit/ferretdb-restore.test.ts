/**
 * FerretDB 备份格式检测的单元测试
 */

import { describe, it, before, after } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBackupFormat } from '../../engines/ferretdb/restore'

describe('FerretDB Backup Format Detection', () => {
  const testDir = join(tmpdir(), 'ferretdb-test-' + Date.now())

  before(async () => {
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('detectBackupFormat', () => {
    it('应通过扩展名检测 SQL 格式', async () => {
      const sqlFile = join(testDir, 'backup.sql')
      await writeFile(sqlFile, '-- PostgreSQL dump\nCREATE TABLE...')

      const format = await detectBackupFormat(sqlFile)
      assert(
        format.format === 'sql',
        `期望 sql 格式，实际为 ${format.format}`,
      )
    })

    it('应通过扩展名检测 custom 格式', async () => {
      const dumpFile = join(testDir, 'backup.dump')
      // 写入 PGDMP 头（PostgreSQL custom 格式的魔数）
      const header = Buffer.from('PGDMP')
      await writeFile(dumpFile, header)

      const format = await detectBackupFormat(dumpFile)
      assertEqual(format.format, 'custom', '应检测到 custom 格式')
    })

    it('应通过内容检测 SQL 格式', async () => {
      const sqlFile = join(testDir, 'test-backup')
      await writeFile(sqlFile, '-- PostgreSQL database dump\n...')

      const format = await detectBackupFormat(sqlFile)
      assertEqual(format.format, 'sql', '应检测到 SQL 格式')
    })

    it('文件不存在时应抛出错误', async () => {
      try {
        await detectBackupFormat(join(testDir, 'nonexistent.sql'))
        assert(false, '应该抛出错误')
      } catch (error) {
        const err = error as Error & { code?: string }
        assert(
          err.code === 'ENOENT' ||
            err.message.includes('no such file') ||
            err.message.includes('ENOENT') ||
            err.message.includes('not found'),
          `期望文件未找到错误，实际为：${err.message}`,
        )
      }
    })

    it('应包含恢复命令提示', async () => {
      const sqlFile = join(testDir, 'hint-backup.sql')
      await writeFile(sqlFile, '-- SQL backup')

      const format = await detectBackupFormat(sqlFile)
      assert(
        format.restoreCommand !== undefined,
        '应包含恢复命令',
      )
      assert(
        format.restoreCommand.includes('psql') ||
          format.restoreCommand.includes('pg_restore'),
        '恢复命令应提及 psql 或 pg_restore',
      )
    })

    it('应检测目录格式', async () => {
      const dirPath = join(testDir, 'backup-dir')
      await mkdir(dirPath, { recursive: true })

      const format = await detectBackupFormat(dirPath)
      assertEqual(format.format, 'directory', '应检测到目录格式')
    })

    it('无法识别的文件应返回 unknown 格式', async () => {
      const unknownFile = join(testDir, 'backup.xyz')
      // 写入不匹配任何已知格式的随机二进制内容
      const randomContent = Buffer.from([
        0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd,
      ])
      await writeFile(unknownFile, randomContent)

      const format = await detectBackupFormat(unknownFile)
      assertEqual(
        format.format,
        'unknown',
        '无法识别的格式应返回 unknown',
      )
      assert(
        format.description.toLowerCase().includes('unknown'),
        `描述应提及 unknown：${format.description}`,
      )
      assert(
        format.restoreCommand.includes('mongorestore'),
        '未知格式应回退到 mongorestore',
      )
    })
  })
})
