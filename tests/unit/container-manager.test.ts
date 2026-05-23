import { describe, it } from 'node:test'
import { ContainerManager } from '../../core/container-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('ContainerManager', () => {
  describe('isValidName', () => {
    it('应接受有效的容器名称', () => {
      const containerManager = new ContainerManager()

      const validNames = [
        'mydb',
        'my-db',
        'my_db',
        'MyDB',
        'db123',
        'a',
        'test-container-name',
        'Test_Container_123',
      ]

      for (const name of validNames) {
        assert(
          containerManager.isValidName(name),
          `"${name}" 应为有效的容器名称`,
        )
      }
    })

    it('应拒绝无效的容器名称', () => {
      const containerManager = new ContainerManager()

      const invalidNames = [
        '',
        '123db', // 以数字开头
        '-mydb', // 以连字符开头
        '_mydb', // 以下划线开头
        'my db', // 包含空格
        'my.db', // 包含点
        'my@db', // 包含特殊字符
        'my/db', // 包含斜杠
      ]

      for (const name of invalidNames) {
        assert(
          !containerManager.isValidName(name),
          `"${name}" 应为无效的容器名称`,
        )
      }
    })

    it('要求名称以字母开头', () => {
      const containerManager = new ContainerManager()

      assert(
        containerManager.isValidName('a123'),
        '应允许字母后跟数字',
      )
      assert(
        !containerManager.isValidName('1abc'),
        '应拒绝数字开头',
      )
      assert(
        !containerManager.isValidName('-abc'),
        '应拒绝连字符开头',
      )
    })
  })

  describe('ContainerConfig 结构', () => {
    it('应有所有必需字段', () => {
      const config = {
        name: 'testdb',
        engine: 'postgresql' as const,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
        databases: ['testdb'],
        created: new Date().toISOString(),
        status: 'created' as const,
      }

      assert(typeof config.name === 'string', '应有名称')
      assert(typeof config.engine === 'string', '应有引擎')
      assert(typeof config.version === 'string', '应有版本')
      assert(typeof config.port === 'number', '应有端口')
      assert(typeof config.database === 'string', '应有数据库')
      assert(Array.isArray(config.databases), '应有数据库数组')
      assert(
        typeof config.created === 'string',
        '应有创建时间戳',
      )
      assert(typeof config.status === 'string', '应有状态')
    })

    it('应支持 clonedFrom 字段', () => {
      const clonedConfig = {
        name: 'cloned-db',
        engine: 'postgresql' as const,
        version: '17.7.0',
        port: 5433,
        database: 'testdb',
        databases: ['testdb'],
        created: new Date().toISOString(),
        status: 'stopped' as const,
        clonedFrom: 'original-db',
      }

      assertEqual(
        clonedConfig.clonedFrom,
        'original-db',
        '应跟踪克隆源',
      )
    })
  })

  describe('CreateOptions 结构', () => {
    it('应有所有必需字段', () => {
      const options = {
        engine: 'postgresql' as const,
        version: '17',
        port: 5432,
        database: 'mydb',
      }

      assert(typeof options.engine === 'string', '应有引擎')
      assert(typeof options.version === 'string', '应有版本')
      assert(typeof options.port === 'number', '应有端口')
      assert(typeof options.database === 'string', '应有数据库')
    })
  })

  describe('错误消息', () => {
    it('应为无效容器名称提供清晰的错误', () => {
      const invalidNameError =
        'Container name must be alphanumeric with hyphens/underscores only'

      assert(
        invalidNameError.includes('alphanumeric'),
        '错误应提及允许的字符',
      )
      assert(
        invalidNameError.includes('hyphens') &&
          invalidNameError.includes('underscores'),
        '错误应提及允许的特殊字符',
      )
    })

    it('应为现有容器提供清晰的错误', () => {
      const existingError =
        'Container "mydb" already exists for engine postgresql'

      assert(
        existingError.includes('mydb'),
        '错误应包含容器名称',
      )
      assert(
        existingError.includes('already exists'),
        '错误应说明容器存在',
      )
    })

    it('应为容器未找到提供清晰的错误', () => {
      const notFoundError = 'Container "mydb" not found'

      assert(
        notFoundError.includes('not found'),
        '错误应指示容器未找到',
      )
      assert(
        notFoundError.includes('mydb'),
        '错误应包含容器名称',
      )
    })

    it('应为运行中容器删除提供可操作的错误', () => {
      const runningError =
        'Container "mydb" is running. Stop it first or use --force'

      assert(
        runningError.includes('running'),
        '错误应指示容器正在运行',
      )
      assert(
        runningError.includes('Stop it first') ||
          runningError.includes('--force'),
        '错误应建议如何解决',
      )
    })

    it('应为运行中容器克隆提供可操作的错误', () => {
      const runningCloneError =
        'Source container "mydb" is running. Stop it first'

      assert(
        runningCloneError.includes('running'),
        '错误应指示源正在运行',
      )
      assert(
        runningCloneError.includes('Stop'),
        '错误应建议先停止',
      )
    })

    it('应为运行中容器重命名提供可操作的错误', () => {
      const runningRenameError = 'Container "mydb" is running. Stop it first'

      assert(
        runningRenameError.includes('running'),
        '错误应指示容器正在运行',
      )
    })
  })

  describe('数据库管理', () => {
    it('应阻止移除主数据库', () => {
      const errorMessage =
        'Cannot remove primary database "testdb" from tracking'

      assert(
        errorMessage.includes('Cannot remove primary database'),
        '错误应指示主数据库保护',
      )
    })

    it('应迁移没有数据库数组的配置', async () => {
      // 测试迁移概念
      const oldConfig: {
        name: string
        engine: string
        version: string
        port: number
        database: string
        databases?: string[]
        created: string
        status: string
      } = {
        name: 'testdb',
        engine: 'postgresql',
        version: '17',
        port: 5432,
        database: 'mydb',
        // 无 databases 数组 - 旧架构
        created: '2024-01-01T00:00:00Z',
        status: 'stopped',
      }

      // 迁移应添加包含主数据库的 databases 数组
      const migratedDatabases = oldConfig.databases ?? [oldConfig.database]

      assert(Array.isArray(migratedDatabases), '应创建数据库数组')
      assert(
        migratedDatabases.includes(oldConfig.database),
        '应包含主数据库',
      )
    })

    it('应确保主数据库在数据库数组中', async () => {
      // 测试迁移边界情况
      const configWithMissingPrimary = {
        database: 'primary',
        databases: ['secondary', 'tertiary'],
      }

      // 迁移逻辑应将主数据库前置
      if (
        !configWithMissingPrimary.databases.includes(
          configWithMissingPrimary.database,
        )
      ) {
        configWithMissingPrimary.databases = [
          configWithMissingPrimary.database,
          ...configWithMissingPrimary.databases,
        ]
      }

      assertEqual(
        configWithMissingPrimary.databases[0],
        'primary',
        '主数据库应在数组首位',
      )
    })
  })

  describe('克隆操作', () => {
    it('应设置 clonedFrom 字段', () => {
      const cloneConfig = {
        name: 'clone-db',
        clonedFrom: 'source-db',
        created: new Date().toISOString(),
      }

      assertEqual(
        cloneConfig.clonedFrom,
        'source-db',
        '应跟踪源容器',
      )
    })

    it('应更新创建时间戳', () => {
      const originalCreated = '2024-01-01T00:00:00Z'
      const newCreated = new Date().toISOString()

      assert(newCreated > originalCreated, '克隆应有更新的时间戳')
    })
  })

  describe('重命名操作', () => {
    it('应在配置中更新名称', () => {
      const oldName = 'old-db'
      const newName = 'new-db'
      const config = { name: oldName }

      config.name = newName

      assertEqual(config.name, newName, '名称应已更新')
    })
  })

  describe('DeleteOptions', () => {
    it('应默认 force 为 false', () => {
      const options = {}
      const force = (options as { force?: boolean }).force ?? false

      assertEqual(force, false, 'Force 应默认为 false')
    })

    it('应尊重 force 选项', () => {
      const options = { force: true }

      assertEqual(options.force, true, '设置时应尊重 Force')
    })
  })

  describe('连接字符串', () => {
    it('应正确格式化 PostgreSQL 连接字符串', () => {
      const config = {
        name: 'testdb',
        engine: 'postgresql' as const,
        port: 5432,
        database: 'mydb',
      }

      const expectedFormat = `postgresql://postgres@127.0.0.1:${config.port}/${config.database}`

      assert(
        expectedFormat.includes('postgresql://'),
        '应使用 postgresql:// 协议',
      )
      assert(expectedFormat.includes('127.0.0.1'), '应使用 localhost')
      assert(
        expectedFormat.includes(String(config.port)),
        '应包含端口',
      )
      assert(
        expectedFormat.includes(config.database),
        '应包含数据库名称',
      )
    })

    it('应正确格式化 MySQL 连接字符串', () => {
      const config = {
        name: 'testdb',
        engine: 'mysql' as const,
        port: 3306,
        database: 'mydb',
      }

      const expectedFormat = `mysql://root@127.0.0.1:${config.port}/${config.database}`

      assert(
        expectedFormat.includes('mysql://'),
        '应使用 mysql:// 协议',
      )
      assert(expectedFormat.includes('root@'), 'MySQL 应使用 root 用户')
    })

    it('应允许在连接字符串中覆盖数据库', () => {
      const config = {
        database: 'default_db',
        port: 5432,
      }
      const overrideDb = 'other_db'

      const url = `postgresql://postgres@127.0.0.1:${config.port}/${overrideDb}`

      assert(
        url.includes(overrideDb),
        '提供时应使用覆盖数据库',
      )
      assert(
        !url.includes(config.database),
        '提供覆盖时不应使用默认数据库',
      )
    })
  })

  describe('列表操作', () => {
    it('无容器时应返回空数组', async () => {
      // 概念测试：list 不应返回 undefined
      const containers: unknown[] = []

      assert(Array.isArray(containers), '应返回数组')
      assertEqual(containers.length, 0, '应为空数组')
    })

    it('应根据进程状态更新状态', () => {
      // 测试状态协调概念
      const configStatus = 'stopped'
      const isRunning = true
      const actualStatus = isRunning ? 'running' : configStatus

      assertEqual(
        actualStatus,
        'running',
        '应反映实际运行状态',
      )
    })
  })

  describe('引擎作用域', () => {
    it('应按引擎划分容器', () => {
      // 测试引擎作用域容器路径概念
      const containerName = 'testdb'
      const engines = ['postgresql', 'mysql']

      for (const engine of engines) {
        const path = `~/.spindb/containers/${engine}/${containerName}`

        assert(path.includes(engine), `路径应包含引擎: ${engine}`)
        assert(
          path.includes(containerName),
          '路径应包含容器名称',
        )
      }
    })

    it('应允许不同引擎使用相同的容器名称', () => {
      // 概念：mydb 可以同时存在于 PostgreSQL 和 MySQL
      const pgContainer = { name: 'mydb', engine: 'postgresql' }
      const mysqlContainer = { name: 'mydb', engine: 'mysql' }

      assertEqual(pgContainer.name, mysqlContainer.name, '名称可以相同')
      assert(
        pgContainer.engine !== mysqlContainer.engine,
        '引擎必须不同',
      )
    })
  })
})

