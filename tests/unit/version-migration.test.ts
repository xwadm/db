import { describe, it } from 'node:test'
import {
  getMajorVersion,
  getDocumentDBMajorVersion,
  isVersionSupported,
  isDocumentDBVersionSupported,
  getTargetVersion,
  getDocumentDBTargetVersion,
} from '../../core/version-migration'
import { isTestContainer } from '../../core/test-cleanup'
import { Engine } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

describe('版本迁移', () => {
  describe('获取主版本', () => {
    describe('PostgreSQL（一位数主版本）', () => {
      it('应从完整版本中提取主版本', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '17.2.0')
        assertEqual(major, '17', '应提取主版本 17')
      })

      it('应从 15.x 版本中提取主版本', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '15.15.0')
        assertEqual(major, '15', '应提取主版本 15')
      })

      it('不支持的主版本应返回 null', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '12.0.0')
        assertNullish(major, 'PostgreSQL 12 不受支持')
      })
    })

    describe('MySQL（两部分主版本）', () => {
      it('应提取主版本 8.4', () => {
        const major = getMajorVersion(Engine.MySQL, '8.4.3')
        assertEqual(major, '8.4', '应提取主版本 8.4')
      })

      it('应提取主版本 8.0', () => {
        const major = getMajorVersion(Engine.MySQL, '8.0.40')
        assertEqual(major, '8.0', '应提取主版本 8.0')
      })

      it('应提取主版本 9.1', () => {
        const major = getMajorVersion(Engine.MySQL, '9.1.0')
        assertEqual(major, '9.1', '应提取主版本 9.1')
      })
    })

    describe('MariaDB（两部分主版本）', () => {
      it('应提取主版本 10.11', () => {
        const major = getMajorVersion(Engine.MariaDB, '10.11.15')
        assertEqual(major, '10.11', '应提取主版本 10.11')
      })

      it('应提取主版本 11.8', () => {
        const major = getMajorVersion(Engine.MariaDB, '11.8.5')
        assertEqual(major, '11.8', '应提取主版本 11.8')
      })
    })

    describe('MongoDB（两部分主版本）', () => {
      it('应提取主版本 8.0', () => {
        const major = getMajorVersion(Engine.MongoDB, '8.0.17')
        assertEqual(major, '8.0', '应提取主版本 8.0')
      })

      it('应提取主版本 7.0', () => {
        const major = getMajorVersion(Engine.MongoDB, '7.0.28')
        assertEqual(major, '7.0', '应提取主版本 7.0')
      })
    })

    describe('Redis（一位数主版本）', () => {
      it('应提取主版本 7', () => {
        const major = getMajorVersion(Engine.Redis, '7.4.7')
        assertEqual(major, '7', '应提取主版本 7')
      })

      it('应提取主版本 8', () => {
        const major = getMajorVersion(Engine.Redis, '8.4.0')
        assertEqual(major, '8', '应提取主版本 8')
      })
    })

    describe('ClickHouse（YY.MM 主版本）', () => {
      it('应提取主版本 25.12', () => {
        const major = getMajorVersion(Engine.ClickHouse, '25.12.3.21')
        assertEqual(major, '25.12', '应提取主版本 25.12')
      })
    })

    describe('Qdrant/Meilisearch（一位数主版本）', () => {
      it('Qdrant 应提取主版本 1', () => {
        const major = getMajorVersion(Engine.Qdrant, '1.16.3')
        assertEqual(major, '1', '应提取主版本 1')
      })

      it('Meilisearch 应提取主版本 1', () => {
        const major = getMajorVersion(Engine.Meilisearch, '1.33.1')
        assertEqual(major, '1', '应提取主版本 1')
      })
    })
  })

  describe('获取 DocumentDB 主版本', () => {
    it('应从 DocumentDB 版本中提取主版本', () => {
      const major = getDocumentDBMajorVersion('17-0.107.0')
      assertEqual(major, '17', '应提取主版本 17')
    })

    it('无效格式应返回 null', () => {
      const major = getDocumentDBMajorVersion('invalid')
      assertNullish(major, '无效格式应返回 null')
    })

    it('不支持的主版本应返回 null', () => {
      const major = getDocumentDBMajorVersion('16-0.107.0')
      assertNullish(major, 'PostgreSQL 16 后端不受支持')
    })
  })

  describe('isVersionSupported', () => {
    it('对版本映射中当前的 PostgreSQL 版本应返回 true', () => {
      // 获取 PostgreSQL 17 的当前目标版本
      const targetVersion = getTargetVersion(Engine.PostgreSQL, '17')
      assert(targetVersion !== null, 'PostgreSQL 17 应有目标版本')
      const supported = isVersionSupported(Engine.PostgreSQL, targetVersion!)
      assert(supported, `PostgreSQL ${targetVersion} 应受支持`)
    })

    it('对已过时的 PostgreSQL 版本应返回 false', () => {
      // 使用一个肯定不存在于版本映射中的版本
      const supported = isVersionSupported(Engine.PostgreSQL, '17.0.1')
      assert(!supported, 'PostgreSQL 17.0.1 不应受支持（不在版本映射中）')
    })

    it('对版本映射中当前的 MySQL 版本应返回 true', () => {
      // 获取 MySQL 8.4 的当前目标版本
      const targetVersion = getTargetVersion(Engine.MySQL, '8.4')
      assert(targetVersion !== null, 'MySQL 8.4 应有目标版本')
      const supported = isVersionSupported(Engine.MySQL, targetVersion!)
      assert(supported, `MySQL ${targetVersion} 应受支持`)
    })

    it('对已过时的 MySQL 版本应返回 false', () => {
      // 使用一个肯定不存在于版本映射中的版本
      const supported = isVersionSupported(Engine.MySQL, '8.4.0')
      assert(!supported, 'MySQL 8.4.0 不应受支持（不在版本映射中）')
    })

    it('对版本映射中当前的 Redis 版本应返回 true', () => {
      // 获取 Redis 7 的当前目标版本
      const targetVersion = getTargetVersion(Engine.Redis, '7')
      assert(targetVersion !== null, 'Redis 7 应有目标版本')
      const supported = isVersionSupported(Engine.Redis, targetVersion!)
      assert(supported, `Redis ${targetVersion} 应受支持`)
    })

    it('对已过时的 Redis 版本应返回 false', () => {
      // 使用一个肯定不存在于版本映射中的版本
      const supported = isVersionSupported(Engine.Redis, '7.0.0')
      assert(!supported, 'Redis 7.0.0 不应受支持（不在版本映射中）')
    })
  })

  describe('isDocumentDBVersionSupported', () => {
    it('对版本映射中当前的 DocumentDB 版本应返回 true', () => {
      // 获取 DocumentDB 17 的当前目标版本
      const targetVersion = getDocumentDBTargetVersion('17')
      assert(targetVersion !== null, 'DocumentDB 17 应有目标版本')
      const supported = isDocumentDBVersionSupported(targetVersion!)
      assert(supported, `DocumentDB ${targetVersion} 应受支持`)
    })

    it('对已过时的 DocumentDB 版本应返回 false', () => {
      // 使用一个肯定不存在于版本映射中的版本
      const supported = isDocumentDBVersionSupported('17-0.1.0')
      assert(!supported, 'DocumentDB 17-0.1.0 不应受支持（不在版本映射中）')
    })
  })

  describe('getTargetVersion', () => {
    it('PostgreSQL 主版本 17 应返回有效的目标版本', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '17')
      assert(target !== null, 'PostgreSQL 17 应有目标版本')
      assert(target!.startsWith('17.'), `目标版本 ${target} 应以 17. 开头`)
    })

    it('PostgreSQL 主版本 16 应返回有效的目标版本', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '16')
      assert(target !== null, 'PostgreSQL 16 应有目标版本')
      assert(target!.startsWith('16.'), `目标版本 ${target} 应以 16. 开头`)
    })

    it('MySQL 主版本 8.4 应返回有效的目标版本', () => {
      const target = getTargetVersion(Engine.MySQL, '8.4')
      assert(target !== null, 'MySQL 8.4 应有目标版本')
      assert(target!.startsWith('8.4.'), `目标版本 ${target} 应以 8.4. 开头`)
    })

    it('MySQL 主版本 8.0 应返回有效的目标版本', () => {
      const target = getTargetVersion(Engine.MySQL, '8.0')
      assert(target !== null, 'MySQL 8.0 应有目标版本')
      assert(target!.startsWith('8.0.'), `目标版本 ${target} 应以 8.0. 开头`)
    })

    it('Redis 主版本 7 应返回有效的目标版本', () => {
      const target = getTargetVersion(Engine.Redis, '7')
      assert(target !== null, 'Redis 7 应有目标版本')
      assert(target!.startsWith('7.'), `目标版本 ${target} 应以 7. 开头`)
    })

    it('不支持的主版本应返回 null', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '12')
      assertNullish(target, 'PostgreSQL 12 不受支持')
    })
  })

  describe('getDocumentDBTargetVersion', () => {
    it('DocumentDB 主版本 17 应返回有效的目标版本', () => {
      const target = getDocumentDBTargetVersion('17')
      assert(target !== null, 'DocumentDB 17 应有目标版本')
      assert(target!.startsWith('17-'), `目标版本 ${target} 应以 17- 开头`)
    })

    it('不支持的主版本应返回 null', () => {
      const target = getDocumentDBTargetVersion('16')
      assertNullish(target, 'DocumentDB 16 不受支持')
    })
  })
})

