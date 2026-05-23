import { describe, it } from 'node:test'
import {
  SpinDBError,
  ErrorCodes,
  createPortInUseError,
  createContainerNotFoundError,
  createVersionMismatchError,
  createDependencyMissingError,
  isValidDatabaseName,
  assertValidDatabaseName,
} from '../../core/error-handler'
import { assert, assertEqual } from '../utils/assertions'

describe('SpinDBError', () => {
  it('应该创建包含所有属性的错误', () => {
    const error = new SpinDBError(
      ErrorCodes.PORT_IN_USE,
      'Port 5432 is in use',
      'error',
      'Use a different port',
      { port: 5432 },
    )

    assertEqual(error.code, ErrorCodes.PORT_IN_USE, '错误码应匹配')
    assertEqual(error.message, 'Port 5432 is in use', '消息应匹配')
    assertEqual(error.severity, 'error', '严重级别应匹配')
    assertEqual(
      error.suggestion,
      'Use a different port',
      '建议应匹配',
    )
    assertEqual(error.context?.port, 5432, '上下文应包含 port')
    assert(error instanceof Error, '应为 Error 的实例')
    assert(error.name === 'SpinDBError', '名称应为 SpinDBError')
  })

  it('应创建带有默认严重级别的错误', () => {
    const error = new SpinDBError(
      ErrorCodes.UNKNOWN_ERROR,
      'Something went wrong',
    )

    assertEqual(error.severity, 'error', '默认严重级别应为 error')
    assert(error.suggestion === undefined, '建议应为 undefined')
    assert(error.context === undefined, '上下文应为 undefined')
  })

  it('应通过 SpinDBError.from() 从未知错误创建错误', () => {
    const originalError = new Error('Original error message')
    const spindbError = SpinDBError.from(
      originalError,
      ErrorCodes.UNKNOWN_ERROR,
    )

    assertEqual(spindbError.code, ErrorCodes.UNKNOWN_ERROR, '错误码应匹配')
    assertEqual(
      spindbError.message,
      'Original error message',
      '消息应来自原始错误',
    )
    assert(
      spindbError.context?.originalError !== undefined,
      '应包含原始堆栈',
    )
  })

  it('如果已经是 SpinDBError 则应返回同一错误', () => {
    const original = new SpinDBError(ErrorCodes.PORT_IN_USE, 'Port in use')
    const result = SpinDBError.from(original)

    assert(result === original, '应返回同一实例')
  })

  it('应将字符串转换为 SpinDBError', () => {
    const error = SpinDBError.from('String error message')

    assertEqual(
      error.message,
      'String error message',
      '消息应与字符串匹配',
    )
    assertEqual(
      error.code,
      ErrorCodes.UNKNOWN_ERROR,
      '应使用 UNKNOWN_ERROR 错误码',
    )
  })
})

