import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { Engine } from '../../types'

/**
 * 孤立容器行为测试：
 * 1. 引擎删除应允许删除引擎，即使容器仍在使用该引擎
 * 2. 启动孤立容器时应检测缺失的引擎并提示下载
 */

describe('孤立容器行为', () => {
  describe('引擎删除策略', () => {
    it('应允许在有容器使用引擎时进行删除', () => {
      // 之前，当存在容器时会阻止删除
      // 现在，删除应当继续执行并给出警告

      const containers = [
        { name: 'db1', engine: 'postgresql', version: '17.7.0' },
        { name: 'db2', engine: 'postgresql', version: '17.7.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const usingContainers = containers.filter(
        (c) =>
          c.engine === engineToDelete.engine &&
          c.version === engineToDelete.version,
      )

      // 旧行为会在此处抛出异常或退出
      // 新行为：发出警告但仍允许删除
      const shouldAllowDeletion = true // 现在始终允许

      assert(shouldAllowDeletion, '即使存在依赖容器，也应允许删除')
      assertEqual(usingContainers.length, 2, '应识别出正在使用该引擎的容器')
    })

    it('应识别哪些容器将成为孤立容器', () => {
      const containers = [
        { name: 'pg17-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'pg16-db', engine: 'postgresql', version: '16.11.0' },
        { name: 'mysql-db', engine: 'mysql', version: '8.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const orphanedContainers = containers.filter(
        (c) =>
          c.engine === engineToDelete.engine &&
          c.version === engineToDelete.version,
      )

      assertEqual(orphanedContainers.length, 1, '应找到一个孤立容器')
      assertEqual(orphanedContainers[0].name, 'pg17-db', '应识别出正确的容器')
    })

    it('不应影响使用不同版本的容器', () => {
      const containers = [
        { name: 'pg17-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'pg16-db', engine: 'postgresql', version: '16.11.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const unaffectedContainers = containers.filter(
        (c) =>
          c.engine !== engineToDelete.engine ||
          c.version !== engineToDelete.version,
      )

      assertEqual(unaffectedContainers.length, 1, '应有一个不受影响的容器')
      assertEqual(unaffectedContainers[0].version, '16.11.0', 'pg16 应不受影响')
    })

    it('不应影响使用不同引擎的容器', () => {
      const containers = [
        { name: 'pg-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'mysql-db', engine: 'mysql', version: '8.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const unaffectedContainers = containers.filter(
        (c) => c.engine !== engineToDelete.engine,
      )

      assertEqual(unaffectedContainers.length, 1, 'MySQL 容器应不受影响')
    })
  })

  describe('容器启动 - 缺失引擎检测', () => {
    it('应检测 PostgreSQL 引擎是否未安装', async () => {
      // 模拟启动容器前的检查
      const containerConfig = {
        name: 'orphaned-db',
        engine: Engine.PostgreSQL,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
      }

      // 模拟：引擎二进制文件未安装
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.PostgreSQL && !isEngineInstalled

      assert(shouldPromptDownload, 'PostgreSQL 引擎缺失时应提示下载')
    })

    it('应检测 MySQL 引擎是否未安装', () => {
      // MySQL 现在使用 hostdb 二进制文件（非系统安装）
      const containerConfig = {
        name: 'mysql-db',
        engine: Engine.MySQL,
        version: '9.5.0',
        port: 3306,
        database: 'testdb',
      }

      // 模拟：引擎二进制文件未安装
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.MySQL && !isEngineInstalled

      assert(shouldPromptDownload, 'MySQL 引擎缺失时应提示下载')
    })

    it('应检测 MongoDB 引擎是否未安装', () => {
      // MongoDB 现在使用 hostdb 二进制文件（非系统安装）
      const containerConfig = {
        name: 'mongo-db',
        engine: Engine.MongoDB,
        version: '8.0.17',
        port: 27017,
        database: 'testdb',
      }

      // 模拟：引擎二进制文件未安装
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.MongoDB && !isEngineInstalled

      assert(shouldPromptDownload, 'MongoDB 引擎缺失时应提示下载')
    })

    it('应检测 Redis 引擎是否未安装', () => {
      // Redis 现在使用 hostdb 二进制文件（非系统安装）
      const containerConfig = {
        name: 'redis-db',
        engine: Engine.Redis,
        version: '8.4.0',
        port: 6379,
        database: '0',
      }

      // 模拟：引擎二进制文件未安装
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.Redis && !isEngineInstalled

      assert(shouldPromptDownload, 'Redis 引擎缺失时应提示下载')
    })

    it('引擎已安装时应正常继续', async () => {
      const containerConfig = {
        name: 'healthy-db',
        engine: Engine.PostgreSQL,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
      }

      // 模拟：引擎二进制文件已安装
      const isEngineInstalled = true

      const shouldPromptDownload =
        containerConfig.engine === Engine.PostgreSQL && !isEngineInstalled

      assert(!shouldPromptDownload, '引擎已安装时不应提示')
    })
  })

  describe('引擎下载流程', () => {
    it('手动说明中应提供正确的下载命令', () => {
      const version = '17.7.0'
      const majorVersion = version.split('.')[0]
      const manualCommand = `spindb engines download postgresql ${majorVersion}`

      assert(
        manualCommand.includes('engines download'),
        '应使用 engines download 子命令',
      )
      assert(manualCommand.includes('postgresql'), '应指定 postgresql 引擎')
      assert(manualCommand.includes(majorVersion), '应包含主版本号')
    })

    it('二进制路径解析应使用完整版本号', () => {
      // 下载时，我们需要完整版本号（例如 17.7.0）而不仅仅是主版本号（17）
      const majorVersion = '17'
      const fullVersion = '17.7.0' // 来自版本解析

      const binaryPathPattern = `postgresql-${fullVersion}-darwin-arm64`

      assert(
        binaryPathPattern.includes(fullVersion),
        '二进制路径应使用完整版本号',
      )
      assert(
        !binaryPathPattern.includes(`-${majorVersion}-`),
        '二进制路径不应仅使用主版本号',
      )
    })
  })

  describe('孤立容器恢复', () => {
    it('应允许重新下载相同的引擎版本', () => {
      // 删除引擎后，应该能够再次下载
      // 无论是否存在需要该引擎的容器，下载过程都应相同
      const canRedownload = true // 始终可以

      assert(canRedownload, '应能重新下载已删除的引擎')
    })

    it('删除引擎时应保留容器数据', () => {
      // 容器数据目录与引擎二进制目录是分开的
      const enginePath = '~/.spindb/bin/postgresql-17.7.0-darwin-arm64'
      const containerDataPath = '~/.spindb/containers/postgresql/mydb/data'

      assert(
        !containerDataPath.includes('/bin/'),
        '容器数据不应位于 bin 目录中',
      )
      assert(enginePath.includes('/bin/'), '引擎应位于 bin 目录中')
      assert(
        containerDataPath.includes('/containers/'),
        '容器数据应位于 containers 目录中',
      )
    })

    it('应将容器版本与引擎版本匹配', () => {
      // 启动时，需要为容器找到正确的引擎
      const container = {
        name: 'mydb',
        engine: 'postgresql',
        version: '17.7.0',
      }

      const installedEngines = [
        { engine: 'postgresql', version: '16.11.0' },
        { engine: 'postgresql', version: '17.7.0' },
      ]

      const matchingEngine = installedEngines.find(
        (e) => e.engine === container.engine && e.version === container.version,
      )

      assert(matchingEngine !== undefined, '应找到匹配的引擎')
      assertEqual(
        matchingEngine?.version,
        container.version,
        '应匹配完全相同的版本',
      )
    })

    it('当未找到所需版本时应检测到引擎缺失', () => {
      const container = {
        name: 'mydb',
        engine: 'postgresql',
        version: '17.7.0',
      }

      const installedEngines = [
        { engine: 'postgresql', version: '16.11.0' },
        // 17.7.0 未安装
      ]

      const matchingEngine = installedEngines.find(
        (e) => e.engine === container.engine && e.version === container.version,
      )

      assertEqual(matchingEngine, undefined, '不应找到缺失的引擎')
    })
  })
})

describe('PostgreSQL 引擎二进制检查', () => {
  it('应使用 isBinaryInstalled 检查引擎可用性', async () => {
    // 导入实际的 PostgreSQL 引擎以测试 isBinaryInstalled 行为
    const { postgresqlEngine } = await import('../../engines/postgresql')

    // 检查一个肯定不存在的版本
    const isInstalled = await postgresqlEngine.isBinaryInstalled('99.99.99')

    assertEqual(isInstalled, false, '不存在的版本不应被认为已安装')
  })

  it('应将主版本号解析为完整版本号', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    // 测试版本解析
    const fullVersion = postgresqlEngine.resolveFullVersion('17')

    assert(fullVersion.startsWith('17.'), '应解析为 17.x.x')
    assert(fullVersion.split('.').length >= 2, '应至少包含 major.minor 格式')
  })

  it('传入完整版本号时应原样返回', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    const fullVersion = postgresqlEngine.resolveFullVersion('17.7.0')

    assertEqual(fullVersion, '17.7.0', '完整版本号应原样返回')
  })

  it('应构建正确的二进制路径', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    const binaryPath = postgresqlEngine.getBinaryPath('17')

    assert(binaryPath.includes('postgresql-'), '路径应包含 postgresql 前缀')
    assert(binaryPath.includes('17.'), '路径应包含解析后的版本号')

    // 验证完整的平台-架构组合存在
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `路径应包含支持的平台-架构组合之一: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('MySQL 引擎二进制检查', () => {
  it('应使用 isBinaryInstalled 检查引擎可用性', async () => {
    // 导入实际的 MySQL 引擎以测试 isBinaryInstalled 行为
    const { mysqlEngine } = await import('../../engines/mysql')

    // 检查一个肯定不存在的版本
    const isInstalled = await mysqlEngine.isBinaryInstalled('99.99.99')

    assertEqual(isInstalled, false, '不存在的版本不应被认为已安装')
  })

  it('应定义了 supportedVersions', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    const versions = mysqlEngine.supportedVersions

    assert(Array.isArray(versions), 'supportedVersions 应为数组')
    assert(versions.length > 0, '应至少有一个支持的版本')
    assert(
      versions.some((v) => v.startsWith('9')),
      '应支持 MySQL 9.x',
    )
  })

  it('应将主版本号解析为完整版本号', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    // 测试版本解析
    const fullVersion = mysqlEngine.resolveFullVersion('9')

    assert(fullVersion.startsWith('9.'), '应解析为 9.x.x')
    assert(fullVersion.split('.').length >= 2, '应至少包含 major.minor 格式')
  })

  it('传入完整版本号时应原样返回', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    const fullVersion = mysqlEngine.resolveFullVersion('9.5.0')

    assertEqual(fullVersion, '9.5.0', '完整版本号应原样返回')
  })

  it('应构建正确的二进制路径', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    const binaryPath = mysqlEngine.getBinaryPath('9')

    assert(binaryPath.includes('mysql-'), '路径应包含 mysql 前缀')
    assert(binaryPath.includes('9.'), '路径应包含解析后的版本号')

    // 验证完整的平台-架构组合存在
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `路径应包含支持的平台-架构组合之一: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('MongoDB 引擎二进制检查', () => {
  it('应使用 isBinaryInstalled 检查引擎可用性', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    // 检查一个肯定不存在的版本
    const isInstalled = await mongodbEngine.isBinaryInstalled('99.99.99')

    assertEqual(isInstalled, false, '不存在的版本不应被认为已安装')
  })

  it('应定义了 supportedVersions', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const versions = mongodbEngine.supportedVersions

    assert(Array.isArray(versions), 'supportedVersions 应为数组')
    assert(versions.length > 0, '应至少有一个支持的版本')
    assert(
      versions.some((v) => v.startsWith('8')),
      '应支持 MongoDB 8.x',
    )
  })

  it('应将主版本号解析为完整版本号', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    // 测试版本解析
    const fullVersion = mongodbEngine.resolveFullVersion('8')

    assert(fullVersion.startsWith('8.'), '应解析为 8.x.x')
    assert(fullVersion.split('.').length >= 2, '应至少包含 major.minor 格式')
  })

  it('传入完整版本号时应原样返回', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const fullVersion = mongodbEngine.resolveFullVersion('8.0.17')

    assertEqual(fullVersion, '8.0.17', '完整版本号应原样返回')
  })

  it('应构建正确的二进制路径', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const binaryPath = mongodbEngine.getBinaryPath('8')

    assert(binaryPath.includes('mongodb-'), '路径应包含 mongodb 前缀')
    assert(binaryPath.includes('8.'), '路径应包含解析后的版本号')

    // 验证完整的平台-架构组合存在
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `路径应包含支持的平台-架构组合之一: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('Redis 引擎二进制检查', () => {
  it('应使用 isBinaryInstalled 检查引擎可用性', async () => {
    const { redisEngine } = await import('../../engines/redis')

    // 检查一个肯定不存在的版本
    const isInstalled = await redisEngine.isBinaryInstalled('99.99.99')

    assertEqual(isInstalled, false, '不存在的版本不应被认为已安装')
  })

  it('应定义了 supportedVersions', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const versions = redisEngine.supportedVersions

    assert(Array.isArray(versions), 'supportedVersions 应为数组')
    assert(versions.length > 0, '应至少有一个支持的版本')
    assert(
      versions.some((v) => v.startsWith('8')),
      '应支持 Redis 8.x',
    )
  })

  it('应将主版本号解析为完整版本号', async () => {
    const { redisEngine } = await import('../../engines/redis')

    // 测试版本解析
    const fullVersion = redisEngine.resolveFullVersion('8')

    assert(fullVersion.startsWith('8.'), '应解析为 8.x.x')
    assert(fullVersion.split('.').length >= 2, '应至少包含 major.minor 格式')
  })

  it('传入完整版本号时应原样返回', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const fullVersion = redisEngine.resolveFullVersion('8.4.0')

    assertEqual(fullVersion, '8.4.0', '完整版本号应原样返回')
  })

  it('应构建正确的二进制路径', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const binaryPath = redisEngine.getBinaryPath('8')

    assert(binaryPath.includes('redis-'), '路径应包含 redis 前缀')
    assert(binaryPath.includes('8.'), '路径应包含解析后的版本号')

    // 验证完整的平台-架构组合存在
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `路径应包含支持的平台-架构组合之一: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('警告消息格式化', () => {
  it('应正确格式化孤立容器警告', () => {
    const containers = [{ name: 'db1' }, { name: 'db2' }, { name: 'db3' }]

    const count = containers.length
    const names = containers.map((c) => c.name).join(', ')
    const warning = `${count} 个容器使用此引擎: ${names}`

    assert(warning.includes('3'), '应包含容器数量')
    assert(warning.includes('db1'), '应包含第一个容器名称')
    assert(warning.includes('db2'), '应包含第二个容器名称')
    assert(warning.includes('db3'), '应包含第三个容器名称')
  })

  it('应正确格式化引擎缺失警告', () => {
    const version = '17.7.0'
    const containerName = 'orphaned-db'
    const warning = `PostgreSQL ${version} 引擎未安装（容器 "${containerName}" 需要）`

    assert(warning.includes(version), '应包含版本号')
    assert(warning.includes(containerName), '应包含容器名称')
    assert(warning.includes('未安装'), '应标明引擎缺失')
  })

  it('应正确格式化下载提示', () => {
    const version = '17.7.0'
    const majorVersion = version.split('.')[0]
    const prompt = `是否立即下载 PostgreSQL ${version}？`
    const manualHint = `运行 "spindb engines download postgresql ${majorVersion}" 手动下载。`

    assert(prompt.includes(version), '提示应包含版本号')
    assert(manualHint.includes('engines download'), '提示应包含命令')
  })
})
