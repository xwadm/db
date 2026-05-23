/**
 * TigerBeetle 恢复模块单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/tigerbeetle/restore'

describe('TigerBeetle Restore Module', () => {
  describe('detectBackupFormat', () => {
    it('应该通过扩展名检测 .snapshot 文件', async () => {
      const format = await detectBackupFormat('/path/to/backup.snapshot')
      assertEqual(format.format, 'snapshot', '应该检测为 snapshot')
      assert(
        format.description.includes('TigerBeetle'),
        '描述应该提及 TigerBeetle',
      )
    })

    it('应该对非 snapshot 文件返回 unknown', async () => {
      const format = await detectBackupFormat('/path/to/backup.txt')
      assertEqual(format.format, 'unknown', '应该检测为 unknown')
    })
  })

  describe('parseConnectionString', () => {
    it('应该解析有效的连接字符串', () => {
      const result = parseConnectionString('3000:127.0.0.1:3001')
      assertEqual(result.clusterId, '3000', 'Cluster ID 应该是 3000')
      assertEqual(result.addresses.length, 1, '应该有一个地址')
      assertEqual(result.addresses[0], '127.0.0.1:3001', '地址应该是 127.0.0.1:3001')
    })

    it('应该解析多副本连接字符串', () => {
      const result = parseConnectionString('0:192.168.1.1:3000,192.168.1.2:3000')
      assertEqual(result.clusterId, '0', 'Cluster ID 应该是 0')
      assertEqual(result.addresses.length, 2, '应该有两个地址')
      assertEqual(result.addresses[0], '192.168.1.1:3000', '第一个地址应该是 192.168.1.1:3000')
      assertEqual(result.addresses[1], '192.168.1.2:3000', '第二个地址应该是 192.168.1.2:3000')
    })

    it('应该对无效的连接字符串抛出错误', () => {
      try {
        parseConnectionString('invalid')
        assert(false, '应该抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应该抛出 Error')
      }
    })
  })
})
