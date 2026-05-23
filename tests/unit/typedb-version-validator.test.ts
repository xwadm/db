/**
 * TypeDB 版本验证器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/typedb/version-validator'

describe('TypeDB 版本验证器', () => {
  describe('parseVersion', () => {
    it('应该解析完整版本字符串', () => {
      const parsed = parseVersion('2.26.6')
      assert(parsed !== null, '应该解析版本')
      assertEqual(parsed!.major, 2, '主版本应该是 2')
      assertEqual(parsed!.minor, 26, '次版本应该是 26')
      assertEqual(parsed!.patch, 6, '补丁版本应该是 6')
    })

    it('应该解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v2.26.6')
      assert(parsed !== null, '应该解析带 v 前缀的版本')
      assertEqual(parsed!.major, 2, '主版本应该是 2')
    })

    it('应该对无效版本返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应该返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应该支持版本 2.x', () => {
      assert(isVersionSupported('2.26.6'), '版本 2.26.6 应该被支持')
      assert(isVersionSupported('2.0.0'), '版本 2.0.0 应该被支持')
    })

    it('不应该支持版本 1.x', () => {
      assert(
        !isVersionSupported('1.0.0'),
        '版本 1.0.0 不应该被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应该提取主版本', () => {
      assertEqual(getMajorVersion('2.26.6'), '2', '应该提取 2')
      assertEqual(getMajorVersion('3.0.0'), '3', '应该提取 3')
    })
  })

  describe('compareVersions', () => {
    it('应该比较相等的版本', () => {
      assertEqual(compareVersions('2.26.6', '2.26.6'), 0, '相等的版本')
    })

    it('应该比较不同的主版本', () => {
      assertEqual(compareVersions('2.26.6', '3.0.0'), -1, '2.x < 3.x')
      assertEqual(compareVersions('3.0.0', '2.26.6'), 1, '3.x > 2.x')
    })

    it('应该比较不同的次版本', () => {
      assertEqual(compareVersions('2.25.0', '2.26.0'), -1, '2.25 < 2.26')
      assertEqual(compareVersions('2.26.0', '2.25.0'), 1, '2.26 > 2.25')
    })

    it('应该对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '2.26.6'), null, '第一个参数无效')
      assertEqual(compareVersions('2.26.6', 'invalid'), null, '第二个参数无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本应该兼容', () => {
      const result = isVersionCompatible('2.25.0', '2.26.6')
      assert(result.compatible, '相同主版本应该兼容')
    })

    it('升级主版本时应该发出警告', () => {
      const result = isVersionCompatible('2.26.6', '3.0.0')
      assert(result.compatible, '升级应该兼容')
      assert(
        result.warning !== undefined,
        '主版本升级应该有警告',
      )
    })

    it('降级主版本时不应该兼容', () => {
      const result = isVersionCompatible('3.0.0', '2.26.6')
      assert(!result.compatible, '降级不应该兼容')
    })
  })
})
