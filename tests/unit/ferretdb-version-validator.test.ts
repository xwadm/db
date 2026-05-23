/**
 * FerretDB 版本验证器的单元测试
 */

import { describe, it } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
  normalizeVersion,
  normalizeDocumentDBVersion,
  getFullVersion,
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  SUPPORTED_MAJOR_VERSIONS,
  isV1,
} from '../../engines/ferretdb/version-maps'

describe('FerretDB Version Maps', () => {
  describe('FERRETDB_VERSION_MAP', () => {
    it('应包含主版本 2', () => {
      assert(FERRETDB_VERSION_MAP['2'] !== undefined, '应有版本 2')
    })

    it('应将主版本映射到完整版本', () => {
      const fullVersion = FERRETDB_VERSION_MAP['2']
      assert(fullVersion.startsWith('2.'), '完整版本应以 2. 开头')
    })

    it('完整版本应映射到自身', () => {
      // 动态查找完整版本键（x.y.z 格式）
      const fullVersionKey = Object.keys(FERRETDB_VERSION_MAP).find((key) =>
        /^\d+\.\d+\.\d+$/.test(key),
      )
      assert(
        fullVersionKey !== undefined,
        '应至少有一个完整版本键',
      )
      assertEqual(
        FERRETDB_VERSION_MAP[fullVersionKey!],
        fullVersionKey,
        '完整版本应映射到自身',
      )
    })
  })

  describe('DOCUMENTDB_VERSION_MAP', () => {
    it('应包含 PostgreSQL 17 后端', () => {
      assert(
        DOCUMENTDB_VERSION_MAP['17'] !== undefined,
        '应有 PostgreSQL 17 后端',
      )
    })

    it('应将主版本映射到完整版本', () => {
      const fullVersion = DOCUMENTDB_VERSION_MAP['17']
      assert(
        fullVersion.startsWith('17-'),
        '完整版本应以 17- 开头',
      )
    })
  })

  describe('normalizeVersion', () => {
    it('给定主版本时应返回完整版本', () => {
      const result = normalizeVersion('2')
      assert(
        result.startsWith('2.'),
        '应返回以 2. 开头的完整版本',
      )
    })

    it('给定完整版本时应返回相同版本', () => {
      const result = normalizeVersion('2.7.0')
      assertEqual(result, '2.7.0', '应返回相同版本')
    })

    it('未知版本应原样返回', () => {
      const result = normalizeVersion('99')
      // 未知版本原样返回（可能导致下载失败）
      assertEqual(
        result,
        '99',
        '未知版本应原样返回输入',
      )
    })
  })

  describe('normalizeDocumentDBVersion', () => {
    it('应规范化 PostgreSQL 主版本号', () => {
      const result = normalizeDocumentDBVersion('17')
      assert(
        result.startsWith('17-'),
        '应返回以 17- 开头的完整版本',
      )
    })

    it('完整版本应返回相同版本', () => {
      const result = normalizeDocumentDBVersion('17-0.107.0')
      assertEqual(result, '17-0.107.0', '应返回相同版本')
    })
  })

  describe('getFullVersion', () => {
    it('给定主版本时应返回完整版本', () => {
      const result = getFullVersion('2')
      assert(result !== null, '应返回一个版本')
      assert(result!.startsWith('2.'), '应以 2. 开头')
    })

    it('未知版本应返回 null', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, '未知版本应返回 null')
    })
  })

  describe('DEFAULT_DOCUMENTDB_VERSION', () => {
    it('应为有效的版本字符串', () => {
      assert(
        DEFAULT_DOCUMENTDB_VERSION.includes('-'),
        '应包含连字符以分隔 PG 版本和 DocumentDB 版本',
      )
    })

    it('应以 PostgreSQL 17 开头', () => {
      assert(
        DEFAULT_DOCUMENTDB_VERSION.startsWith('17-'),
        '应以 17- 开头',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('应包含版本 1', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('1'),
        '应包含主版本 1',
      )
    })

    it('应包含版本 2', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('2'),
        '应包含主版本 2',
      )
    })

    it('应为非空数组', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        '应至少有一个版本',
      )
    })
  })

  describe('isV1', () => {
    it('主版本 1 应返回 true', () => {
      assert(isV1('1'), 'isV1("1") 应为 true')
    })

    it('完整 v1 版本应返回 true', () => {
      assert(isV1('1.24.2'), 'isV1("1.24.2") 应为 true')
    })

    it('主版本 2 应返回 false', () => {
      assert(!isV1('2'), 'isV1("2") 应为 false')
    })

    it('完整 v2 版本应返回 false', () => {
      assert(!isV1('2.7.0'), 'isV1("2.7.0") 应为 false')
    })
  })

  describe('FERRETDB_VERSION_MAP v1 entries', () => {
    it('应包含主版本 1', () => {
      assert(FERRETDB_VERSION_MAP['1'] !== undefined, '应有版本 1')
    })

    it('应将主版本 1 映射到 1.x 完整版本', () => {
      const fullVersion = FERRETDB_VERSION_MAP['1']
      assert(fullVersion.startsWith('1.'), '完整版本应以 1. 开头')
    })
  })

  describe('DEFAULT_V1_POSTGRESQL_VERSION', () => {
    it('应为数字主版本字符串', () => {
      assert(
        /^\d+$/.test(DEFAULT_V1_POSTGRESQL_VERSION),
        '应为数字主版本（例如 "17"）',
      )
    })
  })
})
