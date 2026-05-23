import { describe, it } from 'node:test'
import {
  isValidUsername,
  assertValidUsername,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { assert, assertEqual } from '../utils/assertions'

describe('用户名验证', () => {
  describe('isValidUsername', () => {
    it('应接受有效的用户名', () => {
      assert(isValidUsername('alice'), '简单的小写名称')
      assert(isValidUsername('Bob'), '首字母大写的名称')
      assert(isValidUsername('app_user'), '包含下划线的名称')
      assert(isValidUsername('user123'), '包含数字的名称')
      assert(isValidUsername('a'), '单个字母')
      assert(isValidUsername('A'.repeat(63)), '最大长度（63 个字符）')
    })

    it('应拒绝无效的用户名', () => {
      assert(!isValidUsername(''), '空字符串')
      assert(!isValidUsername('123user'), '以数字开头')
      assert(!isValidUsername('_user'), '以下划线开头')
      assert(!isValidUsername('user-name'), '包含连字符')
      assert(!isValidUsername('user.name'), '包含点号')
      assert(!isValidUsername('user name'), '包含空格')
      assert(!isValidUsername("user'name"), '包含单引号')
      assert(!isValidUsername('user"name'), '包含双引号')
      assert(!isValidUsername('A'.repeat(64)), '超出最大长度（64 个字符）')
    })
  })

  describe('assertValidUsername', () => {
    it('对有效的用户名不应抛出异常', () => {
      assertValidUsername('appuser')
      assertValidUsername('test_user_123')
    })

    it('对无效的用户名应抛出 SpinDBError', () => {
      try {
        assertValidUsername('123invalid')
        assert(false, '应该已抛出异常')
      } catch (error) {
        assert(error instanceof SpinDBError, '应为 SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_USERNAME,
          '应包含正确的错误码',
        )
      }
    })

    it('应在错误上下文中包含用户名', () => {
      try {
        assertValidUsername('bad-name')
        assert(false, '应该已抛出异常')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(err.context?.username, 'bad-name', '应在上下文中包含用户名')
      }
    })
  })

  describe('SQL 注入防护', () => {
    it('应拒绝常见的 SQL 注入模式', () => {
      assert(
        !isValidUsername("admin'; DROP TABLE users; --"),
        '包含分号的 SQL 注入',
      )
      assert(!isValidUsername('user" OR "1"="1'), '包含引号的 SQL 注入')
      assert(!isValidUsername("'; DELETE FROM test; --"), 'SQL 删除注入')
      assert(!isValidUsername('admin/**/OR/**/1=1'), 'SQL 注释注入')
    })

    it('对 SQL 注入尝试应抛出 SpinDBError', () => {
      try {
        assertValidUsername("admin'; DROP TABLE users; --")
        assert(false, '应对 SQL 注入抛出异常')
      } catch (error) {
        assert(error instanceof SpinDBError, '应为 SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_USERNAME,
          '应包含 INVALID_USERNAME 错误码',
        )
      }
    })
  })

  describe('边界值', () => {
    it('应接受恰好 63 个字符', () => {
      const name = 'A' + 'b'.repeat(62)
      assert(isValidUsername(name), '63 个字符应为有效')
    })

    it('应拒绝恰好 64 个字符', () => {
      const name = 'A' + 'b'.repeat(63)
      assert(!isValidUsername(name), '64 个字符应为无效')
    })

    it('应接受单字符名称', () => {
      assert(isValidUsername('a'), '单个小写字母')
      assert(isValidUsername('Z'), '单个大写字母')
    })

    it('应拒绝仅包含空白字符的字符串', () => {
      assert(!isValidUsername(' '), '单个空格')
      assert(!isValidUsername('\t'), '制表符')
      assert(!isValidUsername('\n'), '换行符')
    })

    it('应拒绝 Unicode 字符', () => {
      assert(!isValidUsername('user\u0000'), '空字节')
      assert(!isValidUsername('caf\u00e9'), '带重音的字符')
    })
  })
})
