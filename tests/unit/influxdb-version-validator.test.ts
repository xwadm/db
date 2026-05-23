/**
 * InfluxDB 版本验证器单元测试
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
} from '../../engines/influxdb/version-validator'

describe('InfluxDB Version Validator', () => {
  describe('parseVersion', () => {
    it('应解析完整版本字符串', () => {
      const parsed = parseVersion('3.8.0')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 3, 'Major 应为 3')
      assertEqual(parsed!.minor, 8, 'Minor 应为 8')
      assertEqual(parsed!.patch, 0, 'Patch 应为 0')
      assertEqual(parsed!.raw, '3.8.0', 'Raw 应为 3.8.0')
    })

    it('应解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v3.8.0')
      assert(parsed !== null, '应解析带 v 前缀的版本')
      assertEqual(parsed!.major, 3, 'Major 应为 3')
      assertEqual(parsed!.minor, 8, 'Minor 应为 8')
      assertEqual(parsed!.patch, 0, 'Patch 应为 0')
    })

    it('应解析 major.minor 版本', () => {
      const parsed = parseVersion('3.8')
      assert(parsed !== null, '应解析 major.minor')
      assertEqual(parsed!.major, 3, 'Major 应为 3')
      assertEqual(parsed!.minor, 8, 'Minor 应为 8')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('应仅解析 major 版本', () => {
      const parsed = parseVersion('3')
      assert(parsed !== null, '应解析仅 major')
      assertEqual(parsed!.major, 3, 'Major 应为 3')
      assertEqual(parsed!.minor, 0, 'Minor 应默认为 0')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('应对无效版本返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '应对无效版本返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应支持版本 3.x', () => {
      assert(isVersionSupported('3.8.0'), '版本 3.8.0 应被支持')
      assert(isVersionSupported('3.0.0'), '版本 3.0.0 应被支持')
    })

    it('应支持未来主要版本', () => {
      assert(isVersionSupported('4.0.0'), '版本 4.0.0 应被支持')
    })

    it('不应支持版本 2.x', () => {
      assert(
        !isVersionSupported('2.7.0'),
        '版本 2.7.0 不应被支持',
      )
    })

    it('不应支持版本 1.x', () => {
      assert(
        !isVersionSupported('1.8.0'),
        '版本 1.8.0 不应被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应提取主要版本', () => {
      assertEqual(getMajorVersion('3.8.0'), '3', '应提取 3')
      assertEqual(getMajorVersion('4.0.0'), '4', '应提取 4')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应提取 major.minor 版本', () => {
      assertEqual(getMajorMinorVersion('3.8.0'), '3.8', '应提取 3.8')
      assertEqual(getMajorMinorVersion('4.0.1'), '4.0', '应提取 4.0')
    })
  })

  describe('compareVersions', () => {
    it('应比较相同版本', () => {
      assertEqual(compareVersions('3.8.0', '3.8.0'), 0, '相同版本')
    })

    it('应比较不同的 major 版本', () => {
      assertEqual(compareVersions('3.8.0', '4.0.0'), -1, '3.x < 4.x')
      assertEqual(compareVersions('4.0.0', '3.8.0'), 1, '4.x > 3.x')
    })

    it('应比较不同的 minor 版本', () => {
      assertEqual(compareVersions('3.7.0', '3.8.0'), -1, '3.7 < 3.8')
      assertEqual(compareVersions('3.8.0', '3.7.0'), 1, '3.8 > 3.7')
    })

    it('应比较不同的 patch 版本', () => {
      assertEqual(compareVersions('3.8.0', '3.8.1'), -1, '3.8.0 < 3.8.1')
      assertEqual(compareVersions('3.8.1', '3.8.0'), 1, '3.8.1 > 3.8.0')
    })

    it('应对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '3.8.0'), null, '第一个无效')
      assertEqual(compareVersions('3.8.0', 'invalid'), null, '第二个无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同 major 版本应兼容', () => {
      const result = isVersionCompatible('3.7.0', '3.8.0')
      assert(result.compatible, '相同 major 应兼容')
      assertEqual(result.warning, undefined, '无预期警告')
    })

    it('从旧 major 版本升级时应警告', () => {
      const result = isVersionCompatible('3.8.0', '4.0.0')
      assert(result.compatible, '升级应兼容')
      assert(
        result.warning !== undefined,
        '版本升级应有警告',
      )
    })

    it('降级 major 版本时不应兼容', () => {
      const result = isVersionCompatible('4.0.0', '3.8.0')
      assert(!result.compatible, '降级不应兼容')
      assert(result.warning !== undefined, '应有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应验证正确格式', () => {
      assert(isValidVersionFormat('3.8.0'), '完整版本应有效')
      assert(isValidVersionFormat('3.8'), 'Major.minor 应有效')
      assert(isValidVersionFormat('3'), '仅 major 应有效')
    })

    it('应拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应无效')
      assert(!isValidVersionFormat(''), '空字符串应无效')
    })
  })
})
