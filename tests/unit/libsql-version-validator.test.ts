/**
 * libSQL 版本验证器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  LIBSQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  getFullVersion,
  normalizeVersion,
} from '../../engines/libsql/version-maps'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  getMajorMinorVersion,
  compareVersions,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/libsql/version-validator'

describe('libSQL Version Maps', () => {
  describe('LIBSQL_VERSION_MAP', () => {
    it('应包含主版本 0', () => {
      assert(LIBSQL_VERSION_MAP['0'] !== undefined, '应有版本 0')
    })

    it('主版本应映射到完整版本', () => {
      const fullVersion = LIBSQL_VERSION_MAP['0']
      assert(fullVersion.startsWith('0.'), '完整版本应以 0. 开头')
    })

    it('完整版本应有恒等映射', () => {
      const fullVersionKey = Object.keys(LIBSQL_VERSION_MAP).find((key) =>
        /^\d+\.\d+\.\d+$/.test(key),
      )
      assert(
        fullVersionKey !== undefined,
        '应至少有一个完整版本键',
      )
      assertEqual(
        LIBSQL_VERSION_MAP[fullVersionKey!],
        fullVersionKey,
        '完整版本应映射到自身',
      )
    })

    it('major.minor 应映射到完整版本', () => {
      const result = LIBSQL_VERSION_MAP['0.24']
      assert(result !== undefined, '应有 0.24 映射')
      assert(result.startsWith('0.24.'), '应映射到 0.24.x 版本')
    })
  })

  describe('normalizeVersion', () => {
    it('给定主版本时应返回完整版本', () => {
      const result = normalizeVersion('0')
      assert(
        result.startsWith('0.'),
        '应返回以 0. 开头的完整版本',
      )
    })

    it('给定 major.minor 版本时应返回完整版本', () => {
      const result = normalizeVersion('0.24')
      assert(
        result.startsWith('0.24.'),
        '应返回以 0.24. 开头的完整版本',
      )
    })

    it('给定完整版本时应返回相同版本', () => {
      const result = normalizeVersion('0.24.32')
      assertEqual(result, '0.24.32', '应返回相同版本')
    })

    it('未知版本应保持不变', () => {
      const result = normalizeVersion('99')
      assertEqual(
        result,
        '99',
        '未知版本应保持输入不变',
      )
    })

    it('无效格式应保持不变', () => {
      const result = normalizeVersion('invalid')
      assertEqual(
        result,
        'invalid',
        '无效格式应保持输入不变',
      )
    })
  })

  describe('getFullVersion', () => {
    it('主版本应返回完整版本', () => {
      const result = getFullVersion('0')
      assert(result !== null, '应返回版本')
      assert(result!.startsWith('0.'), '应以 0. 开头')
    })

    it('major.minor 版本应返回完整版本', () => {
      const result = getFullVersion('0.24')
      assert(result !== null, '应返回版本')
      assert(result!.startsWith('0.24.'), '应以 0.24. 开头')
    })

    it('精确版本应返回完整版本', () => {
      const result = getFullVersion('0.24.32')
      assertEqual(result, '0.24.32', '应返回精确版本')
    })

    it('未知版本应返回 null', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, '未知版本应返回 null')
    })

    it('未映射的 major.minor 版本应返回 null', () => {
      const result = getFullVersion('0.99')
      assertEqual(
        result,
        null,
        '未映射的 major.minor 版本应返回 null',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('应包含版本 0', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('0'),
        '应包含主版本 0',
      )
    })

    it('应为非空数组', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        '应至少有一个版本',
      )
    })
  })
})

describe('libSQL Version Validator', () => {
  describe('parseVersion', () => {
    it('应解析完整版本字符串', () => {
      const parsed = parseVersion('0.24.32')
      assert(parsed !== null, '应解析版本')
      assertEqual(parsed!.major, 0, 'Major 应为 0')
      assertEqual(parsed!.minor, 24, 'Minor 应为 24')
      assertEqual(parsed!.patch, 32, 'Patch 应为 32')
      assertEqual(parsed!.raw, '0.24.32', 'Raw 应为 0.24.32')
    })

    it('应解析带 v 前缀的版本', () => {
      const parsed = parseVersion('v0.24.32')
      assert(parsed !== null, '应解析带 v 前缀的版本')
      assertEqual(parsed!.major, 0, 'Major 应为 0')
      assertEqual(parsed!.minor, 24, 'Minor 应为 24')
      assertEqual(parsed!.patch, 32, 'Patch 应为 32')
    })

    it('应解析 major.minor 版本', () => {
      const parsed = parseVersion('0.24')
      assert(parsed !== null, '应解析 major.minor')
      assertEqual(parsed!.major, 0, 'Major 应为 0')
      assertEqual(parsed!.minor, 24, 'Minor 应为 24')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('应仅解析主版本', () => {
      const parsed = parseVersion('1')
      assert(parsed !== null, '应解析仅主版本')
      assertEqual(parsed!.major, 1, 'Major 应为 1')
      assertEqual(parsed!.minor, 0, 'Minor 应默认为 0')
      assertEqual(parsed!.patch, 0, 'Patch 应默认为 0')
    })

    it('无效版本应返回 null', () => {
      assertEqual(parseVersion('invalid'), null, '应返回 null')
    })

    it('空字符串应返回 null', () => {
      assertEqual(parseVersion(''), '空字符串应返回 null')
    })
  })

  describe('isVersionSupported', () => {
    it('应支持版本 0.24.x', () => {
      assert(isVersionSupported('0.24.32'), '0.24.32 应被支持')
      assert(isVersionSupported('0.24.0'), '0.24.0 应被支持')
    })

    it('应支持未来的 minor 版本', () => {
      assert(isVersionSupported('0.25.0'), '0.25.0 应被支持')
    })

    it('应支持未来的 major 版本', () => {
      assert(isVersionSupported('1.0.0'), '1.0.0 应被支持')
    })

    it('不应支持版本 0.23.x 及以下', () => {
      assert(!isVersionSupported('0.23.0'), '0.23.0 不应被支持')
      assert(!isVersionSupported('0.1.0'), '0.1.0 不应被支持')
    })
  })

  describe('getMajorVersion', () => {
    it('应提取主版本', () => {
      assertEqual(getMajorVersion('0.24.32'), '0', '应提取 0')
      assertEqual(getMajorVersion('1.0.0'), '1', '应提取 1')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('应提取 major.minor 版本', () => {
      assertEqual(
        getMajorMinorVersion('0.24.32'),
        '0.24',
        '应提取 0.24',
      )
    })
  })

  describe('compareVersions', () => {
    it('应比较相同版本', () => {
      assertEqual(compareVersions('0.24.32', '0.24.32'), 0, '相同版本')
    })

    it('应比较不同的 major 版本', () => {
      assertEqual(compareVersions('0.24.32', '1.0.0'), -1, '0.x < 1.x')
      assertEqual(compareVersions('1.0.0', '0.24.32'), 1, '1.x > 0.x')
    })

    it('应比较不同的 minor 版本', () => {
      assertEqual(compareVersions('0.23.0', '0.24.0'), -1, '0.23 < 0.24')
      assertEqual(compareVersions('0.24.0', '0.23.0'), 1, '0.24 > 0.23')
    })

    it('应比较不同的 patch 版本', () => {
      assertEqual(compareVersions('0.24.31', '0.24.32'), -1, '.31 < .32')
      assertEqual(compareVersions('0.24.32', '0.24.31'), 1, '.32 > .31')
    })

    it('无效版本应返回 null', () => {
      assertEqual(compareVersions('invalid', '0.24.32'), null, '第一个无效')
      assertEqual(compareVersions('0.24.32', 'invalid'), null, '第二个无效')
    })
  })

  describe('isVersionCompatible', () => {
    it('相同版本应兼容', () => {
      const result = isVersionCompatible('0.24.32', '0.24.32')
      assert(result.compatible, '相同版本应兼容')
      assertEqual(result.warning, undefined, '不应有警告')
    })

    it('从旧 major 版本升级时应发出警告', () => {
      const result = isVersionCompatible('0.24.32', '1.0.0')
      assert(result.compatible, '应兼容')
      assert(result.warning !== undefined, '应有警告')
    })

    it('降级 major 版本时不应兼容', () => {
      const result = isVersionCompatible('1.0.0', '0.24.32')
      assert(!result.compatible, '不应兼容')
    })
  })

  describe('isValidVersionFormat', () => {
    it('应验证正确格式', () => {
      assert(isValidVersionFormat('0.24.32'), '完整版本应有效')
      assert(isValidVersionFormat('0.24'), 'major.minor 应有效')
      assert(isValidVersionFormat('1'), '仅主版本应有效')
    })

    it('应拒绝无效格式', () => {
      assert(!isValidVersionFormat('invalid'), '文本应无效')
      assert(!isValidVersionFormat(''), '空字符串应无效')
    })
  })
})
