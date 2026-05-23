/**
 * TypeDB 恢复模块单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/typedb/restore'

describe('TypeDB Restore Module', () => {
  describe('detectBackupFormat', () => {
    it('应该通过扩展名检测 .snapshot 文件', async () => {
      const format = await detectBackupFormat('/path/to/backup.snapshot')
      assertEqual(format.format, 'snapshot', '应该检测为 snapshot')
      assert(
        format.description.includes('TypeDB'),
        '描述应该提及 TypeDB',
      )
    })

    it('应该对非 snapshot 文件返回 unknown', async () => {
      const format = await detectBackupFormat('/path/to/backup.txt')
      assertEqual(format.format, 'unknown', '应该检测为 unknown')
    })
  })

  describe('parseConnectionString', () => {
    it('应该解析有效的连接字符串', () => {
      const result = parseConnectionString('127.0.0.1:1729')
      assertEqual(result.host, '127.0.0.1', 'Host 应该是 127.0.0.1')
      assertEqual(result.port, 1729, 'Port 应该是 1729')
    })

    it('应该使用默认端口', () => {
      const result = parseConnectionString('127.0.0.1')
      assertEqual(result.host, '127.0.0.1', 'Host 应该是 127.0.0.1')
      assertEqual(result.port, 1729, '默认端口应该是 1729')
    })

    it('应该对无效的连接字符串抛出错误', () => {
      try {
        parseConnectionString('')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
      }
    })
  })
})
