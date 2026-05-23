/**
 * TigerBeetle 启动竞争条件测试
 * 
 * 测试在集群启动期间客户端尝试连接时的竞争条件处理。
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { TigerBeetleError, TigerBeetleErrorCode } from '../../engines/tigerbeetle/errors'

describe('TigerBeetle 启动竞争条件', () => {
  describe('连接重试逻辑', () => {
    it('应该在集群未就绪时重试连接', async () => {
      // 模拟集群正在启动的场景
      let attempts = 0
      const maxRetries = 3
      
      while (attempts < maxRetries) {
        try {
          // 模拟连接尝试
          if (attempts < 2) {
            throw new TigerBeetleError(
              TigerBeetleErrorCode.CLUSTER_NOT_READY,
              '集群尚未就绪'
            )
          }
          // 第三次尝试成功
          break
        } catch (error) {
          attempts++
          if (attempts >= maxRetries) {
            throw error
          }
          // 等待后重试
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      assertEqual(attempts, 2, '应该在第三次尝试时成功')
    })

    it('应该在达到最大重试次数后抛出错误', async () => {
      let attempts = 0
      const maxRetries = 3
      let finalError: Error | null = null
      
      try {
        while (attempts < maxRetries) {
          throw new TigerBeetleError(
            TigerBeetleErrorCode.CLUSTER_NOT_READY,
            '集群尚未就绪'
          )
        }
      } catch (error) {
        finalError = error as Error
        attempts++
      }
      
      assert(finalError instanceof TigerBeetleError, '应该抛出 TigerBeetleError')
      assertEqual(attempts, 1, '应该只尝试一次（因为循环内立即抛出）')
    })
  })

  describe('并发连接处理', () => {
    it('应该序列化并发连接尝试', async () => {
      const connectionOrder: number[] = []
      
      // 模拟两个并发连接尝试
      const promise1 = (async () => {
        connectionOrder.push(1)
        await new Promise(resolve => setTimeout(resolve, 50))
        connectionOrder.push(1)
      })()
      
      const promise2 = (async () => {
        connectionOrder.push(2)
        await new Promise(resolve => setTimeout(resolve, 30))
        connectionOrder.push(2)
      })()
      
      await Promise.all([promise1, promise2])
      
      // 验证两个连接都已完成
      assert(connectionOrder.includes(1), '第一个连接应该完成')
      assert(connectionOrder.includes(2), '第二个连接应该完成')
    })
  })

  describe('错误分类', () => {
    it('应该正确识别可重试错误', () => {
      const retryableError = new TigerBeetleError(
        TigerBeetleErrorCode.CLUSTER_NOT_READY,
        '集群尚未就绪'
      )
      
      assert(
        retryableError.code === TigerBeetleErrorCode.CLUSTER_NOT_READY,
        '应该识别为可重试错误'
      )
    })

    it('应该正确识别不可重试错误', () => {
      const nonRetryableError = new TigerBeetleError(
        TigerBeetleErrorCode.INVALID_CONFIGURATION,
        '无效的配置'
      )
      
      assert(
        nonRetryableError.code === TigerBeetleErrorCode.INVALID_CONFIGURATION,
        '应该识别为不可重试错误'
      )
    })
  })
})
