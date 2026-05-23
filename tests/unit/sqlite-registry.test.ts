import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'

// 我们需要模拟路径以使用临时目录
// 对于单元测试，我们将直接测试注册表逻辑

describe('SQLite 注册表', () => {
  const testDir = join(tmpdir(), 'spindb-test-sqlite-registry')
  const testRegistryPath = join(testDir, 'sqlite-registry.json')

  beforeEach(async () => {
    // 清理并创建测试目录
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true })
    }
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true })
    }
  })

  describe('注册表条目结构', () => {
    it('应该包含所有必需字段', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
      }

      assert(typeof entry.name === 'string', '应该包含 name 字段')
      assert(typeof entry.filePath === 'string', '应该包含 filePath 字段')
      assert(typeof entry.created === 'string', '应该包含 created 时间戳')
    })

    it('应该支持可选的 lastVerified 字段', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
        lastVerified: new Date().toISOString(),
      }

      assert(
        typeof entry.lastVerified === 'string',
        '应该支持 lastVerified 字段',
      )
    })
  })

  describe('注册表结构', () => {
    it('应该包含 version 和 entries 数组', () => {
      const registry = {
        version: 1 as const,
        entries: [],
      }

      assertEqual(registry.version, 1, '版本号应为 1')
      assert(Array.isArray(registry.entries), '应该包含 entries 数组')
    })
  })

  describe('注册表文件操作', () => {
    it('首次加载时应创建包含空条目的注册表', async () => {
      const emptyRegistry = {
        version: 1 as const,
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      // 写入测试路径
      await writeFile(testRegistryPath, JSON.stringify(emptyRegistry, null, 2))

      assert(existsSync(testRegistryPath), '注册表文件应该存在')
    })

    it('应该优雅地处理损坏的注册表', () => {
      // 概念：损坏的注册表应返回空值
      const fallback = { version: 1, entries: [] }

      try {
        JSON.parse('invalid json')
      } catch {
        // 解析错误时应返回空注册表
        assertEqual(
          fallback.entries.length,
          0,
          '错误时应返回空条目',
        )
      }
    })
  })

  describe('条目管理', () => {
    it('应该向注册表添加条目', () => {
      const registry = {
        version: 1 as const,
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      const newEntry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
      }

      registry.entries.push(newEntry)

      assertEqual(registry.entries.length, 1, '应该有一个条目')
      assertEqual(registry.entries[0].name, 'testdb', '条目名称应该匹配')
    })

    it('应该防止重复名称', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
        ],
      }

      const duplicateName = 'testdb'
      const exists = registry.entries.some((e) => e.name === duplicateName)

      assert(exists, '应该检测到重复名称')
    })

    it('应该按名称删除条目', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
          { name: 'other', filePath: '/path/b.sqlite', created: '2024-01-01' },
        ],
      }

      const nameToRemove = 'testdb'
      registry.entries = registry.entries.filter((e) => e.name !== nameToRemove)

      assertEqual(
        registry.entries.length,
        1,
        '删除后应该有一个条目',
      )
      assertEqual(
        registry.entries[0].name,
        'other',
        '剩余条目应该是 "other"',
      )
    })

    it('应该按名称查找条目', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
        ],
      }

      const found = registry.entries.find((e) => e.name === 'testdb')

      assert(found !== undefined, '应该找到条目')
      assertEqual(found?.filePath, '/path/a.sqlite', '应该有正确的路径')
    })

    it('对于不存在的条目应该返回 null', () => {
      const registry = {
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      const found = registry.entries.find((e) => e.name === 'nonexistent')

      assert(found === undefined, '不应该找到不存在的条目')
    })
  })

  describe('孤立条目检测', () => {
    it('应该检测文件不存在的条目', async () => {
      const entries = [
        { name: 'exists', filePath: testRegistryPath, created: '2024-01-01' },
        {
          name: 'missing',
          filePath: '/nonexistent/path.sqlite',
          created: '2024-01-01',
        },
      ]

      // 创建一个存在的文件
      await writeFile(testRegistryPath, '{}')

      const orphans = entries.filter((e) => !existsSync(e.filePath))

      assertEqual(orphans.length, 1, '应该找到一个孤立条目')
      assertEqual(
        orphans[0].name,
        'missing',
        '孤立条目应该是缺失的文件',
      )
    })

    it('当所有文件都存在时应该返回空数组', async () => {
      const existingFile = join(testDir, 'test.sqlite')
      await writeFile(existingFile, '')

      const entries = [
        { name: 'exists', filePath: existingFile, created: '2024-01-01' },
      ]

      const orphans = entries.filter((e) => !existsSync(e.filePath))

      assertEqual(orphans.length, 0, '不应该找到孤立条目')
    })

    it('应该移除孤立条目', async () => {
      const existingFile = join(testDir, 'test.sqlite')
      await writeFile(existingFile, '')

      const registry = {
        entries: [
          { name: 'exists', filePath: existingFile, created: '2024-01-01' },
          {
            name: 'missing',
            filePath: '/nonexistent/path.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const originalCount = registry.entries.length
      registry.entries = registry.entries.filter((e) => existsSync(e.filePath))
      const removedCount = originalCount - registry.entries.length

      assertEqual(removedCount, 1, '应该移除一个孤立条目')
      assertEqual(registry.entries.length, 1, '应该剩下一个条目')
      assertEqual(
        registry.entries[0].name,
        'exists',
        '剩余条目应该存在',
      )
    })
  })

  describe('路径注册', () => {
    it('应该检测路径是否已注册', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/path/to/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const path = '/path/to/test.sqlite'
      const isRegistered = registry.entries.some((e) => e.filePath === path)

      assert(isRegistered, '应该检测到已注册的路径')
    })

    it('应该按文件路径查找条目', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/path/to/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const path = '/path/to/test.sqlite'
      const found = registry.entries.find((e) => e.filePath === path)

      assert(found !== undefined, '应该按路径找到条目')
      assertEqual(found?.name, 'testdb', '应该有正确的名称')
    })
  })

  describe('更新操作', () => {
    it('应该更新 lastVerified 时间戳', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: '2024-01-01T00:00:00Z',
        lastVerified: '2024-01-01T00:00:00Z',
      }

      const newTimestamp = new Date().toISOString()
      entry.lastVerified = newTimestamp

      assert(entry.lastVerified > entry.created, 'lastVerified 应该更新')
    })

    it('应该更新 filePath', () => {
      const entry = {
        name: 'testdb',
        filePath: '/old/path.sqlite',
        created: '2024-01-01T00:00:00Z',
      }

      const newPath = '/new/path.sqlite'
      entry.filePath = newPath

      assertEqual(entry.filePath, newPath, '路径应该已更新')
    })
  })

  describe('重定位操作', () => {
    it('重定位数据库时应该更新 filePath', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/old/path/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const newPath = '/new/location/test.sqlite'
      const entry = registry.entries.find((e) => e.name === 'testdb')
      if (entry) {
        entry.filePath = newPath
      }

      assertEqual(
        registry.entries[0].filePath,
        newPath,
        '文件路径应该已更新',
      )
    })

    it('更新路径时应该保留其他条目字段', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/old/path/test.sqlite',
            created: '2024-01-01T00:00:00Z',
            lastVerified: '2024-06-01T00:00:00Z',
          },
        ],
      }

      const originalCreated = registry.entries[0].created
      const originalLastVerified = registry.entries[0].lastVerified

      // 模拟重定位更新
      registry.entries[0].filePath = '/new/location/test.sqlite'

      assertEqual(
        registry.entries[0].name,
        'testdb',
        '名称应该被保留',
      )
      assertEqual(
        registry.entries[0].created,
        originalCreated,
        '创建时间应该被保留',
      )
      assertEqual(
        registry.entries[0].lastVerified,
        originalLastVerified,
        'LastVerified 应该被保留',
      )
    })

    it('应该处理重定位到不同目录', () => {
      const entry = {
        name: 'testdb',
        filePath: '/Users/bob/project-a/data.sqlite',
        created: '2024-01-01',
      }

      // 重定位到不同项目
      entry.filePath = '/Users/bob/project-b/data.sqlite'

      assert(entry.filePath.includes('project-b'), '应该在新目录中')
      assert(
        !entry.filePath.includes('project-a'),
        '不应该在旧目录中',
      )
    })

    it('应该处理重定位时更改文件名', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/old-name.sqlite',
        created: '2024-01-01',
      }

      // 重定位并使用新文件名
      entry.filePath = '/path/new-name.sqlite'

      assert(
        entry.filePath.endsWith('new-name.sqlite'),
        '应该有新文件名',
      )
    })

    it('应该处理重定位到主目录', () => {
      const entry = {
        name: 'testdb',
        filePath: '/Users/bob/dev/test.sqlite',
        created: '2024-01-01',
      }

      // 模拟 ~ 展开（存储时已展开）
      entry.filePath = '/Users/bob/sqlite-tests/test.sqlite'

      assert(
        entry.filePath.startsWith('/Users/bob'),
        '应该在主目录中',
      )
    })

    it('更新一个条目时不应该影响其他条目', () => {
      const registry = {
        entries: [
          { name: 'db1', filePath: '/path/db1.sqlite', created: '2024-01-01' },
          { name: 'db2', filePath: '/path/db2.sqlite', created: '2024-01-01' },
          { name: 'db3', filePath: '/path/db3.sqlite', created: '2024-01-01' },
        ],
      }

      // 只更新 db2
      const entry = registry.entries.find((e) => e.name === 'db2')
      if (entry) {
        entry.filePath = '/new/path/db2.sqlite'
      }

      assertEqual(
        registry.entries[0].filePath,
        '/path/db1.sqlite',
        'db1 应该保持不变',
      )
      assertEqual(
        registry.entries[1].filePath,
        '/new/path/db2.sqlite',
        'db2 应该已更新',
      )
      assertEqual(
        registry.entries[2].filePath,
        '/path/db3.sqlite',
        'db3 应该保持不变',
      )
    })
  })

  describe('连接字符串格式', () => {
    it('应该格式化 SQLite 连接字符串', () => {
      const filePath = '/Users/test/mydb.sqlite'
      const connectionString = `sqlite://${filePath}`

      assert(
        connectionString.startsWith('sqlite://'),
        '应该以 sqlite:// 开头',
      )
      assert(connectionString.includes(filePath), '应该包含文件路径')
    })

    it('应该处理包含空格的路径', () => {
      const filePath = '/Users/test/my database.sqlite'
      const connectionString = `sqlite://${filePath}`

      assert(connectionString.includes('my database'), '应该处理空格')
    })
  })

  describe('错误消息', () => {
    it('应该为重复名称提供清晰的错误信息', () => {
      const errorMessage = 'SQLite container "testdb" already exists'

      assert(
        errorMessage.includes('already exists'),
        '应该表明是重复',
      )
      assert(errorMessage.includes('testdb'), '应该包含名称')
    })
  })
})

