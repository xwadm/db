/**
 * 事务管理器
 *
 * 为多步操作（如容器创建）提供回滚支持。
 * 如果任何步骤失败，所有先前完成的步骤将按逆序回滚。
 */

import { logError, logDebug, ErrorCodes } from './error-handler'

export type RollbackAction = {
  description: string
  execute: () => Promise<void>
}

/**
 * 管理事务操作的回滚操作栈。
 *
 * 用法:
 * ```ts
 * const tx = new TransactionManager()
 *
 * try {
 *   await createDirectory()
 *   tx.addRollback({
 *     description: '删除目录',
 *     execute: () => deleteDirectory()
 *   })
 *
 *   await initDatabase()
 *   // 目录回滚也涵盖此操作
 *
 *   await startServer()
 *   tx.addRollback({
 *     description: '停止服务器',
 *     execute: () => stopServer()
 *   })
 *
 *   tx.commit() // 成功 - 清除回滚栈
 * } catch (error) {
 *   await tx.rollback() // 错误 - 撤销所有操作
 *   throw error
 * }
 * ```
 */
export class TransactionManager {
  private rollbackStack: RollbackAction[] = []
  private committed = false

  /**
   * 将回滚操作添加到栈中。
   * 回滚时操作按逆序执行。
   */
  addRollback(action: RollbackAction): void {
    if (this.committed) {
      throw new Error('提交后无法添加回滚操作')
    }
    this.rollbackStack.push(action)
    logDebug(`已添加回滚操作: ${action.description}`, {
      totalActions: this.rollbackStack.length,
    })
  }

  /**
   * 按逆序执行所有回滚。
   * 即使个别回滚操作失败也会继续执行。
   */
  async rollback(): Promise<void> {
    if (this.committed) {
      logDebug('跳过回滚 - 事务已提交')
      return
    }

    if (this.rollbackStack.length === 0) {
      logDebug('没有需要执行的回滚操作')
      return
    }

    logDebug(`开始回滚 ${this.rollbackStack.length} 个操作`)

    // 按逆序执行（后进先出）
    while (this.rollbackStack.length > 0) {
      const action = this.rollbackStack.pop()!

      try {
        logDebug(`正在执行回滚: ${action.description}`)
        await action.execute()
        logDebug(`回滚成功: ${action.description}`)
      } catch (error) {
        // 记录错误但继续执行其他回滚
        logError({
          code: ErrorCodes.ROLLBACK_FAILED,
          message: `回滚失败: ${action.description}`,
          severity: 'warning',
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    logDebug('回滚完成')
  }

  /**
   * 将事务标记为已提交。
   * 清除回滚栈，因为不需要撤销任何操作。
   */
  commit(): void {
    if (this.committed) {
      return // 已提交
    }

    logDebug(`提交事务，包含 ${this.rollbackStack.length} 个操作`)
    this.rollbackStack = []
    this.committed = true
  }

  // 检查事务是否已提交。
  isCommitted(): boolean {
    return this.committed
  }

  // 获取待执行的回滚操作数量。
  getPendingCount(): number {
    return this.rollbackStack.length
  }
}

/**
 * 辅助函数：在失败时自动回滚的执行操作封装。
 *
 * 用法:
 * ```ts
 * await withTransaction(async (tx) => {
 *   await step1()
 *   tx.addRollback({ description: '撤销步骤1', execute: undoStep1 })
 *
 *   await step2()
 *   tx.addRollback({ description: '撤销步骤2', execute: undoStep2 })
 *
 *   // 如果执行到这里没有抛出异常，事务自动提交
 * })
 * ```
 */
export async function withTransaction<T>(
  operation: (tx: TransactionManager) => Promise<T>,
): Promise<T> {
  const tx = new TransactionManager()

  try {
    const result = await operation(tx)
    tx.commit()
    return result
  } catch (error) {
    await tx.rollback()
    throw error
  }
}