describe('错误创建辅助函数', () => {
  describe('createPortInUseError', () => {
    it('应创建带有正确属性的 port-in-use 错误', () => {
      const error = createPortInUseError(5432)

      assertEqual(
        error.code,
        ErrorCodes.PORT_IN_USE,
        '错误码应为 PORT_IN_USE',
      )
      assert(error.message.includes('5432'), '消息应包含端口号')
      assert(error.suggestion !== undefined, '应有建议')
      assert(
        error.suggestion!.includes('5432'),
        '建议应提及端口号',
      )
      assertEqual(error.context?.port, 5432, '上下文应包含 port')
    })
  })

  describe('createContainerNotFoundError', () => {
    it('应创建带有正确属性的 container-not-found 错误', () => {
      const error = createContainerNotFoundError('mydb')

      assertEqual(
        error.code,
        ErrorCodes.CONTAINER_NOT_FOUND,
        '错误码应为 CONTAINER_NOT_FOUND',
      )
      assert(
        error.message.includes('mydb'),
        '消息应包含 container 名称',
      )
      assert(
        error.suggestion!.includes('spindb list'),
        '建议应提及 list 命令',
      )
      assertEqual(
        error.context?.containerName,
        'mydb',
        '上下文应包含 container 名称',
      )
    })
  })

  describe('createVersionMismatchError', () => {
    it('应创建带有正确属性的 version-mismatch 错误', () => {
      const error = createVersionMismatchError('17', '15')

      assertEqual(
        error.code,
        ErrorCodes.VERSION_MISMATCH,
        '错误码应为 VERSION_MISMATCH',
      )
      assert(
        error.message.includes('17'),
        '消息应包含 dump 版本',
      )
      assert(
        error.message.includes('15'),
        '消息应包含 tool 版本',
      )
      assertEqual(error.severity, 'fatal', '严重级别应为 fatal')
      assert(
        error.suggestion!.includes('brew install'),
        '建议应包含 install 命令',
      )
      assertEqual(
        error.context?.dumpVersion,
        '17',
        '上下文应包含 dump 版本',
      )
      assertEqual(
        error.context?.toolVersion,
        '15',
        '上下文应包含 tool 版本',
      )
    })
  })

  describe('createDependencyMissingError', () => {
    it('应为 psql 创建 dependency-missing 错误', () => {
      const error = createDependencyMissingError('psql', 'postgresql')

      assertEqual(
        error.code,
        ErrorCodes.DEPENDENCY_MISSING,
        '错误码应为 DEPENDENCY_MISSING',
      )
      assert(error.message.includes('psql'), '消息应包含工具名称')
      assert(
        error.suggestion!.includes('libpq'),
        '建议应提及 libpq（针对 psql）',
      )
      assertEqual(
        error.context?.toolName,
        'psql',
        '上下文应包含工具名称',
      )
      assertEqual(
        error.context?.engine,
        'postgresql',
        '上下文应包含 engine',
      )
    })

    it('应为 mysql 创建 dependency-missing 错误', () => {
      const error = createDependencyMissingError('mysql', 'mysql')

      assert(
        error.suggestion!.includes('mysql-client'),
        '建议应提及 mysql-client',
      )
    })

    it('应为未知工具创建通用建议', () => {
      const error = createDependencyMissingError('unknown-tool', 'postgresql')

      assert(
        error.suggestion!.includes('postgresql client tools'),
        '应有通用建议',
      )
    })
  })
})

describe('ErrorCodes', () => {
  it('所有错误码的值应唯一', () => {
    const values = Object.values(ErrorCodes)
    const uniqueValues = new Set(values)

    assertEqual(
      values.length,
      uniqueValues.size,
      '所有错误码应唯一',
    )
  })

  it('应包含所有预期的分类', () => {
    // Port 错误
    assert('PORT_IN_USE' in ErrorCodes, '应有 PORT_IN_USE')
    assert(
      'PORT_PERMISSION_DENIED' in ErrorCodes,
      '应有 PORT_PERMISSION_DENIED',
    )
    assert(
      'PORT_RANGE_EXHAUSTED' in ErrorCodes,
      '应有 PORT_RANGE_EXHAUSTED',
    )

    // Process 错误
    assert(
      'PROCESS_START_FAILED' in ErrorCodes,
      '应有 PROCESS_START_FAILED',
    )
    assert(
      'PROCESS_STOP_TIMEOUT' in ErrorCodes,
      '应有 PROCESS_STOP_TIMEOUT',
    )
    assert('PID_FILE_CORRUPT' in ErrorCodes, '应有 PID_FILE_CORRUPT')
    assert('PID_FILE_STALE' in ErrorCodes, '应有 PID_FILE_STALE')

    // Restore 错误
    assert('VERSION_MISMATCH' in ErrorCodes, '应有 VERSION_MISMATCH')
    assert(
      'RESTORE_PARTIAL_FAILURE' in ErrorCodes,
      '应有 RESTORE_PARTIAL_FAILURE',
    )

    // Container 错误
    assert(
      'CONTAINER_NOT_FOUND' in ErrorCodes,
      '应有 CONTAINER_NOT_FOUND',
    )
    assert(
      'CONTAINER_ALREADY_EXISTS' in ErrorCodes,
      '应有 CONTAINER_ALREADY_EXISTS',
    )

    // Dependency 错误
    assert('DEPENDENCY_MISSING' in ErrorCodes, '应有 DEPENDENCY_MISSING')

    // Rollback 错误
    assert('ROLLBACK_FAILED' in ErrorCodes, '应有 ROLLBACK_FAILED')

    // 数据库名称验证错误
    assert(
      'INVALID_DATABASE_NAME' in ErrorCodes,
      '应有 INVALID_DATABASE_NAME',
    )
  })
})

