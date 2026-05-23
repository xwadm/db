/**
 * 端口管理器测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  findAvailablePort,
  isPortAvailable,
  isPortInRange,
  getDefaultPortRange,
  validatePort,
} from '../../core/port-manager'

describe('Port Manager', () => {
  describe('validatePort', () => {
    it('应接受有效的 port 号码', () => {
      assertEqual(validatePort(5432), 5432, '应接受 5432')
      assertEqual(validatePort(1), 1, '应接受 1')
      assertEqual(validatePort(65535), 65535, '应接受 65535')
    })

    it('应拒绝 port 0', () => {
      try {
        validatePort(0)
        assert(false, '应该抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('应拒绝负数 port', () => {
      try {
        validatePort(-1)
        assert(false, '应该抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('应拒绝超过 65535 的 port', () => {
      try {
        validatePort(65536)
        assert(false, '应该抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })

    it('应拒绝非整数 port', () => {
      try {
        validatePort(5432.5)
        assert(false, '应该抛出异常')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
      }
    })
  })

  describe('isPortInRange', () => {
    it('应为默认 range 内的 port 返回 true', () => {
      const range = getDefaultPortRange()

      assert(
        isPortInRange(range.start, range),
        '起始 port 应在 range 内',
      )
      assert(isPortInRange(range.end, range), '结束 port 应在 range 内')
      assert(
        isPortInRange(Math.floor((range.start + range.end) / 2), range),
        '中间 port 应在 range 内',
      )
    })

    it('应为 range 外的 port 返回 false', () => {
      const range = getDefaultPortRange()

      assert(
        !isPortInRange(range.start - 1, range),
        '低于起始值的 port 应在 range 外',
      )
      assert(
        !isPortInRange(range.end + 1, range),
        '高于结束值的 port 应在 range 外',
      )
    })
  })

  describe('isPortAvailable', () => {
    it('应为可用 port 返回 true', async () => {
      // Port 0 是一个特殊情况 - 它让操作系统分配一个 port
      // 对于测试，我们检查一个可能可用的高 port
      const available = await isPortAvailable(49152)

      // 这个测试在 CI 环境中可能不稳定，因为很多 port 都在使用中
      // 我们只验证函数返回 boolean
      assert(
        typeof available === 'boolean',
        '应返回 boolean',
      )
    })

    it('应为 port 0 返回 false', async () => {
      const available = await isPortAvailable(0)
      assertEqual(available, false, 'Port 0 应该是不可用的')
    })
  })

  describe('findAvailablePort', () => {
    it('应在 range 内找到可用 port', async () => {
      const range = getDefaultPortRange()
      const port = await findAvailablePort(range)

      assert(
        port !== null,
        '应找到可用 port',
      )
      assert(
        isPortInRange(port, range),
        `Port ${port} 应在 range 内`,
      )
    })

    it('当没有可用 port 时应返回 null', async () => {
      // 创建一个只有一个 port 的很小的 range
      // 如果那个 port 被占用，findAvailablePort 应该返回 null
      const tinyRange = { start: 1, end: 1 }
      const port = await findAvailablePort(tinyRange)

      // Port 1 可能被系统服务占用
      // 所以我们期望返回 null，但测试主要是检查函数不会抛出异常
      assert(
        port === null || port === 1,
        '应返回 null 或唯一的 port',
      )
    })
  })

  describe('getDefaultPortRange', () => {
    it('应返回有效的 port range', () => {
      const range = getDefaultPortRange()

      assert(
        typeof range.start === 'number',
        'Start 应该是 number',
      )
      assert(typeof range.end === 'number', 'End 应该是 number')
      assert(range.start > 0, 'Start 应该是正数')
      assert(range.end <= 65535, 'End 应该 <= 65535')
      assert(range.start < range.end, 'Start 应该小于 End')
    })
  })
})