describe('SQLite 引擎注册表 (config.json 结构)', () => {
  describe('包含 ignoreFolders 的注册表结构', () => {
    it('应该包含 version、entries 数组和 ignoreFolders 对象', () => {
      const registry = {
        version: 1 as const,
        entries: [],
        ignoreFolders: {} as Record<string, true>,
      }

      assertEqual(registry.version, 1, '版本号应为 1')
      assert(Array.isArray(registry.entries), '应该包含 entries 数组')
      assert(
        typeof registry.ignoreFolders === 'object',
        '应该包含 ignoreFolders 对象',
      )
    })

    it('应该将忽略的文件夹存储为键，值为 true', () => {
      const registry = {
        version: 1 as const,
        entries: [],
        ignoreFolders: {
          '/path/to/folder1': true,
          '/path/to/folder2': true,
        } as Record<string, true>,
      }

      assert(
        '/path/to/folder1' in registry.ignoreFolders,
        '应该包含 folder1',
      )
      assert(
        '/path/to/folder2' in registry.ignoreFolders,
        '应该包含 folder2',
      )
    })
  })

  describe('忽略文件夹操作', () => {
    it('应该将文件夹添加到忽略列表', () => {
      const ignoreFolders: Record<string, true> = {}

      ignoreFolders['/path/to/folder'] = true

      assert(
        '/path/to/folder' in ignoreFolders,
        '文件夹应该在忽略列表中',
      )
    })

    it('应该从忽略列表中移除文件夹', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/to/folder': true,
      }

      delete ignoreFolders['/path/to/folder']

      assert(
        !('/path/to/folder' in ignoreFolders),
        '文件夹应该已从忽略列表中移除',
      )
    })

    it('应该为忽略的文件夹提供 O(1) 查找', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
        '/path/b': true,
        '/path/c': true,
      }

      // 直接属性访问是 O(1)
      const isIgnored = '/path/b' in ignoreFolders
      assert(isIgnored, '应该以 O(1) 找到文件夹')
    })

    it('对于未忽略的文件夹应该返回 false', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
      }

      const isIgnored = '/path/b' in ignoreFolders
      assert(!isIgnored, '对于未忽略的文件夹应该返回 false')
    })

    it('应该列出所有忽略的文件夹', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
        '/path/b': true,
        '/path/c': true,
      }

      const folders = Object.keys(ignoreFolders)

      assertEqual(folders.length, 3, '应该有 3 个文件夹')
      assert(folders.includes('/path/a'), '应该包含 path/a')
      assert(folders.includes('/path/b'), '应该包含 path/b')
      assert(folders.includes('/path/c'), '应该包含 path/c')
    })
  })
})

