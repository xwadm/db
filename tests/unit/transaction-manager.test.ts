import { describe, it } from 'node:test'
import {
  TransactionManager,
  withTransaction,
} from '../../core/transaction-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('事务管理器', () => {
  describe('添加回滚操作', () => {
    it('应将回滚操作添加到栈中', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: '操作 1',
        execute: async () => {},
      })
      tx.addRollback({
        description: '操作 2',
        execute: async () => {},
      })

      assertEqual(tx.getPendingCount(), 2, '应有 2 个待处理操作')
    })

    it('提交后添加回滚操作应抛出异常', () => {
      const tx = new TransactionManager()
      tx.commit()

      let threw = false
      try {
        tx.addRollback({
          description: '应失败',
          execute: async () => {},
        })
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('after commit'),
          '错误消息应提及提交',
        )
      }

      assert(threw, '应抛出异常')
    })
  })

  describe('回滚', () => {
    it('应按相反顺序执行回滚操作', async () => {
      const tx = new TransactionManager()
      const executionOrder: number[] = []

      tx.addRollback({
        description: '第一个添加',
        execute: async () => {
          executionOrder.push(1)
        },
      })
      tx.addRollback({
        description: '第二个添加',
        execute: async () => {
          executionOrder.push(2)
        },
      })
      tx.addRollback({
        description: '第三个添加',
        execute: async () => {
          executionOrder.push(3)
        },
      })

      await tx.rollback()

      assertEqual(executionOrder.length, 3, '所有操作都应执行')
      assertEqual(executionOrder[0], 3, '第三个添加的操作应先执行（后进先出）')
      assertEqual(executionOrder[1], 2, '第二个添加的操作应第二个执行')
      assertEqual(executionOrder[2], 1, '第一个添加的操作应最后执行')
    })

    it('即使其中一个操作失败，也应继续回滚', async () => {
      const tx = new TransactionManager()
      const executionOrder: string[] = []

      tx.addRollback({
        description: '会成功',
        execute: async () => {
          executionOrder.push('成功1')
        },
      })
      tx.addRollback({
        description: '会失败',
        execute: async () => {
          executionOrder.push('失败')
          throw new Error('回滚失败')
        },
      })
      tx.addRollback({
        description: '也会成功',
        execute: async () => {
          executionOrder.push('成功2')
        },
      })

      // 不应抛出异常
      await tx.rollback()

      assertEqual(executionOrder.length, 3, '所有操作都应尝试执行')
      assert(executionOrder.includes('失败'), '失败的操作应已被尝试')
      assert(executionOrder.includes('成功1'), '成功的操作应执行')
      assert(executionOrder.includes('成功2'), '成功的操作应执行')
    })

    it('回滚后应清空栈', async () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: '操作',
        execute: async () => {},
      })

      await tx.rollback()

      assertEqual(tx.getPendingCount(), 0, '回滚后栈应为空')
    })

    it('栈为空时不应执行任何操作', async () => {
      const tx = new TransactionManager()

      // 不应抛出异常
      await tx.rollback()

      assertEqual(tx.getPendingCount(), 0, '栈应保持为空')
    })

    it('已提交后应跳过回滚', async () => {
      const tx = new TransactionManager()
      let executed = false

      tx.addRollback({
        description: '不应执行',
        execute: async () => {
          executed = true
        },
      })

      tx.commit()
      await tx.rollback()

      assert(!executed, '提交后不应执行回滚')
    })
  })

  describe('提交', () => {
    it('应清空回滚栈', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: '操作 1',
        execute: async () => {},
      })
      tx.addRollback({
        description: '操作 2',
        execute: async () => {},
      })

      tx.commit()

      assertEqual(tx.getPendingCount(), 0, '提交后栈应为空')
      assert(tx.isCommitted(), '应标记为已提交')
    })

    it('应为幂等操作', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: '操作',
        execute: async () => {},
      })

      tx.commit()
      tx.commit() // 不应抛出异常

      assert(tx.isCommitted(), '应保持已提交状态')
    })
  })

  describe('检查是否已提交', () => {
    it('提交前应返回 false', () => {
      const tx = new TransactionManager()

      assert(!tx.isCommitted(), '初始状态不应为已提交')

      tx.addRollback({
        description: '操作',
        execute: async () => {},
      })

      assert(!tx.isCommitted(), '添加回滚操作后不应为已提交')
    })

    it('提交后应返回 true', () => {
      const tx = new TransactionManager()
      tx.commit()

      assert(tx.isCommitted(), '调用 commit() 后应为已提交')
    })
  })

  describe('获取待处理操作数量', () => {
    it('应返回正确的数量', () => {
      const tx = new TransactionManager()

      assertEqual(tx.getPendingCount(), 0, '初始应为 0')

      tx.addRollback({
        description: '操作 1',
        execute: async () => {},
      })
      assertEqual(tx.getPendingCount(), 1, '添加一个后应为 1')

      tx.addRollback({
        description: '操作 2',
        execute: async () => {},
      })
      assertEqual(tx.getPendingCount(), 2, '添加两个后应为 2')
    })
  })
})

describe('事务包裹函数 withTransaction', () => {
  it('操作成功时应提交', async () => {
    let rollbackExecuted = false

    const result = await withTransaction(async (tx) => {
      tx.addRollback({
        description: '不应执行',
        execute: async () => {
          rollbackExecuted = true
        },
      })

      return 'success'
    })

    assertEqual(result, 'success', '应返回操作结果')
    assert(!rollbackExecuted, '成功时不应执行回滚')
  })

  it('操作失败时应回滚并重新抛出异常', async () => {
    let rollbackExecuted = false

    let threw = false
    try {
      await withTransaction(async (tx) => {
        tx.addRollback({
          description: '应执行',
          execute: async () => {
            rollbackExecuted = true
          },
        })

        throw new Error('操作失败')
      })
    } catch (error) {
      threw = true
      assertEqual((error as Error).message, '操作失败', '应重新抛出原始错误')
    }

    assert(threw, '应抛出异常')
    assert(rollbackExecuted, '应已执行回滚')
  })

  it('操作失败时应按相反顺序执行回滚', async () => {
    const executionOrder: number[] = []

    try {
      await withTransaction(async (tx) => {
        tx.addRollback({
          description: '第一个',
          execute: async () => {
            executionOrder.push(1)
          },
        })
        tx.addRollback({
          description: '第二个',
          execute: async () => {
            executionOrder.push(2)
          },
        })
        tx.addRollback({
          description: '第三个',
          execute: async () => {
            executionOrder.push(3)
          },
        })

        throw new Error('失败')
      })
    } catch {
      // 预期异常
    }

    assertEqual(executionOrder[0], 3, '应按相反顺序执行')
    assertEqual(executionOrder[1], 2, '应按相反顺序执行')
    assertEqual(executionOrder[2], 1, '应按相反顺序执行')
  })
})
