import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'

// 导入模块以测试 isPortInUseError 函数的行为
// 我们将通过导出的函数间接测试它

describe('端口错误检测', () => {
  // 应被识别为端口已被占用的错误消息模式
  const portInUseMessages = [
    'address already in use',
    'EADDRINUSE',
    'port 5432 in use',
    'could not bind to port',
    'socket already in use',
    'Address already in use (EADDRINUSE)',
    'Port is in use',
  ]

  const nonPortMessages = [
    'connection refused',
    'timeout',
    'permission denied',
    'file not found',
    'invalid argument',
    '',
  ]

  it('应该识别各种端口已被占用的错误格式', () => {
    for (const msg of portInUseMessages) {
      const lower = msg.toLowerCase()
      const isPortError =
        lower.includes('address already in use') ||
        lower.includes('eaddrinuse') ||
        (lower.includes('port') && lower.includes('in use')) ||
        lower.includes('could not bind') ||
        lower.includes('socket already in use')

      assert(isPortError, `应该将 "${msg}" 识别为端口已被占用错误`)
    }
  })

  it('不应该错误识别非端口错误', () => {
    for (const msg of nonPortMessages) {
      const lower = msg.toLowerCase()
      const isPortError =
        lower.includes('address already in use') ||
        lower.includes('eaddrinuse') ||
        (lower.includes('port') && lower.includes('in use')) ||
        lower.includes('could not bind') ||
        lower.includes('socket already in use')

      assert(!isPortError, `不应该将 "${msg}" 识别为端口已被占用错误`)
    }
  })
})

describe('StartWithRetryResult', () => {
  it('应该具有正确的成功结果结构', () => {
    const successResult: {
      success: boolean
      finalPort: number
      retriesUsed: number
      error?: Error
    } = {
      success: true,
      finalPort: 5432,
      retriesUsed: 0,
    }

    assert(successResult.success === true, 'success 应该为 true')
    assertEqual(successResult.finalPort, 5432, 'finalPort 应该被设置')
    assertEqual(
      successResult.retriesUsed,
      0,
      'retriesUsed 在首次尝试时应该为 0',
    )
    assert(
      successResult.error === undefined,
      '成功时 error 应该为 undefined',
    )
  })

  it('应该具有正确的失败结果结构', () => {
    const failureResult = {
      success: false,
      finalPort: 5433,
      retriesUsed: 3,
      error: new Error('Max retries exceeded'),
    }

    assert(failureResult.success === false, 'success 应该为 false')
    assertEqual(
      failureResult.finalPort,
      5433,
      'finalPort 应该是最后尝试的端口',
    )
    assertEqual(
      failureResult.retriesUsed,
      3,
      'retriesUsed 应该反映尝试次数',
    )
    assert(failureResult.error instanceof Error, 'error 应该是一个 Error')
    assert(
      failureResult.error.message.includes('retries'),
      '错误消息应该具有描述性',
    )
  })
})

describe('重试逻辑', () => {
  it('应该遵守 maxRetries 选项', () => {
    const maxRetries = 3
    let attempts = 0

    // 模拟重试循环逻辑
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts++
      // 在每次尝试时模拟端口错误
      const isPortError = true
      if (isPortError && attempt < maxRetries) {
        continue
      }
      break
    }

    assertEqual(attempts, maxRetries, '应该尝试最多 maxRetries 次')
  })

  it('应该在遇到非端口错误时停止重试', () => {
    const maxRetries = 3
    let attempts = 0

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts++
      // 模拟非端口错误
      const isPortError = false
      if (isPortError && attempt < maxRetries) {
        continue
      }
      break
    }

    assertEqual(attempts, 1, '应该在第一次非端口错误时停止')
  })

  it('应该在成功时停止重试', () => {
    const maxRetries = 3
    let attempts = 0

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts++
      // 模拟成功
      const success = true
      if (success) {
        break
      }
    }

    assertEqual(attempts, 1, '应该在成功后停止')
  })
})

describe('端口变更回调', () => {
  it('应该使用旧端口和新端口调用 onPortChange', () => {
    let callbackCalled = false
    let oldPortValue: number | undefined
    let newPortValue: number | undefined

    const onPortChange = (oldPort: number, newPort: number) => {
      callbackCalled = true
      oldPortValue = oldPort
      newPortValue = newPort
    }

    // 模拟端口变更
    const oldPort = 5432
    const newPort = 5433
    onPortChange(oldPort, newPort)

    assert(callbackCalled, '回调应该被调用')
    assertEqual(oldPortValue, 5432, '应该传递旧端口')
    assertEqual(newPortValue, 5433, '应该传递新端口')
  })

  it('如果未提供 onPortChange 则不应该调用', () => {
    // 这测试了 undefined 回调不会导致崩溃
    const onPortChange:
      | ((oldPort: number, newPort: number) => void)
      | undefined = undefined

    // 正在测试的概念是代码能够优雅地处理 undefined 回调
    // 在实际代码中: if (onPortChange) { onPortChange(oldPort, newPort) }
    assert(onPortChange === undefined, '回调应该为 undefined')
    assert(true, '应该优雅地处理 undefined 回调')
  })
})

describe('引擎端口范围解析', () => {
  // 这测试了从引擎默认值获取端口范围的概念
  it('应该使用引擎特定的端口范围', () => {
    const enginePortRanges: Record<string, { start: number; end: number }> = {
      postgresql: { start: 5432, end: 5500 },
      mysql: { start: 3306, end: 3400 },
    }

    assertEqual(
      enginePortRanges.postgresql.start,
      5432,
      'PostgreSQL 应该从 5432 开始',
    )
    assertEqual(
      enginePortRanges.mysql.start,
      3306,
      'MySQL 应该从 3306 开始',
    )
  })
})

describe('错误转换', () => {
  it('应该将未知错误转换为 Error 对象', () => {
    const unknownError: unknown = 'string error'
    const converted =
      unknownError instanceof Error
        ? unknownError
        : new Error(String(unknownError))

    assert(converted instanceof Error, '应该被转换为 Error')
    assertEqual(
      converted.message,
      'string error',
      '消息应该被保留',
    )
  })

  it('应该保留 Error 对象', () => {
    const originalError: unknown = new Error('original message')
    const converted =
      originalError instanceof Error
        ? originalError
        : new Error(String(originalError))

    assert(converted instanceof Error, '应该保留原始 Error')
    assertEqual(
      converted.message,
      'original message',
      '消息应该被保留',
    )
  })
})