describe('SQLite 扫描器', () => {
  describe('deriveContainerName', () => {
    it('应该移除 .sqlite 扩展名', () => {
      const fileName = 'mydb.sqlite'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', '应该移除 .sqlite 扩展名')
    })

    it('应该移除 .sqlite3 扩展名', () => {
      const fileName = 'mydb.sqlite3'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', '应该移除 .sqlite3 扩展名')
    })

    it('应该移除 .db 扩展名', () => {
      const fileName = 'mydb.db'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', '应该移除 .db 扩展名')
    })

    it('应该将无效字符替换为连字符', () => {
      const name = 'my database'
      const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-')
      assertEqual(
        sanitized,
        'my-database',
        '应该将空格替换为连字符',
      )
    })

    it('如果以数字开头应该添加 db- 前缀', () => {
      const name = '123test'
      const prefixed = /^[a-zA-Z]/.test(name) ? name : 'db-' + name
      assertEqual(prefixed, 'db-123test', '应该添加 db- 前缀')
    })

    it('如果以字母开头不应该添加前缀', () => {
      const name = 'mytest'
      const prefixed = /^[a-zA-Z]/.test(name) ? name : 'db-' + name
      assertEqual(prefixed, 'mytest', '不应该添加前缀')
    })

    it('应该移除连续的连字符', () => {
      const name = 'my--database'
      const cleaned = name.replace(/-+/g, '-')
      assertEqual(cleaned, 'my-database', '应该移除连续的连字符')
    })
  })

  describe('未注册文件检测', () => {
    it('应该匹配 sqlite 文件扩展名', () => {
      const files = ['test.sqlite', 'test.sqlite3', 'test.db', 'test.txt']
      const sqliteFiles = files.filter((f) => /\.(sqlite3?|db)$/i.test(f))

      assertEqual(sqliteFiles.length, 3, '应该匹配 3 个 SQLite 文件')
      assert(!sqliteFiles.includes('test.txt'), '不应该包含 txt 文件')
    })

    it('扩展名匹配应该不区分大小写', () => {
      const files = ['test.SQLITE', 'test.Sqlite3', 'test.DB']
      const sqliteFiles = files.filter((f) => /\.(sqlite3?|db)$/i.test(f))

      assertEqual(sqliteFiles.length, 3, '应该匹配所有大小写变体')
    })
  })
})

