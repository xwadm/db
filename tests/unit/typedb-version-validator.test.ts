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
  isValidVersionFormat,
} from '../../engines/typedb/version-validator'

describe('TypeDB 版本验证器', () => {
  describe('parseVersion', () => {
    it('应解析完整版本字符串', () => {
      const parsed = parseVersion('3.8.0')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 3, '主版本应为 3')
      assertEqual(parsed!.minor, 8, '次版本应为 8')
      assertEqual(parsed!.patch, 0, '补丁版本应为 0')
      assertEqual(parsed!.raw, '3.8.0', '原始字符串应为 3.8.0')
    })

    it('应解析旧版本', () => {
      const parsed = parseVersion('2.0.0')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 2, '主版本应为 2')
      assertEqual(parsed!.minor, 0, '次版本应为 0')
      assertEqual(parsed!.patch, 0, '补丁版本应为 0')
    })

    it('对无效版本应返回 null', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, '无效版本应返回 null')
    })

    it('应解析部分版本并提供默认值', () => {
      const parsed = parseVersion('3.8')
      assert(parsed !== null, '应解析部分版本')
      assertEqual(parsed!.major, 3, '主版本应为 3')
      assertEqual(parsed!.minor, 8, '次版本应为 8')
      assertEqual(parsed!.patch, 0, '补丁版本默认为 0')
    })

    it('应解析仅含主版本的字符串并提供默认值', () => {
      const parsed = parseVersion('3')
      assert(parsed !== null, '应解析仅含主版本的字符串')
      assertEqual(parsed!.major, 3, '主版本应为 3')
      assertEqual(parsed!.minor, 0, '次版本默认为 0')
      assertEqual(parsed!.patch, 0, '补丁版本默认为 0')
    })

    it('应处理 v 前缀', () => {
      const parsed = parseVersion('v3.8.0')
      assert(parsed !== null, '应解析带 v 前缀的版本')
      assertEqual(parsed!.major, 3, '主版本应为 3')
    })
  })

  describe('isVersionSupported', () => {
    it('应支持 3.x 版本', () => {
      assert(isVersionSupported('3.8.0'), '版本 3.8.0 应受支持')
      assert(isVersionSupported('3'), '版本 3 应受支持')
      assert(isVersionSupported('3.8'), '版本 3.8 应受支持')
    })

    it('不应支持 2.x 版本', () => {
      assert(!isVersionSupported('2.0.0'), '版本 2.0.0 不应受支持')
      assert(!isVersionSupported('2'), '版本 2 不应受支持')
    })

    it('不应支持 1.x 版本', () => {
      assert(!isVersionSupported('1.0.0'), '版本 1.0.0 不应受支持')
    })
  })

  describe('getMajorVersion', () => {
    it('应从完整版本中提取主版本号', () => {
      assertEqual(getMajorVersion('3.8.0'), '3', '应提取 3')
    })

    it('应从部分版本中提取主版本号', () => {
      assertEqual(getMajorVersion('3.8'), '3', '应从 3.8 提取 3')
    })

    it('应仅从主版本号提取', () => {
      assertEqual(getMajorVersion('3'), '3', '应从 3 提取 3')
    })

    it('对无效版本应返回 null', () => {
      assertEqual(getMajorVersion('invalid'), null, '无效版本应返回 null')
    })
  })

  describe('compareVersions', () => {
    it('应比较相等的版本', () => {
      assertEqual(compareVersions('3.8.0', '3.8.0'), 0, '版本相等')
    })

    it('应比较不同的主版本', () => {
      const result1 = compareVersions('2.0.0', '3.0.0')
      assert(result1 !== null && result1 < 0, '2.x < 3.x')
      const result2 = compareVersions('3.0.0', '2.0.0')
      assert(result2 !== null && result2 > 0, '3.x > 2.x')
    })

    it('应比较不同的次版本', () => {
      const result1 = compareVersions('3.7.0', '3.8.0')
      assert(result1 !== null && result1 < 0, '3.7 < 3.8')
      const result2 = compareVersions('3.8.0', '3.7.0')
      assert(result2 !== null && result2 > 0, '3.8 > 3.7')
    })

    it('应比较不同的补丁版本', () => {
      const result1 = compareVersions('3.8.0', '3.8.1')
      assert(result1 !== null && result1 < 0, '3.8.0 < 3.8.1')
      const result2 = compareVersions('3.8.1', '3.8.0')
      assert(result2 !== null && result2 > 0, '3.8.1 > 3.8.0')
    })

    it('对无效版本应返回 null', () => {
      const result = compareVersions('invalid', '3.8.0')
      assertEqual(result, null, '无效版本应返回 null')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应接受完整的 semver 格式', () => {
      assert(isValidVersionFormat('3.8.0'), '3.8.0 应为有效格式')
    })

    it('应接受 major.minor 格式', () => {
      assert(isValidVersionFormat('3.8'), '3.8 应为有效格式')
    })

    it('应接受仅含主版本的格式', () => {
      assert(isValidVersionFormat('3'), '3 应为有效格式')
    })

    it('应接受 v 前缀', () => {
      assert(isValidVersionFormat('v3.8.0'), 'v3.8.0 应为有效格式')
    })

    it('应拒绝非数字字符串', () => {
      assert(!isValidVersionFormat('invalid'), 'invalid 应被拒绝')
    })

    it('应拒绝空字符串', () => {
      assert(!isValidVersionFormat(''), '空字符串应被拒绝')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同主版本应兼容', () => {
      const result = isVersionCompatible('3.7.0', '3.8.0')
      assert(result.compatible, '相同主版本应兼容')
    })

    it('跨主版本恢复不应兼容', () => {
      const result = isVersionCompatible('2.0.0', '3.0.0')
      assert(!result.compatible, '从 2.x 恢复到 3.x 不应兼容（跨主版本）')
      assert(
        result.warning?.includes('Cross-major') === true,
        '应包含跨主版本警告',
      )
    })

    it('恢复到较旧的主版本不应兼容', () => {
      const result = isVersionCompatible('3.0.0', '2.0.0')
      assert(!result.compatible, '从 3.x 恢复到 2.x 不应兼容')
    })

    it('完全相同的版本应兼容', () => {
      const result = isVersionCompatible('3.8.0', '3.8.0')
      assert(result.compatible, '相同版本应兼容')
    })
  })
})