describe('测试容器检测模式', () => {
  // 使用从 core/test-cleanup.ts 导入的 isTestContainer
  // 来验证生产环境模式是否与预期的测试容器名称匹配

  it('应匹配模式：name-test_<hex>', () => {
    assert(
      isTestContainer('duckdb-test_04b0613f'),
      '应匹配 duckdb-test_04b0613f',
    )
    assert(
      isTestContainer('postgres-test_abcd1234'),
      '应匹配 postgres-test_abcd1234',
    )
    assert(
      isTestContainer('mysql-test_AABBCC'),
      '应匹配 mysql-test_AABBCC（不区分大小写）',
    )
  })

  it('应匹配模式：name-test-suffix_<hex>', () => {
    assert(
      isTestContainer('ferretdb-test-conflict_21e4d447'),
      '应匹配 ferretdb-test-conflict_21e4d447',
    )
    assert(
      isTestContainer('postgres-test-backup_12345678'),
      '应匹配 postgres-test-backup_12345678',
    )
  })

  it('应匹配模式：name-test-renamed_<hex>', () => {
    assert(
      isTestContainer('mysql-test-renamed_1862f018'),
      '应匹配 mysql-test-renamed_1862f018',
    )
    assert(
      isTestContainer('duckdb-test-renamed-80a8a099'),
      '应匹配 duckdb-test-renamed-80a8a099',
    )
  })

  it('不应匹配常规容器名称', () => {
    assert(!isTestContainer('myapp'), '不应匹配 myapp')
    assert(!isTestContainer('production-db'), '不应匹配 production-db')
    assert(!isTestContainer('test-app'), '不应匹配 test-app（无十六进制后缀）')
    assert(!isTestContainer('dev-test'), '不应匹配 dev-test（无十六进制后缀）')
  })

  it('不应匹配过短的十六进制后缀', () => {
    assert(
      !isTestContainer('db-test_abc'),
      '不应匹配 db-test_abc（十六进制太短）',
    )
    assert(
      !isTestContainer('db-test_12345'),
      '不应匹配 db-test_12345（十六进制太短）',
    )
  })
})
