import { describe, it } from 'node:test'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/redis/version-validator'
import { assert, assertEqual } from '../utils/assertions'

describe('Redis 版本验证器', () => {
  describe('parseVersion', () => {
    it('应该解析标准的 Redis 版本字符串', () => {
      const version = parseVersion('7.2.4')
      assert(version !== null, '版本不应为 null')
      assertEqual(version!.major, 7, '主版本号应为 7')
      assertEqual(version!.minor, 2, '次版本号应为 2')
      assertEqual(version!.patch, 4, '补丁版本号应为 4')
    })

    it('应该解析只有 major.minor 的版本', () => {
      const version = parseVersion('7.0')
      assert(version !== null, '版本不应为 null')
      assertEqual(version!.major, 7, '主版本号应为 7')
      assertEqual(version!.minor, 0, '次版本号应为 0')
      assertEqual(version!.patch, 0, '补丁版本号应默认为 0')
    })

    it('应该解析只有主版本号的情况', () => {
      const version = parseVersion('7')
      assert(version !== null, '版本不应为 null')
      assertEqual(version!.major, 7, '主版本号应为 7')
      assertEqual(version!.minor, 0, '次版本号应默认为 0')
      assertEqual(version!.patch, 0, '补丁版本号应默认为 0')
    })

    it('应该解析 Redis 6.x 版本', () => {
      const version = parseVersion('6.2.14')
      assert(version !== null, '版本不应为 null')
      assertEqual(version!.major, 6, '主版本号应为 6')
      assertEqual(version!.minor, 2, '次版本号应为 2')
      assertEqual(version!.patch, 14, '补丁版本号应为 14')
    })

    it('应该在无效版本字符串时返回 null', () => {
      const version = parseVersion('invalid')
      assertEqual(version, null, '无效输入应返回 null')
    })

    it('应该在空字符串时返回 null', () => {
      const version = parseVersion('')
      assertEqual(version, null, '空字符串应返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应该对 Redis 6.x 返回 true', () => {
      assert(isVersionSupported('6.2.14'), 'Redis 6.2.14 应被支持')
      assert(isVersionSupported('6.0.0'), 'Redis 6.0.0 应被支持')
    })

    it('应该对 Redis 7.x 返回 true', () => {
      assert(isVersionSupported('7.0.0'), 'Redis 7.0.0 应被支持')
      assert(isVersionSupported('7.2.4'), 'Redis 7.2.4 应被支持')
    })

    it('应该对 Redis 8.x 返回 true', () => {
      assert(isVersionSupported('8.0.0'), 'Redis 8.0.0 应被支持')
    })

    it('应该对 Redis 5.x 返回 false', () => {
      assert(
        !isVersionSupported('5.0.14'),
        'Redis 5.0.14 不应被支持',
      )
    })

    it('应该对无效版本返回 false', () => {
      assert(
        !isVersionSupported('invalid'),
        '无效版本不应被支持',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('应该从完整版本中提取主版本号', () => {
      assertEqual(getMajorVersion('7.2.4'), '7', '主版本号应为 7')
      assertEqual(getMajorVersion('6.2.14'), '6', '主版本号应为 6')
      assertEqual(getMajorVersion('8.0.0'), '8', '主版本号应为 8')
    })

    it('应该处理只有主版本号的情况', () => {
      assertEqual(getMajorVersion('7'), '7', '主版本号应为 7')
    })

    it('应该对无效版本返回原始字符串', () => {
      // getMajorVersion 在解析失败时返回原始字符串
      assertEqual(
        getMajorVersion('invalid'),
        'invalid',
        '无效输入应返回原始值',
      )
    })
  })

  describe('compareVersions', () => {
    it('应该在 a < b 时返回负数', () => {
      const r1 = compareVersions('6.0.0', '7.0.0')
      const r2 = compareVersions('7.0.0', '7.2.0')
      const r3 = compareVersions('7.2.0', '7.2.4')
      assert(r1 !== null && r1 < 0, '6.0.0 应小于 7.0.0')
      assert(r2 !== null && r2 < 0, '7.0.0 应小于 7.2.0')
      assert(r3 !== null && r3 < 0, '7.2.0 应小于 7.2.4')
    })

    it('应该在 a > b 时返回正数', () => {
      const r1 = compareVersions('7.0.0', '6.0.0')
      const r2 = compareVersions('7.2.0', '7.0.0')
      const r3 = compareVersions('7.2.4', '7.2.0')
      assert(r1 !== null && r1 > 0, '7.0.0 应大于 6.0.0')
      assert(r2 !== null && r2 > 0, '7.2.0 应大于 7.0.0')
      assert(r3 !== null && r3 > 0, '7.2.4 应大于 7.2.0')
    })

    it('应该在版本相等时返回 0', () => {
      assertEqual(
        compareVersions('7.2.4', '7.2.4'),
        0,
        '相同版本应相等',
      )
    })

    it('应该在任一版本无法解析时返回 null', () => {
      assertEqual(
        compareVersions('invalid', '7.0.0'),
        null,
        '第一个版本无效应返回 null',
      )
      assertEqual(
        compareVersions('7.0.0', 'invalid'),
        null,
        '第二个版本无效应返回 null',
      )
      assertEqual(
        compareVersions('invalid', 'also-invalid'),
        null,
        '两个版本都无效应返回 null',
      )
      assertEqual(
        compareVersions('', '7.0.0'),
        null,
        '第一个版本为空应返回 null',
      )
    })
  })

  describe('isVersionCompatible (备份/恢复)', () => {
    it('应该在相同主版本时兼容', () => {
      const result = isVersionCompatible('7.2.4', '7.0.0')
      assert(result.compatible, '7.2.4 备份应能恢复到 7.0.0 服务器')
    })

    it('应该在恢复到更新版本时兼容（升级）', () => {
      const result = isVersionCompatible('6.2.0', '7.0.0')
      assert(result.compatible, '6.2.0 备份应能恢复到 7.0.0 服务器')
      assert(result.warning !== undefined, '应有升级警告')
    })

    it('应该在备份来自更新主版本时不兼容', () => {
      const result = isVersionCompatible('7.0.0', '6.0.0')
      assert(
        !result.compatible,
        '7.0.0 备份不应能恢复到 6.0.0 服务器',
      )
    })

    it('应该对无效版本兼容但带有警告', () => {
      // 函数对无法解析的版本返回 compatible: true 并带有警告
      const result = isVersionCompatible('invalid', '7.0.0')
      assert(result.compatible, '应兼容但带有警告')
      assert(
        result.warning !== undefined,
        '应对无效版本有警告',
      )
    })
  })
})