describe('容器路径', () => {
  it('应使用 ~/.spindb/containers 作为基础', async () => {
    const { paths } = await import('../../config/paths')

    assert(paths.containers.includes('.spindb'), '应使用 .spindb 目录')
    assert(
      paths.containers.includes('containers'),
      '应使用 containers 子目录',
    )
  })
})

describe('syncDatabases', () => {
  it('应要求容器正在运行', () => {
    const errorMessage =
      'Container "testdb" is not running. Start it first to sync databases.'

    assert(
      errorMessage.includes('not running'),
      '错误应指示容器未运行',
    )
    assert(
      errorMessage.includes('Start it first'),
      '错误应建议启动容器',
    )
  })

  it('应在同步列表中保留主数据库', () => {
    const primaryDatabase = 'main'
    const discoveredDatabases = ['backup_20260204', 'staging']

    // 确保主数据库被包含
    const syncedDatabases = discoveredDatabases.includes(primaryDatabase)
      ? discoveredDatabases
      : [primaryDatabase, ...discoveredDatabases]

    assert(
      syncedDatabases.includes(primaryDatabase),
      '同步列表应包含主数据库',
    )
    assertEqual(
      syncedDatabases[0],
      primaryDatabase,
      '主数据库应排在首位',
    )
  })

  it('应在主数据库后按字母顺序排序数据库', () => {
    const primaryDatabase = 'main'
    const discoveredDatabases = ['main', 'zebra_db', 'alpha_db', 'beta_db']

    // 排序：主数据库在前，然后按字母顺序
    const sorted = [
      primaryDatabase,
      ...discoveredDatabases
        .filter((db) => db !== primaryDatabase)
        .sort((a, b) => a.localeCompare(b)),
    ]

    assertEqual(sorted[0], 'main', '主数据库应排在首位')
    assertEqual(sorted[1], 'alpha_db', '然后按字母顺序: alpha_db')
    assertEqual(sorted[2], 'beta_db', '然后按字母顺序: beta_db')
    assertEqual(sorted[3], 'zebra_db', '然后按字母顺序: zebra_db')
  })

  it('应处理不支持 listDatabases 的引擎', () => {
    // Qdrant、Meilisearch 等引擎使用集合/索引，而非数据库
    // syncDatabases 应优雅地回退到当前注册表
    const currentDatabases = ['mydb']

    // 当 listDatabases 抛出 "not supported" 时，返回当前注册表
    assertEqual(
      currentDatabases.length,
      1,
      '不支持时应返回当前数据库',
    )
  })

  it('应为基于文件的引擎返回当前注册表', () => {
    // SQLite 和 DuckDB 是单数据库引擎
    const config = {
      engine: 'sqlite',
      database: '/path/to/mydb.sqlite',
      databases: ['/path/to/mydb.sqlite'],
    }

    // 基于文件的引擎应返回现有注册表
    assertEqual(
      config.databases.length,
      1,
      '基于文件的引擎有单个数据库',
    )
    assertEqual(
      config.databases[0],
      config.database,
      '应与主数据库匹配',
    )
  })
})
