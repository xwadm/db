/**
 * Valkey 版本验证器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  getMajorMinorVersion,
  compareVersions,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/valkey/version-validator'

describe('Valkey 版本验证器', () => {
  describe('parseVersion', () => {
    it('应该解析完整版本字符串', () => {
      const parsed = parseVersion('7.2.5')
      assert(parsed !== null, '应该解析版本')
      assertEqual(parsed!.major, 7, '主版本应该是 7')
      assertEqual(parsed!.minor, 2, '次版本应该是 2')
      assertEqual(parsed!.patch, 5, '补丁版本应该是 5')
      assertEqual(parsed!.raw, '7.2.5', '原始值应该是 7.2.5')
    })

    it('应该解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v7.2.5')
      assert(parsed !== null, '应该解析带 v 前缀的版本')
      assertEqual(parsed!.major, 7, '主版本应该是 7')
      assertEqual(parsed!.minor, 2, '次版本应该是 2')
      assertEqual(parsed!.patch, 5, '补丁版本应该是 5')
    })

    it('应该解析主版本.次版本格式', () => {
      const parsed = parseVersion('7.2')
      assert(parsed !== null, '应该解析主版本.次版本')
      assertEqual(parsed!.major, 7, '主版本应该是 7')
      assertEqual(parsed!.minor, 2, '次版本应该是 2')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该仅解析主版本', () => {
      const parsed = parseVersion('7')
      assert(parsed !== null, '应该仅解析主版本')
      assertEqual(parsed!.major, 7, '主版本应该是 7')
      assertEqual(parsed!.minor, 0, '次版本应该默认为 0')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该对无效版本返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应该返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应该支持版本 7.x', () => {
      assert(isVersionSupported('7.2.5'), '版本 7.2.5 应该被支持')
      assert(isVersionSupported('7.0.0'), '版本 7.0.0 应该被支持')
    })

    it('应该支持版本 8.x', () => {
      assert(isVersionSupported('8.0.0'), '版本 8.0.0 应该被支持')
    })

    it('不应该支持版本 6.x', () => {
      assert(
        !isVersionSupported('6.2.0'),
        '版本 6.2.0 不应该被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应该提取主版本', () => {
      assertEqual(getMajorVersion('7.2.5'), '7', '应该提取 7')
      assertEqual(getMajorVersion('8.0.0'), '8', '应该提取 8')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应该提取主版本.次版本', () => {
      assertEqual(getMajorMinorVersion('7.2.5'), '7.2', '应该提取 7.2')
      assertEqual(getMajorMinorVersion('8.0.1'), '8.0', '应该提取 8.0')
    })
  })

  describe('compareVersions', () => {
    it('应该比较相等的版本', () => {
      assertEqual(compareVersions('7.2.5', '7.2.5'), 0, '相等的版本')
    })

    it('应该比较不同的主版本', () => {
      assertEqual(compareVersions('7.2.5', '8.0.0'), -1, '7.x < 8.x')
      assertEqual(compareVersions('8.0.0', '7.2.5'), 1, '8.x > 7.x')
    })

    it('应该比较不同的次版本', () => {
      assertEqual(compareVersions('7.1.0', '7.2.0'), -1, '7.1 < 7.2')
      assertEqual(compareVersions('7.2.0', '7.1.0'), 1, '7.2 > 7.1')
    })

    it('应该比较不同的补丁版本', () => {
      assertEqual(compareVersions('7.2.4', '7.2.5'), -1, '7.2.4 < 7.2.5')
      assertEqual(compareVersions('7.2.5', '7.2.4'), 1, '7.2.5 > 7.2.4')
    })

    it('应该对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '7.2.5'), null, '第一个参数无效')
      assertEqual(compareVersions('7.2.5', 'invalid'), null, '第二个参数无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本应该兼容', () => {
      const result = isVersionCompatible('7.2.0', '7.2.5')
      assert(result.compatible, '相同主版本应该兼容')
      assertEqual(result.warning, undefined, '不应该有警告')
    })

    it('升级主版本时应该发出警告', () => {
      const result = isVersionCompatible('7.2.5', '8.0.0')
      assert(result.compatible, '升级应该兼容')
      assert(
        result.warning !== undefined,
        '主版本升级应该有警告',
      )
    })

    it('降级主版本时不应该兼容', () => {
      const result = isVersionCompatible('8.0.0', '7.2.5')
      assert(!result.compatible, '降级不应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应该验证正确的格式', () => {
      assert(isValidVersionFormat('7.2.5'), '完整版本应该有效')
      assert(isValidVersionFormat('7.2'), '主版本.次版本应该有效')
      assert(isValidVersionFormat('7'), '仅主版本应该有效')
    })

    it('应该拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应该无效')
      assert(!isValidVersionFormat(''), '空值应该无效')
    })
  })
})
