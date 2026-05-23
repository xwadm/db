/**
 * TigerBeetle 版本验证器单元测试
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
} from '../../engines/tigerbeetle/version-validator'

describe('TigerBeetle 版本验证器', () => {
  describe('parseVersion', () => {
    it('应该解析完整版本字符串', () => {
      const parsed = parseVersion('0.16.3')
      assert(parsed !== null, '应该解析版本')
      assertEqual(parsed!.major, 0, '主版本应该是 0')
      assertEqual(parsed!.minor, 16, '次版本应该是 16')
      assertEqual(parsed!.patch, 3, '补丁版本应该是 3')
      assertEqual(parsed!.raw, '0.16.3', '原始值应该是 0.16.3')
    })

    it('应该解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v0.16.3')
      assert(parsed !== null, '应该解析带 v 前缀的版本')
      assertEqual(parsed!.major, 0, '主版本应该是 0')
      assertEqual(parsed!.minor, 16, '次版本应该是 16')
      assertEqual(parsed!.patch, 3, '补丁版本应该是 3')
    })

    it('应该解析主版本.次版本格式', () => {
      const parsed = parseVersion('0.16')
      assert(parsed !== null, '应该解析主版本.次版本')
      assertEqual(parsed!.major, 0, '主版本应该是 0')
      assertEqual(parsed!.minor, 16, '次版本应该是 16')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该仅解析主版本', () => {
      const parsed = parseVersion('0')
      assert(parsed !== null, '应该仅解析主版本')
      assertEqual(parsed!.major, 0, '主版本应该是 0')
      assertEqual(parsed!.minor, 0, '次版本应该默认为 0')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该对无效版本返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应该返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应该支持版本 0.16.x', () => {
      assert(isVersionSupported('0.16.3'), '版本 0.16.3 应该被支持')
      assert(isVersionSupported('0.16.0'), '版本 0.16.0 应该被支持')
    })

    it('应该支持版本 0.15.x', () => {
      assert(isVersionSupported('0.15.0'), '版本 0.15.0 应该被支持')
    })

    it('不应该支持版本 0.14.x', () => {
      assert(
        !isVersionSupported('0.14.0'),
        '版本 0.14.0 不应该被支持',
      )
    })

    it('应该支持未来的次版本', () => {
      assert(isVersionSupported('0.17.0'), '版本 0.17.0 应该被支持')
    })
  })

  describe('getMajorVersion', () => {
    it('应该提取主版本', () => {
      assertEqual(getMajorVersion('0.16.3'), '0', '应该提取 0')
      assertEqual(getMajorVersion('1.0.0'), '1', '应该提取 1')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应该提取主版本.次版本', () => {
      assertEqual(getMajorMinorVersion('0.16.3'), '0.16', '应该提取 0.16')
      assertEqual(getMajorMinorVersion('0.15.0'), '0.15', '应该提取 0.15')
    })
  })

  describe('compareVersions', () => {
    it('应该比较相等的版本', () => {
      assertEqual(compareVersions('0.16.3', '0.16.3'), 0, '相等的版本')
    })

    it('应该比较不同的主版本', () => {
      assertEqual(compareVersions('0.16.3', '1.0.0'), -1, '0.x < 1.x')
      assertEqual(compareVersions('1.0.0', '0.16.3'), 1, '1.x > 0.x')
    })

    it('应该比较不同的次版本', () => {
      assertEqual(compareVersions('0.15.0', '0.16.0'), -1, '0.15 < 0.16')
      assertEqual(compareVersions('0.16.0', '0.15.0'), 1, '0.16 > 0.15')
    })

    it('应该比较不同的补丁版本', () => {
      assertEqual(compareVersions('0.16.2', '0.16.3'), -1, '0.16.2 < 0.16.3')
      assertEqual(compareVersions('0.16.3', '0.16.2'), 1, '0.16.3 > 0.16.2')
    })

    it('应该对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '0.16.3'), null, '第一个参数无效')
      assertEqual(compareVersions('0.16.3', 'invalid'), null, '第二个参数无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本.次版本应该兼容', () => {
      const result = isVersionCompatible('0.16.0', '0.16.3')
      assert(result.compatible, '相同主版本.次版本应该兼容')
      assertEqual(result.warning, undefined, '不应该有警告')
    })

    it('升级次版本时应该发出警告', () => {
      const result = isVersionCompatible('0.15.0', '0.16.0')
      assert(result.compatible, '升级应该兼容')
      assert(
        result.warning !== undefined,
        '次版本升级应该有警告',
      )
    })

    it('降级主版本.次版本时不应该兼容', () => {
      const result = isVersionCompatible('0.16.0', '0.15.0')
      assert(!result.compatible, '降级不应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应该验证正确的格式', () => {
      assert(isValidVersionFormat('0.16.3'), '完整版本应该有效')
      assert(isValidVersionFormat('0.16'), '主版本.次版本应该有效')
      assert(isValidVersionFormat('0'), '仅主版本应该有效')
    })

    it('应该拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应该无效')
      assert(!isValidVersionFormat(''), '空值应该无效')
    })
  })
})