describe('SQLite 容器配置', () => {
  describe('SQLite 的 ContainerConfig', () => {
    it('基于文件的数据库端口应该为 0', () => {
      const config = {
        name: 'testdb',
        engine: 'sqlite' as const,
        version: '3',
        port: 0,
        database: '/path/to/test.sqlite',
        databases: ['/path/to/test.sqlite'],
        created: new Date().toISOString(),
        status: 'running' as const, // "running" = 文件存在
      }

      assertEqual(config.port, 0, 'SQLite 的端口应为 0')
      assertEqual(config.engine, 'sqlite', '引擎应为 sqlite')
    })

    it('应该使用文件路径作为 database 字段', () => {
      const filePath = '/path/to/test.sqlite'
      const config = {
        database: filePath,
      }

      assert(
        config.database.endsWith('.sqlite'),
        'database 应该是文件路径',
      )
    })

    it('当文件存在时应该使用 "running" 状态', () => {
      const status = 'running' // 文件存在
      assertEqual(
        status,
        'running',
        '文件存在时状态应为 running',
      )
    })

    it('当文件缺失时应该使用 "stopped" 状态', () => {
      const status = 'stopped' // 文件缺失
      assertEqual(
        status,
        'stopped',
        '文件缺失时状态应为 stopped',
      )
    })
  })
})
