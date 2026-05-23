/**
 * CouchDB 版本验证器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/couchdb/version-validator'

describe('CouchDB Version Validator', () => {
  describe('parseVersion', () => {
    it('应解析完整版本字符串', () => {
      const parsed = parseVersion('3.5.1')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 3, '主版本应为 3')
      assertEqual(parsed!.minor, 5, '次版本应为 5')
      assertEqual(parsed!.patch, 1, '补丁应为 1')
      assertEqual(parsed!.full, '3.5.1', '完整版本应为 3.5.1')
    })

    it('应解析旧版本', () => {
      const parsed = parseVersion('3.3.0')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 3, '主版本应为 3')
      assertEqual(parsed!.minor, 3, '次版本应为 3')
      assertEqual(parsed!.patch, 0, '补丁应为 0')
    })

    it('对无效版本应返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '对无效值应返回 null')
    })

    it('对部分版本应返回 null', () => {
      const parsed = parseVersion('3.5')
      assertEqual(parsed, null, '对部分版本应返回 null')
    })

    it('对仅主版本应返回 null', () => {
      const parsed = parseVersion('3')
      assertEqual(parsed, null, '对仅主版本应返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应支持版本 3.x', () => {
      assert(isVersionSupported('3.5.1'), '版本 3.5.1 应受支持')
      assert(isVersionSupported('3'), '版本 3 应受支持')
      assert(isVersionSupported('3.5'), '版本 3.5 应受支持')
    })

    it('不应支持版本 2.x', () => {
      assert(
        !isVersionSupported('2.0.0'),
        '版本 2.0.0 不应受支持',
      )
      assert(!isVersionSupported('2'), '版本 2 不应受支持')
    })

    it('不应支持版本 1.x', () => {
      assert(
        !isVersionSupported('1.6.1'),
        '版本 1.6.1 不应受支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应从完整版本提取主版本', () => {
      assertEqual(getMajorVersion('3.5.1'), '3', '应提取 3')
    })

    it('应从部分版本提取主版本', () => {
      assertEqual(getMajorVersion('3.5'), '3', '应从 3.5 提取 3')
    })

    it('应从仅主版本提取主版本', () => {
      assertEqual(getMajorVersion('3'), '3', '应从 3 提取 3')
    })
  })

  describe('compareVersions', () => {
    it('应比较相等版本', () => {
      assertEqual(compareVersions('3.5.1', '3.5.1'), 0, '相等版本')
    })

    it('应比较不同主版本', () => {
      assert(compareVersions('3.5.1', '4.0.0') < 0, '3.x < 4.x')
      assert(compareVersions('4.0.0', '3.5.1') > 0, '4.x > 3.x')
    })

    it('应比较不同次版本', () => {
      assert(compareVersions('3.4.0', '3.5.0') < 0, '3.4 < 3.5')
      assert(compareVersions('3.5.0', '3.4.0') > 0, '3.5 > 3.4')
    })

    it('应比较不同补丁版本', () => {
      assert(compareVersions('3.5.0', '3.5.1') < 0, '3.5.0 < 3.5.1')
      assert(compareVersions('3.5.1', '3.5.0') > 0, '3.5.1 > 3.5.0')
    })

    it('应使用字符串比较处理无效版本', () => {
      // 对无效版本回退到 localeCompare
      const result = compareVersions('invalid', '3.5.1')
      assert(typeof result === 'number', '应返回数字')
    })
  })

  describe('isVersionCompatible', () => {
    it('对相同主版本应兼容', () => {
      assert(
        isVersionCompatible('3.4.0', '3.5.1'),
        '相同主版本应兼容',
      )
    })

    it('对不同主版本应不兼容', () => {
      assert(
        !isVersionCompatible('3.5.1', '4.0.0'),
        '不同主版本应不兼容',
      )
    })

    it('对完全相同版本应兼容', () => {
      assert(
        isVersionCompatible('3.5.1', '3.5.1'),
        '相同版本应兼容',
      )
    })
  })
})
