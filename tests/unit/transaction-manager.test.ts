/**
 * 事务管理器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { TransactionManager, TransactionState } from '../../core/transaction-manager'
import { SpinDBError, ErrorCodes } from '../../core/error-handler'

describe('事务管理器', () => {
  describe('事务状态跟踪', () => {
    it('应该正确跟踪事务状态转换', () => {
      const manager = new TransactionManager()
      const txId = manager.beginTransaction()
      
      assertEqual(manager.getState(txId), TransactionState.ACTIVE, '事务应该是 ACTIVE 状态')
      
      manager.commit(txId)
      assertEqual(manager.getState(txId), TransactionState.COMMITTED, '事务应该是 COMMITTED 状态')
    })

    it('应该正确跟踪回滚状态', () => {
      const manager = new TransactionManager()
      const txId = manager.beginTransaction()
      
      manager.rollback(txId)
      assertEqual(manager.getState(txId), TransactionState.ABORTED, '事务应该是 ABORTED 状态')
    })
  })

  describe('事务隔离', () => {
    it('应该为每个事务维护独立的上下文', () => {
      const manager = new TransactionManager()
      const txId1 = manager.beginTransaction()
      const txId2 = manager.beginTransaction()
      
      manager.setContext(txId1, 'key', 'value1')
      manager.setContext(txId2, 'key', 'value2')
      
      assertEqual(manager.getContext(txId1, 'key'), 'value1', '事务1应该有独立的上下文')
      assertEqual(manager.getContext(txId2, 'key'), 'value2', '事务2应该有独立的上下文')
    })
  })

  describe('死锁检测', () => {
    it('应该检测简单的死锁', () => {
      const manager = new TransactionManager()
      const txId1 = manager.beginTransaction()
      const txId2 = manager.beginTransaction()
      
      // 事务1锁定资源A，尝试锁定资源B
      manager.acquireLock(txId1, 'resourceA')
      manager.acquireLock(txId1, 'resourceB')
      
      // 事务2锁定资源B，尝试锁定资源A（形成死锁）
      manager.acquireLock(txId2, 'resourceB')
      
      try {
        manager.acquireLock(txId2, 'resourceA')
        assert(false, '应该检测到死锁')
      } catch (error) {
        assert(error instanceof SpinDBError, '应该抛出 SpinDBError')
        assertEqual((error as SpinDBError).code, ErrorCodes.DEADLOCK_DETECTED, '应该是死锁错误')
      }
    })
  })

  describe('事务超时', () => {
    it('应该支持事务超时', async () => {
      const manager = new TransactionManager({ timeout: 100 })
      const txId = manager.beginTransaction()
      
      // 等待超时
      await new Promise(resolve => setTimeout(resolve, 150))
      
      assertEqual(manager.getState(txId), TransactionState.ABORTED, '超时的事务应该被中止')
    })
  })

  describe('嵌套事务', () => {
    it('应该支持保存点', () => {
      const manager = new TransactionManager()
      const txId = manager.beginTransaction()
      
      manager.setContext(txId, 'data', 'initial')
      const savepoint = manager.createSavepoint(txId)
      
      manager.setContext(txId, 'data', 'modified')
      assertEqual(manager.getContext(txId, 'data'), 'modified', '数据应该被修改')
      
      manager.rollbackToSavepoint(txId, savepoint)
      assertEqual(manager.getContext(txId, 'data'), 'initial', '数据应该回滚到保存点')
    })
  })
})
