/**
 * 共享的测试断言工具
 * 供单元测试和集成测试共同使用
 */

// 断言辅助函数，失败时抛出带描述信息的错误
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`断言失败：${message}`)
  }
}

// 断言两个值相等
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  期望值：${expected}\n  实际值：${actual}`)
  }
}

// 断言两个值不相等
export function assertNotEqual<T>(
  actual: T,
  notExpected: T,
  message: string,
): void {
  if (actual === notExpected) {
    throw new Error(
      `${message}\n  不应等于：${notExpected}\n  实际值：${actual}`,
    )
  }
}

// 断言一个值为真值
export function assertTruthy<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (!value) {
    throw new Error(`${message}\n  期望真值，得到：${value}`)
  }
}

// 断言一个值为 null 或 undefined
export function assertNullish(
  value: unknown,
  message: string,
): asserts value is null | undefined {
  if (value != null) {
    throw new Error(`${message}\n  期望 null/undefined，得到：${value}`)
  }
}

// 断言两个值深度相等（适用于数组和对象）
export function assertDeepEqual<T>(
  actual: T,
  expected: T,
  message: string,
): void {
  const actualStr = JSON.stringify(actual, null, 2)
  const expectedStr = JSON.stringify(expected, null, 2)
  if (actualStr !== expectedStr) {
    throw new Error(
      `${message}\n  期望值：${expectedStr}\n  实际值：${actualStr}`,
    )
  }
}
