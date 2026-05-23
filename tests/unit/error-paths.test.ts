/**
 * 错误路径 / 负面测试
 *
 * 测试无效输入是否产生清晰、可操作的错误信息。
 * 涵盖 SQL injection 防护、验证边界和边缘情况。
 */

import { describe, it } from 'node:test'
import {
  isValidUsername,
  assertValidUsername,
  isValidDatabaseName,
  assertValidDatabaseName,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { assert, assertEqual } from '../utils/assertions'

describe('Error Paths', () => {
  // ============================================
  // 通过 username 验证防止 SQL injection
  // ============================================
  describe('SQL injection prevention (usernames)', () => {
    const SQL_INJECTION_USERNAMES = [
      "admin'; DROP TABLE users; --",
      'user" OR "1"="1',
      "'; DELETE FROM test_user; --",
      'admin/**/OR/**/1=1',
      "user' UNION SELECT * FROM pg_shadow --",
      'Robert); DROP TABLE Students;--',
      "admin' AND 1=1 --",
      '1; EXEC xp_cmdshell("cmd")',
    ]

    for (const username of SQL_INJECTION_USERNAMES) {
      it(`应拒绝 SQL injection 尝试: "${username.slice(0, 40)}..."`, () => {
        assert(
          !isValidUsername(username),
          `应拒绝 SQL injection: ${username}`,
        )
      })
    }

    it('应抛出带有 INVALID_USERNAME code 的 SpinDBError（针对 injection 尝试）', () => {
      try {
        assertValidUsername("admin'; DROP TABLE users; --")
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof SpinDBError, '应为 SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_USERNAME,
          '应包含 INVALID_USERNAME code',
        )
      }
    })
  })

  // ============================================
  // 通过 database name 验证防止 SQL injection
  // ============================================
  describe('SQL injection prevention (database names)', () => {
    const SQL_INJECTION_DB_NAMES = [
      "mydb'; DROP TABLE users; --",
      'db" OR "1"="1',
      '1; EXEC xp_cmdshell("cmd")',
      'db/**/UNION/**/SELECT',
    ]

    for (const dbName of SQL_INJECTION_DB_NAMES) {
      it(`应拒绝 database name 中的 SQL injection: "${dbName.slice(0, 40)}..."`, () => {
        assert(
          !isValidDatabaseName(dbName),
          `应拒绝 SQL injection: ${dbName}`,
        )
      })
    }

    it('应抛出带有 INVALID_DATABASE_NAME code 的 SpinDBError', () => {
      try {
        assertValidDatabaseName("db'; DROP TABLE users; --")
        assert(false, '应抛出异常')
      } catch (error) {
        assert(error instanceof SpinDBError, '应为 SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_DATABASE_NAME,
          '应包含 INVALID_DATABASE_NAME code',
        )
      }
    })
  })

  // ============================================
  // username 边缘情况
  // ============================================
  describe('username edge cases', () => {
    it('应拒绝空字符串', () => {
      assert(!isValidUsername(''), '空字符串应为无效')
    })

    it('应拒绝以数字开头的 username', () => {
      assert(!isValidUsername('1admin'), '前导数字应为无效')
      assert(!isValidUsername('0user'), '前导零应为无效')
      assert(!isValidUsername('99bottles'), '前导多位数字应为无效')
    })

    it('应拒绝以下划线开头的 username', () => {
      assert(!isValidUsername('_admin'), '前导下划线应为无效')
      assert(!isValidUsername('__user'), '双下划线应为无效')
    })

    it('应拒绝包含特殊字符的 username', () => {
      assert(!isValidUsername('user-name'), '连字符应为无效')
      assert(!isValidUsername('user.name'), '点号应为无效')
      assert(!isValidUsername('user name'), '空格应为无效')
      assert(!isValidUsername('user@name'), '@ 符号应为无效')
      assert(!isValidUsername('user!'), '感叹号应为无效')
      assert(!isValidUsername('user#tag'), '# 号应为无效')
      assert(!isValidUsername('user$var'), '$ 符号应为无效')
    })

    it('应接受最大长度的 username（63 个字符）', () => {
      const maxUsername = 'A' + 'a'.repeat(62)
      assert(isValidUsername(maxUsername), '63 个字符的 username 应为有效')
    })

    it('应拒绝超过最大长度的 username（64+ 个字符）', () => {
      const tooLong = 'A' + 'a'.repeat(63)
      assert(!isValidUsername(tooLong), '64 个字符的 username 应为无效')
    })

    it('应接受单个字母的 username', () => {
      assert(isValidUsername('a'), '单个小写字母应为有效')
      assert(isValidUsername('Z'), '单个大写字母应为有效')
    })

    it('应接受大小写混合和下划线的 username', () => {
      assert(isValidUsername('App_User_123'), '大小写混合加下划线')
      assert(isValidUsername('testUser'), 'camelCase')
      assert(isValidUsername('TEST_USER'), 'SCREAMING_SNAKE_CASE')
    })
  })

  // ============================================
  // database name 边缘情况
  // ============================================
  describe('database name edge cases', () => {
    it('应拒绝空字符串', () => {
      assert(!isValidDatabaseName(''), '空字符串应为无效')
    })

    it('应拒绝以数字开头的名称', () => {
      assert(!isValidDatabaseName('1mydb'), '前导数字应为无效')
    })

    it('应拒绝以下划线开头的名称', () => {
      assert(
        !isValidDatabaseName('_mydb'),
        '前导下划线应为无效',
      )
    })

    it('应拒绝包含连字符的名称（需要引用标识符）', () => {
      assert(!isValidDatabaseName('my-database'), '连字符应为无效')
    })

    it('应接受有效的 database name', () => {
      assert(isValidDatabaseName('mydb'), '简单名称')
      assert(isValidDatabaseName('my_database'), '包含下划线')
      assert(isValidDatabaseName('DB123'), '包含数字')
      assert(isValidDatabaseName('testDb'), 'camelCase')
    })
  })

  // ============================================
  // 错误信息质量
  // ============================================
  describe('error message quality', () => {
    it('应在错误上下文中包含无效的 username', () => {
      try {
        assertValidUsername('bad-user!')
        assert(false, '应抛出异常')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(
          err.context?.username,
          'bad-user!',
          '应在上下文中包含 username',
        )
        assert(
          err.message.includes('bad-user!'),
          '错误信息应包含无效的 username',
        )
      }
    })

    it('应在错误上下文中包含无效的 database name', () => {
      try {
        assertValidDatabaseName('bad-db!')
        assert(false, '应抛出异常')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(
          err.context?.databaseName,
          'bad-db!',
          '应在上下文中包含 databaseName',
        )
        assert(
          err.message.includes('bad-db!'),
          '错误信息应包含无效的 database name',
        )
      }
    })

    it('应为 username 提供可操作的修复建议', () => {
      try {
        assertValidUsername('123invalid')
        assert(false, '应抛出异常')
      } catch (error) {
        const err = error as SpinDBError
        assert(
          err.suggestion !== undefined && err.suggestion.length > 0,
          '应包含非空建议',
        )
        assert(
          err.suggestion!.includes('start with a letter'),
          '建议应提及以字母开头',
        )
      }
    })

    it('应为 database name 提供可操作的修复建议', () => {
      try {
        assertValidDatabaseName('bad-name')
        assert(false, '应抛出异常')
      } catch (error) {
        const err = error as SpinDBError
        assert(
          err.suggestion !== undefined && err.suggestion.length > 0,
          '应包含非空建议',
        )
        assert(
          err.suggestion!.includes('start with a letter'),
          '建议应提及以字母开头',
        )
      }
    })
  })
})
