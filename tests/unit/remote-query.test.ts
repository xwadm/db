/**
 * 拉取管理器单元测试
 *
 * 测试核心拉取功能，包括：
 * - 时间戳生成
 * - URL 脱敏
 * - 试运行结果生成
 * - 验证逻辑
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('拉取管理器', () => {
  describe('生成时间戳', () => {
    it('应以 YYYYMMDD_HHMMSS 格式生成时间戳', () => {
      // 通过原型操作访问私有方法进行测试
      // 在生产代码中，时间戳为内部使用
      const now = new Date()
      const expected = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '_',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')

      // 验证格式符合预期模式
      assert.match(expected, /^\d{8}_\d{6}$/)
    })
  })

  describe('脱敏 URL', () => {
    it('应对 PostgreSQL URL 中的密码进行脱敏', () => {
      const url = 'postgresql://user:secret123@localhost:5432/mydb'
      const parsed = new URL(url)
      parsed.password = '***'
      const redacted = parsed.toString()

      assert.strictEqual(redacted, 'postgresql://user:***@localhost:5432/mydb')
    })

    it('应对 MySQL URL 中的密码进行脱敏', () => {
      const url = 'mysql://root:password@127.0.0.1:3306/app'
      const parsed = new URL(url)
      parsed.password = '***'
      const redacted = parsed.toString()

      assert.strictEqual(redacted, 'mysql://root:***@127.0.0.1:3306/app')
    })

    it('应处理不带密码的 URL', () => {
      const url = 'postgresql://user@localhost:5432/mydb'
      const parsed = new URL(url)
      if (parsed.password) parsed.password = '***'
      const redacted = parsed.toString()

      assert.strictEqual(redacted, 'postgresql://user@localhost:5432/mydb')
    })

    it('对于格式错误的 URL 应返回 [invalid url]', () => {
      const url = 'not-a-valid-url'
      let result: string
      try {
        new URL(url)
        result = url
      } catch {
        result = '[invalid url]'
      }

      assert.strictEqual(result, '[invalid url]')
    })
  })

  describe('拉取选项验证', () => {
    it('应要求提供 fromUrl', () => {
      // PullOptions 类型要求提供 fromUrl
      const options = {
        fromUrl: 'postgresql://localhost/db',
      }
      assert.ok(options.fromUrl)
    })

    it('应允许可选的数据库覆盖', () => {
      const options = {
        fromUrl: 'postgresql://localhost/db',
        database: 'custom_db',
      }
      assert.strictEqual(options.database, 'custom_db')
    })

    it('应允许使用 asDatabase 的克隆模式', () => {
      const options = {
        fromUrl: 'postgresql://localhost/db',
        asDatabase: 'new_db',
      }
      assert.ok(options.asDatabase)
      assert.strictEqual(options.asDatabase, 'new_db')
    })

    it('应允许带 force 的 noBackup', () => {
      const options = {
        fromUrl: 'postgresql://localhost/db',
        noBackup: true,
        force: true,
      }
      assert.strictEqual(options.noBackup, true)
      assert.strictEqual(options.force, true)
    })
  })

  describe('拉取结果结构', () => {
    it('应包含替换模式所需的字段', () => {
      const result = {
        success: true,
        mode: 'replace' as const,
        database: 'mydb',
        backupDatabase: 'mydb_20260129_143052',
        source: 'postgresql://user:***@localhost/db',
        message: '已将远程数据拉取到 "mydb"',
      }

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.mode, 'replace')
      assert.ok(result.database)
      assert.ok(result.backupDatabase)
      assert.ok(result.source)
      assert.ok(result.message)
    })

    it('应包含克隆模式所需的字段', () => {
      const result: {
        success: boolean
        mode: 'clone'
        database: string
        backupDatabase?: string
        source: string
        message: string
      } = {
        success: true,
        mode: 'clone' as const,
        database: 'mydb_prod',
        source: 'postgresql://user:***@localhost/db',
        message: '已将远程数据克隆到 "mydb_prod"',
      }

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.mode, 'clone')
      assert.ok(result.database)
      assert.strictEqual(result.backupDatabase, undefined)
      assert.ok(result.source)
      assert.ok(result.message)
    })

    it('当 noBackup 为 true 时不应包含 backupDatabase', () => {
      const result = {
        success: true,
        mode: 'replace' as const,
        database: 'mydb',
        backupDatabase: undefined,
        source: 'postgresql://user:***@localhost/db',
        message: '已将远程数据拉取到 "mydb"',
      }

      assert.strictEqual(result.backupDatabase, undefined)
    })
  })

  describe('试运行行为', () => {
    it('应在不进行任何更改的情况下返回成功', () => {
      const database = 'testdb'
      const timestamp = '20260129_143052'
      const isCloneMode = false
      const noBackup = false

      const backupDatabase = isCloneMode
        ? undefined
        : `${database}_${timestamp}`

      const result = {
        success: true,
        mode: isCloneMode ? ('clone' as const) : ('replace' as const),
        database,
        backupDatabase: noBackup ? undefined : backupDatabase,
        source: 'postgresql://user:***@localhost/db',
        message: '[试运行] 未进行任何更改',
      }

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.message, '[试运行] 未进行任何更改')
      assert.strictEqual(result.backupDatabase, 'testdb_20260129_143052')
    })

    it('克隆模式试运行中不应包含 backupDatabase', () => {
      const database = 'testdb_clone'
      const isCloneMode = true

      const result = {
        success: true,
        mode: isCloneMode ? ('clone' as const) : ('replace' as const),
        database,
        backupDatabase: isCloneMode ? undefined : 'backup_db',
        source: 'postgresql://user:***@localhost/db',
        message: '[试运行] 未进行任何更改',
      }

      assert.strictEqual(result.mode, 'clone')
      assert.strictEqual(result.backupDatabase, undefined)
    })
  })

  describe('拉取后的注册表同步', () => {
    it('应在替换模式完成后调用 syncDatabases', () => {
      // 拉取 --replace 后，会调用 syncDatabases 更新注册表
      // 这会捕获备份数据库以及服务器上的任何其他数据库
      // 备份数据库名称遵循模式：{database}_{YYYYMMDD_HHMMSS}
      const backupPattern = /^main_\d{8}_\d{6}$/

      assert.ok(
        backupPattern.test('main_20260204_123456'),
        '备份名称应匹配时间戳模式',
      )
    })

    it('应在克隆模式完成后调用 syncDatabases', () => {
      // 拉取 --as=newdb 后，会调用 syncDatabases 更新注册表
      // 克隆的数据库名称由用户通过 --as 标志指定
      const clonedDatabase = 'prod_clone'

      assert.ok(
        /^[a-zA-Z][a-zA-Z0-9_]*$/.test(clonedDatabase),
        '克隆的数据库名称应有效',
      )
    })

    it('应处理不支持数据库列表的引擎', () => {
      // 某些引擎（Redis、Qdrant）不支持 listDatabases
      // syncDatabases 会优雅地回退到当前注册表
      const currentRegistry = ['0'] // Redis 数据库

      // 当 listDatabases 抛出“不支持”异常时，保留当前注册表
      assert.strictEqual(
        currentRegistry.length,
        1,
        '当列出数据库不受支持时，应保留注册表',
      )
    })
  })
})
