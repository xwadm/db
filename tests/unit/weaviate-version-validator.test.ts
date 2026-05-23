/**
 * Weaviate 版本验证器单元测试
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
} from '../../engines/weaviate/version-validator'

describe('Weaviate 版本验证器', () => {
  describe('parseVersion', () => {
    it('应该解析完整版本字符串', () => {
      const parsed = parseVersion('1.35.7')
      assert(parsed !== null, '应该解析版本')
      assertEqual(parsed!.major, 1, '主版本应该是 1')
      assertEqual(parsed!.minor, 35, '次版本应该是 35')
      assertEqual(parsed!.patch, 7, '补丁版本应该是 7')
      assertEqual(parsed!.raw, '1.35.7', '原始值应该是 1.35.7')
    })

    it('应该解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v1.35.7')
      assert(parsed !== null, '应该解析带 v 前缀的版本')
      assertEqual(parsed!.major, 1, '主版本应该是 1')
      assertEqual(parsed!.minor, 35, '次版本应该是 35')
      assertEqual(parsed!.patch, 7, '补丁版本应该是 7')
    })

    it('应该解析主版本.次版本格式', () => {
      const parsed = parseVersion('1.35')
      assert(parsed !== null, '应该解析主版本.次版本')
      assertEqual(parsed!.major, 1, '主版本应该是 1')
      assertEqual(parsed!.minor, 35, '次版本应该是 35')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该仅解析主版本', () => {
      const parsed = parseVersion('1')
      assert(parsed !== null, '应该仅解析主版本')
      assertEqual(parsed!.major, 1, '主版本应该是 1')
      assertEqual(parsed!.minor, 0, '次版本应该默认为 0')
      assertEqual(parsed!.patch, 0, '补丁版本应该默认为 0')
    })

    it('应该对无效版本返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应该返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应该支持 1.x 版本', () => {
      assert(isVersionSupported('1.35.7'), '版本 1.35.7 应该被支持')
      assert(isVersionSupported('1.0.0'), '版本 1.0.0 应该被支持')
    })

    it('应该支持未来的主版本', () => {
      assert(isVersionSupported('2.0.0'), '版本 2.0.0 应该被支持')
    })

    it('不应该支持 0.x 版本', () => {
      assert(
        !isVersionSupported('0.9.0'),
        '版本 0.9.0 不应该被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应该提取主版本', () => {
      assertEqual(getMajorVersion('1.35.7'), '1', '应该提取 1')
      assertEqual(getMajorVersion('2.0.0'), '2', '应该提取 2')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应该提取主版本.次版本', () => {
      assertEqual(getMajorMinorVersion('1.35.7'), '1.35', '应该提取 1.35')
      assertEqual(getMajorMinorVersion('2.0.1'), '2.0', '应该提取 2.0')
    })
  })

  describe('compareVersions', () => {
    it('应该比较相等的版本', () => {
      assertEqual(compareVersions('1.35.7', '1.35.7'), 0, '相等的版本')
    })

    it('应该比较不同的主版本', () => {
      assertEqual(compareVersions('1.35.7', '2.0.0'), -1, '1.x < 2.x')
      assertEqual(compareVersions('2.0.0', '1.35.7'), 1, '2.x > 1.x')
    })

    it('应该比较不同的次版本', () => {
      assertEqual(compareVersions('1.34.0', '1.35.0'), -1, '1.34 < 1.35')
      assertEqual(compareVersions('1.35.0', '1.34.0'), 1, '1.35 > 1.34')
    })

    it('应该比较不同的补丁版本', () => {
      assertEqual(compareVersions('1.35.6', '1.35.7'), -1, '1.35.6 < 1.35.7')
      assertEqual(compareVersions('1.35.7', '1.35.6'), 1, '1.35.7 > 1.35.6')
    })

    it('应该对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '1.35.7'), null, '第一个参数无效')
      assertEqual(compareVersions('1.35.7', 'invalid'), null, '第二个参数无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本应该兼容', () => {
      const result = isVersionCompatible('1.34.0', '1.35.7')
      assert(result.compatible, '相同主版本应该兼容')
      assertEqual(result.warning, undefined, '不应该有警告')
    })

    it('从旧主版本升级时应该发出警告', () => {
      const result = isVersionCompatible('1.35.7', '2.0.0')
      assert(result.compatible, '升级应该兼容')
      assert(
        result.warning !== undefined,
        '版本升级应该有警告',
      )
    })

    it('降级主版本时不应该兼容', () => {
      const result = isVersionCompatible('2.0.0', '1.35.7')
      assert(!result.compatible, '降级不应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应该验证正确的格式', () => {
      assert(isValidVersionFormat('1.35.7'), '完整版本应该有效')
      assert(isValidVersionFormat('1.35'), '主版本.次版本应该有效')
      assert(isValidVersionFormat('1'), '仅主版本应该有效')
    })

    it('应该拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应该无效')
      assert(!isValidVersionFormat(''), '空值应该无效')
    })
  })
})