describe('数据库名称验证', () => {
  describe('isValidDatabaseName', () => {
    describe('有效名称', () => {
      it('应接受简单的字母名称', () => {
        assert(isValidDatabaseName('mydb'), 'mydb 应为有效')
        assert(isValidDatabaseName('test'), 'test 应为有效')
        assert(isValidDatabaseName('Users'), 'Users 应为有效')
      })

      it('应接受首字符后包含数字的名称', () => {
        assert(isValidDatabaseName('db1'), 'db1 应为有效')
        assert(isValidDatabaseName('test123'), 'test123 应为有效')
        assert(isValidDatabaseName('v2'), 'v2 应为有效')
      })

      it('应接受包含下划线的名称', () => {
        assert(isValidDatabaseName('my_db'), 'my_db 应为有效')
        assert(isValidDatabaseName('test_db_1'), 'test_db_1 应为有效')
      })

      it('应接受包含混合允许字符的名称', () => {
        assert(
          isValidDatabaseName('my_test_db123'),
          'my_test_db123 应为有效',
        )
        assert(isValidDatabaseName('A1_b_2'), 'A1_b_2 应为有效')
      })
    })

    describe('无效名称（SQL injection 防护）', () => {
      it('应拒绝以数字开头的名称', () => {
        assert(
          !isValidDatabaseName('1db'),
          '以数字开头的名称应为无效',
        )
        assert(!isValidDatabaseName('123'), '123 应为无效')
      })

      it('应拒绝以特殊字符开头的名称', () => {
        assert(
          !isValidDatabaseName('-db'),
          '以连字符开头的名称应为无效',
        )
        assert(
          !isValidDatabaseName('_db'),
          '以下划线开头的名称应为无效',
        )
      })

      it('应拒绝包含空格的名称', () => {
        assert(
          !isValidDatabaseName('my db'),
          '包含空格的名称应为无效',
        )
        assert(
          !isValidDatabaseName('test database'),
          'test database 应为无效',
        )
      })

      it('应拒绝包含 SQL injection 字符的名称', () => {
        assert(
          !isValidDatabaseName("db'; DROP TABLE users;--"),
          'SQL injection 应为无效',
        )
        assert(
          !isValidDatabaseName('db"'),
          '包含双引号的名称应为无效',
        )
        assert(
          !isValidDatabaseName('db`'),
          '包含反引号的名称应为无效',
        )
        assert(
          !isValidDatabaseName("db'"),
          '包含单引号的名称应为无效',
        )
      })

      it('应拒绝包含连字符的名称（SQL 中需要引号包裹）', () => {
        assert(
          !isValidDatabaseName('my-db'),
          '包含连字符的名称应为无效',
        )
        assert(!isValidDatabaseName('test-db-1'), 'test-db-1 应为无效')
      })

      it('应拒绝包含特殊字符的名称', () => {
        assert(!isValidDatabaseName('my@db'), '包含 @ 的名称应为无效')
        assert(
          !isValidDatabaseName('test.db'),
          '包含句号的名称应为无效',
        )
        assert(!isValidDatabaseName('db!'), '包含 ! 的名称应为无效')
        assert(!isValidDatabaseName('db$var'), '包含 $ 的名称应为无效')
        assert(!isValidDatabaseName('db;'), '包含 ; 的名称应为无效')
      })

      it('应拒绝空名称', () => {
        assert(!isValidDatabaseName(''), '空名称应为无效')
      })
    })
  })

  describe('assertValidDatabaseName', () => {
    it('对有效名称不应抛出异常', () => {
      // 不应抛出异常
      assertValidDatabaseName('mydb')
      assertValidDatabaseName('test_db')
      assertValidDatabaseName('my_database_123')
    })

    it('对无效名称应抛出 SpinDBError', () => {
      let threw = false
      try {
        assertValidDatabaseName("db'; DROP TABLE users;--")
      } catch (error) {
        threw = true
        assert(error instanceof SpinDBError, '应抛出 SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_DATABASE_NAME,
          '错误码应为 INVALID_DATABASE_NAME',
        )
        assert(
          (error as SpinDBError).message.includes("db'; DROP TABLE users;--"),
          '错误消息应包含无效名称',
        )
        assert(
          (error as SpinDBError).suggestion !== undefined,
          '错误应包含建议',
        )
      }
      assert(threw, '应已抛出错误')
    })

    it('对空名称应抛出异常', () => {
      let threw = false
      try {
        assertValidDatabaseName('')
      } catch (error) {
        threw = true
        assert(error instanceof SpinDBError, '应抛出 SpinDBError')
      }
      assert(threw, '对空名称应已抛出错误')
    })

    it('对以数字开头的名称应抛出异常', () => {
      let threw = false
      try {
        assertValidDatabaseName('123db')
      } catch (error) {
        threw = true
        assert(error instanceof SpinDBError, '应抛出 SpinDBError')
      }
      assert(threw, '对以数字开头的名称应已抛出错误')
    })
  })
})
