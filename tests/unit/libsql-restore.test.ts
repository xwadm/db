/**
 * libSQL 恢复模块单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { detectBackupFormat } from '../../engines/libsql/restore'

describe('libSQL Restore Module', () => {
  describe('detectBackupFormat', () => {
    it('应将 .sql 文件检测为 sql 格式', () => {
      const format = detectBackupFormat('/path/to/backup.sql')
      assertEqual(format.format, 'sql', '应检测为 sql')
      assert(
        format.description.includes('SQL'),
        '描述应提及 SQL',
      )
    })

    it('应将 .db 文件检测为 binary 格式', () => {
      const format = detectBackupFormat('/path/to/backup.db')
      assertEqual(format.format, 'binary', '应检测为 binary')
      assert(
        format.description.includes('Binary'),
        '描述应提及 Binary',
      )
    })

    it('未知扩展名应默认为 binary', () => {
      const format = detectBackupFormat('/path/to/backup.bak')
      assertEqual(format.format, 'binary', '应默认为 binary')
      assert(
        format.description.includes('assumed'),
        '描述应提及 assumed',
      )
    })

    it('无扩展名的文件应默认为 binary', () => {
      const format = detectBackupFormat('/path/to/backup')
      assertEqual(format.format, 'binary', '应默认为 binary')
    })

    it('结果应包含恢复命令', () => {
      const format = detectBackupFormat('/path/to/backup.sql')
      assert(
        format.restoreCommand !== undefined,
        '应包含恢复命令',
      )
      assert(
        format.restoreCommand!.includes('spindb restore'),
        '恢复命令应包含 spindb restore',
      )
    })

    it('恢复命令应包含文件路径', () => {
      const filePath = '/path/to/backup.db'
      const format = detectBackupFormat(filePath)
      assert(
        format.restoreCommand!.includes(filePath),
        '恢复命令应包含文件路径',
      )
    })
  })
})
