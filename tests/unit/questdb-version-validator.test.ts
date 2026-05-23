/**
 * QuestDB version validator 单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/questdb/version-validator'

describe('QuestDB Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('9.2.3')
      assert(parsed !== null, '应解析version')
      assertEqual(parsed!.major, 9, 'major应为9')
      assertEqual(parsed!.minor, 2, 'minor应为2')
      assertEqual(parsed!.patch, 3, 'patch应为3')
      assertEqual(parsed!.full, '9.2.3', 'full应为9.2.3')
    })

    it('should parse older version', () => {
      const parsed = parseVersion('8.1.0')
      assert(parsed !== null, '应解析version')
      assertEqual(parsed!.major, 8, 'major应为8')
      assertEqual(parsed!.minor, 1, 'minor应为1')
      assertEqual(parsed!.patch, 0, 'patch应为0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效version应返回null')
    })

    it('should parse partial version with defaults', () => {
      const parsed = parseVersion('9.2')
      assert(parsed !== null, '应解析部分version')
      assertEqual(parsed!.major, 9, 'major应为9')
      assertEqual(parsed!.minor, 2, 'minor应为2')
      assertEqual(parsed!.patch, 0, 'patch应默认为0')
    })

    it('should parse major only version with defaults', () => {
      const parsed = parseVersion('9')
      assert(parsed !== null, '应解析仅major的version')
      assertEqual(parsed!.major, 9, 'major应为9')
      assertEqual(parsed!.minor, 0, 'minor应默认为0')
      assertEqual(parsed!.patch, 0, 'patch应默认为0')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 9.x', () => {
      assert(isVersionSupported('9.2.3'), 'version 9.2.3应被支持')
      assert(isVersionSupported('9'), 'version 9应被支持')
      assert(isVersionSupported('9.2'), 'version 9.2应被支持')
    })

    it('should not support version 8.x', () => {
      assert(
        !isVersionSupported('8.0.0'),
        'version 8.0.0不应被支持',
      )
      assert(!isVersionSupported('8'), 'version 8不应被支持')
    })

    it('should not support version 7.x', () => {
      assert(
        !isVersionSupported('7.0.0'),
        'version 7.0.0不应被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('9.2.3'), '9', '应提取9')
    })

    it('should extract major version from partial version', () => {
      assertEqual(getMajorVersion('9.2'), '9', '应从9.2提取9')
    })

    it('should extract major version from major only', () => {
      assertEqual(getMajorVersion('9'), '9', '应从9提取9')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('9.2.3', '9.2.3'), 0, '相等version')
    })

    it('should compare different major versions', () => {
      assert(compareVersions('8.0.0', '9.0.0') < 0, '8.x < 9.x')
      assert(compareVersions('9.0.0', '8.0.0') > 0, '9.x > 8.x')
    })

    it('should compare different minor versions', () => {
      assert(compareVersions('9.1.0', '9.2.0') < 0, '9.1 < 9.2')
      assert(compareVersions('9.2.0', '9.1.0') > 0, '9.2 > 9.1')
    })

    it('should compare different patch versions', () => {
      assert(compareVersions('9.2.0', '9.2.3') < 0, '9.2.0 < 9.2.3')
      assert(compareVersions('9.2.3', '9.2.0') > 0, '9.2.3 > 9.2.0')
    })

    it('should handle invalid versions with string comparison', () => {
      // 对无效version回退到localeCompare
      const result = compareVersions('invalid', '9.2.3')
      assert(typeof result === 'number', '应返回数字')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      assert(
        isVersionCompatible('9.1.0', '9.2.3'),
        '相同major应兼容',
      )
    })

    it('should be compatible for restoring to newer major version', () => {
      // QuestDB允许恢复到相同或更新的major version
      assert(
        isVersionCompatible('8.0.0', '9.0.0'),
        '从8.x恢复到9.x应兼容',
      )
    })

    it('should not be compatible for restoring to older major version', () => {
      assert(
        !isVersionCompatible('9.0.0', '8.0.0'),
        '从9.x恢复到8.x不应兼容',
      )
    })

    it('should be compatible for exact same version', () => {
      assert(
        isVersionCompatible('9.2.3', '9.2.3'),
        '相同version应兼容',
      )
    })
  })
})
