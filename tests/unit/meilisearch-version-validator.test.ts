/**
 * Meilisearch 版本验证器单元测试
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
} from '../../engines/meilisearch/version-validator'

describe('Meilisearch 版本验证器', () => {
  describe('parseVersion', () => {
    it('应解析完整版本字符串', () => {
      const parsed = parseVersion('1.33.1')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 33, 'Minor 应为 33')
      assertEqual(parsed!.patch, 1, 'Patch 应为 1')
      assertEqual(parsed!.raw, '1.33.1', 'Raw 应为 1.33.1')
    })

    it('应解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v1.33.1')
      assert(parsed !== null, '应解析带 v 前缀的版本')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 33, 'Minor 应为 33')
      assertEqual(parsed!.patch, 1, 'Patch 应为 1')
    })

    it('应解析 major.minor 版本', () => {
      const parsed = parseVersion('1.33')
      assert(parsed !== null, '应解析 major.minor')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 33, 'Minor 应为 33')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('应仅解析 major 版本', () => {
      const parsed = parseVersion('1')
      assert(parsed !== null, '应解析仅 major')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 0, 'Minor 应默认为 0')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('无效版本应返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应支持 1.x 版本', () => {
      assert(isVersionSupported('1.33.1'), '版本 1.33.1 应被支持')
      assert(isVersionSupported('1.0.0'), '版本 1.0.0 应被支持')
    })

    it('应支持未来的主版本', () => {
      assert(isVersionSupported('2.0.0'), '版本 2.0.0 应被支持')
    })

    it('不应支持 0.x 版本', () => {
      assert(
        !isVersionSupported('0.9.0'),
        '版本 0.9.0 不应被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应提取主版本号', () => {
      assertEqual(getMajorVersion('1.33.1'), '1', '应提取 1')
      assertEqual(getMajorVersion('2.0.0'), '2', '应提取 2')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应提取 major.minor 版本', () => {
      assertEqual(getMajorMinorVersion('1.33.1'), '1.33', '应提取 1.33')
      assertEqual(getMajorMinorVersion('2.0.1'), '2.0', '应提取 2.0')
    })
  })

  describe('compareVersions', () => {
    it('应比较相等的版本', () => {
      assertEqual(compareVersions('1.33.1', '1.33.1'), 0, '相等版本')
    })

    it('应比较不同的主版本', () => {
      assertEqual(compareVersions('1.33.1', '2.0.0'), -1, '1.x < 2.x')
      assertEqual(compareVersions('2.0.0', '1.33.1'), 1, '2.x > 1.x')
    })

    it('应比较不同的次版本', () => {
      assertEqual(compareVersions('1.32.0', '1.33.0'), -1, '1.32 < 1.33')
      assertEqual(compareVersions('1.33.0', '1.32.0'), 1, '1.33 > 1.32')
    })

    it('应比较不同的补丁版本', () => {
      assertEqual(compareVersions('1.33.0', '1.33.1'), -1, '1.33.0 < 1.33.1')
      assertEqual(compareVersions('1.33.1', '1.33.0'), 1, '1.33.1 > 1.33.0')
    })

    it('无效版本应返回 null', () => {
      assertEqual(compareVersions('invalid', '1.33.1'), null, '第一个无效')
      assertEqual(compareVersions('1.33.1', 'invalid'), null, '第二个无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本号应为兼容', () => {
      const result = isVersionCompatible('1.32.0', '1.33.1')
      assert(result.compatible, '相同主版本应为兼容')
      assertEqual(result.warning, undefined, '不应有警告')
    })

    it('从旧主版本升级时应发出警告', () => {
      const result = isVersionCompatible('1.33.1', '2.0.0')
      assert(result.compatible, '升级应为兼容')
      assert(
        result.warning !== undefined,
        '版本升级应有警告',
      )
    })

    it('降级主版本号时不应为兼容', () => {
      const result = isVersionCompatible('2.0.0', '1.33.1')
      assert(!result.compatible, '降级不应为兼容')
      assert(result.warning !== undefined, '应有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应验证正确格式', () => {
      assert(isValidVersionFormat('1.33.1'), '完整版本应为有效')
      assert(isValidVersionFormat('1.33'), 'major.minor 应为有效')
      assert(isValidVersionFormat('1'), '仅 major 应为有效')
    })

    it('应拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应为无效')
      assert(!isValidVersionFormat(''), '空值应为无效')
    })
  })
})
