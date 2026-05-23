/**
 * Qdrant version validator 单元测试
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
} from '../../engines/qdrant/version-validator'

describe('Qdrant Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('1.12.0')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 12, 'Minor 应为 12')
      assertEqual(parsed!.patch, 0, 'Patch 应为 0')
      assertEqual(parsed!.raw, '1.12.0', 'Raw 应为 1.12.0')
    })

    it('should parse version with v prefix', () => {
      const parsed = parseVersion('v1.12.0')
      assert(parsed !== null, '应解析带 v 前缀的版本')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 12, 'Minor 应为 12')
      assertEqual(parsed!.patch, 0, 'Patch 应为 0')
    })

    it('should parse major.minor version', () => {
      const parsed = parseVersion('1.12')
      assert(parsed !== null, '应解析 major.minor')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 12, 'Minor 应为 12')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('should parse major version only', () => {
      const parsed = parseVersion('1')
      assert(parsed !== null, '应仅解析 major')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 0, 'Minor 应默认为 0')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '对于无效版本应返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 1.x', () => {
      assert(isVersionSupported('1.12.0'), '版本 1.12.0 应受支持')
      assert(isVersionSupported('1.0.0'), '版本 1.0.0 应受支持')
    })

    it('should support future major versions', () => {
      assert(isVersionSupported('2.0.0'), '版本 2.0.0 应受支持')
    })

    it('should not support version 0.x', () => {
      assert(
        !isVersionSupported('0.11.0'),
        '版本 0.11.0 不应受支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version', () => {
      assertEqual(getMajorVersion('1.12.0'), '1', '应提取 1')
      assertEqual(getMajorVersion('2.0.0'), '2', '应提取 2')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('should extract major.minor version', () => {
      assertEqual(
        getMajorMinorVersion('1.12.0'),
        '1.12',
        '应提取 1.12',
      )
      assertEqual(getMajorMinorVersion('2.0.1'), '2.0', '应提取 2.0')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('1.12.0', '1.12.0'), 0, '相等的版本')
    })

    it('should compare different major versions', () => {
      assertEqual(compareVersions('1.12.0', '2.0.0'), -1, '1.x < 2.x')
      assertEqual(compareVersions('2.0.0', '1.12.0'), 1, '2.x > 1.x')
    })

    it('should compare different minor versions', () => {
      assertEqual(compareVersions('1.11.0', '1.12.0'), -1, '1.11 < 1.12')
      assertEqual(compareVersions('1.12.0', '1.11.0'), 1, '1.12 > 1.11')
    })

    it('should compare different patch versions', () => {
      assertEqual(compareVersions('1.12.0', '1.12.1'), -1, '1.12.0 < 1.12.1')
      assertEqual(compareVersions('1.12.1', '1.12.0'), 1, '1.12.1 > 1.12.0')
    })

    it('should return null for invalid versions', () => {
      assertEqual(compareVersions('invalid', '1.12.0'), null, '第一个无效')
      assertEqual(compareVersions('1.12.0', 'invalid'), null, '第二个无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      const result = isVersionCompatible('1.11.0', '1.12.0')
      assert(result.compatible, '相同 major 版本应兼容')
      assertEqual(result.warning, undefined, '不应有警告')
    })

    it('should warn when upgrading from older major version', () => {
      const result = isVersionCompatible('1.12.0', '2.0.0')
      assert(result.compatible, '升级应兼容')
      assert(
        result.warning !== undefined,
        '版本升级应有警告',
      )
    })

    it('should not be compatible when downgrading major version', () => {
      const result = isVersionCompatible('2.0.0', '1.12.0')
      assert(!result.compatible, '降级不应兼容')
      assert(result.warning !== undefined, '应有警告')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should validate correct formats', () => {
      assert(isValidVersionFormat('1.12.0'), '完整版本应有效')
      assert(isValidVersionFormat('1.12'), 'Major.minor 应有效')
      assert(isValidVersionFormat('1'), '仅 major 应有效')
    })

    it('should reject invalid formats', () => {
      assert(!isValidVersionFormat('invalid'), '文本应无效')
      assert(!isValidVersionFormat(''), '空值应无效')
    })
  })
})
