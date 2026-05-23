/**
 * 版本迁移单元测试
 * 
 * 测试版本检测和迁移逻辑，包括各种数据库引擎的版本解析和测试容器检测。
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  getMajorVersion,
  isTestContainer,
  parseDocumentDBVersion,
} from '../../core/version-migration'
import { Engine } from '../../types'

describe('版本迁移', () => {
  describe('getMajorVersion', () => {
    it('应该为 PostgreSQL 提取主版本', () => {
      assertEqual(getMajorVersion('17.7.0', Engine.PostgreSQL), '17', 'PostgreSQL 应该提取 17')
      assertEqual(getMajorVersion('16.4.0', Engine.PostgreSQL), '16', 'PostgreSQL 应该提取 16')
    })

    it('应该为 MySQL 提取主版本', () => {
      assertEqual(getMajorVersion('8.0.33', Engine.MySQL), '8', 'MySQL 应该提取 8')
      assertEqual(getMajorVersion('5.7.42', Engine.MySQL), '5', 'MySQL 应该提取 5')
    })

    it('应该为 MongoDB 提取主版本', () => {
      assertEqual(getMajorVersion('7.0.5', Engine.MongoDB), '7', 'MongoDB 应该提取 7')
      assertEqual(getMajorVersion('6.0.12', Engine.MongoDB), '6', 'MongoDB 应该提取 6')
    })

    it('应该为 Redis 提取主版本', () => {
      assertEqual(getMajorVersion('7.2.4', Engine.Redis), '7', 'Redis 应该提取 7')
      assertEqual(getMajorVersion('6.2.14', Engine.Redis), '6', 'Redis 应该提取 6')
    })

    it('应该为 DocumentDB 提取主版本', () => {
      // DocumentDB 版本格式: "17-0.107.0" (PostgreSQL 兼容版本-DocumentDB 版本)
      assertEqual(getMajorVersion('17-0.107.0', Engine.DocumentDB), '17', 'DocumentDB 应该提取 17')
      assertEqual(getMajorVersion('16-0.100.0', Engine.DocumentDB), '16', 'DocumentDB 应该提取 16')
    })

    it('应该为 Valkey 提取主版本', () => {
      assertEqual(getMajorVersion('7.2.5', Engine.Valkey), '7', 'Valkey 应该提取 7')
    })

    it('应该为 TigerBeetle 提取主版本', () => {
      assertEqual(getMajorVersion('0.16.3', Engine.TigerBeetle), '0', 'TigerBeetle 应该提取 0')
    })

    it('应该为 TypeDB 提取主版本', () => {
      assertEqual(getMajorVersion('2.26.6', Engine.TypeDB), '2', 'TypeDB 应该提取 2')
    })

    it('应该为 Weaviate 提取主版本', () => {
      assertEqual(getMajorVersion('1.35.7', Engine.Weaviate), '1', 'Weaviate 应该提取 1')
    })
  })

  describe('isTestContainer', () => {
    it('应该通过容器名称检测测试容器', () => {
      assert(isTestContainer({ name: 'spindb-test-postgres-123' }), '应该检测 spindb-test 前缀')
      assert(isTestContainer({ name: 'test-mysql-456' }), '应该检测 test- 前缀')
      assert(isTestContainer({ name: 'spindb-testcontainer-redis' }), '应该检测 testcontainer')
    })

    it('应该通过标签检测测试容器', () => {
      assert(isTestContainer({ labels: { 'spindb.test': 'true' } }), '应该检测 spindb.test 标签')
      assert(isTestContainer({ labels: { 'testcontainer': 'true' } }), '应该检测 testcontainer 标签')
    })

    it('应该通过环境变量检测测试容器', () => {
      assert(isTestContainer({ env: { 'SPINDB_TEST': '1' } }), '应该检测 SPINDB_TEST 环境变量')
      assert(isTestContainer({ env: { 'TESTCONTAINER': 'true' } }), '应该检测 TESTCONTAINER 环境变量')
    })

    it('不应该将生产容器识别为测试容器', () => {
      assert(!isTestContainer({ name: 'production-postgres' }), '不应该检测生产容器')
      assert(!isTestContainer({ name: 'myapp-database' }), '不应该检测应用数据库')
      assert(!isTestContainer({ labels: {} }), '空标签不应该被检测')
    })

    it('应该处理复合检测条件', () => {
      assert(
        isTestContainer({
          name: 'myapp-db',
          labels: { 'spindb.test': 'true' },
        }),
        '标签应该优先于名称'
      )
    })
  })

  describe('parseDocumentDBVersion', () => {
    it('应该解析 DocumentDB 复合版本', () => {
      const parsed = parseDocumentDBVersion('17-0.107.0')
      assertEqual(parsed.postgresVersion, '17', '应该提取 PostgreSQL 版本 17')
      assertEqual(parsed.documentDBVersion, '0.107.0', '应该提取 DocumentDB 版本 0.107.0')
    })

    it('应该解析不同格式的 DocumentDB 版本', () => {
      const parsed = parseDocumentDBVersion('16-0.100.0')
      assertEqual(parsed.postgresVersion, '16', '应该提取 PostgreSQL 版本 16')
      assertEqual(parsed.documentDBVersion, '0.100.0', '应该提取 DocumentDB 版本 0.100.0')
    })

    it('应该对无效格式返回 null', () => {
      const parsed = parseDocumentDBVersion('invalid')
      assertEqual(parsed, null, '无效格式应该返回 null')
    })

    it('应该对标准 PostgreSQL 版本返回 null', () => {
      const parsed = parseDocumentDBVersion('17.7.0')
      assertEqual(parsed, null, '标准 PostgreSQL 版本应该返回 null')
    })
  })

  describe('版本比较', () => {
    it('应该正确比较 PostgreSQL 版本', () => {
      const v1 = getMajorVersion('17.7.0', Engine.PostgreSQL)
      const v2 = getMajorVersion('16.4.0', Engine.PostgreSQL)
      assert(parseInt(v1!) > parseInt(v2!), '17 应该大于 16')
    })

    it('应该正确比较 DocumentDB 版本', () => {
      const v1 = getMajorVersion('17-0.107.0', Engine.DocumentDB)
      const v2 = getMajorVersion('16-0.100.0', Engine.DocumentDB)
      assert(parseInt(v1!) > parseInt(v2!), '17 应该大于 16')
    })
  })
})
