import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Engine } from '../../types'
import { paths } from '../../config/paths'
import {
  saveCredentials,
  loadCredentials,
  listCredentials,
  credentialsExist,
} from '../../core/credential-manager'
import type { UserCredentials } from '../../types'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'

// 使用带随机数的唯一容器名称以避免与真实数据冲突
const TEST_NONCE = Date.now()
const TEST_CONTAINER = `_cred_test_${TEST_NONCE}`
const TEST_CONTAINER_MS = `_cred_test_ms_${TEST_NONCE}`

describe('Credential Manager', () => {
  beforeEach(() => {
    // 确保容器目录存在
    const pgDir = paths.getContainerPath(TEST_CONTAINER, {
      engine: Engine.PostgreSQL,
    })
    mkdirSync(pgDir, { recursive: true })

    const msDir = paths.getContainerPath(TEST_CONTAINER_MS, {
      engine: Engine.Meilisearch,
    })
    mkdirSync(msDir, { recursive: true })

    // 清理任何现有凭据
    const pgCredDir = join(pgDir, 'credentials')
    if (existsSync(pgCredDir)) {
      rmSync(pgCredDir, { recursive: true, force: true })
    }
    const msCredDir = join(msDir, 'credentials')
    if (existsSync(msCredDir)) {
      rmSync(msCredDir, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    // 清理测试容器
    const pgDir = paths.getContainerPath(TEST_CONTAINER, {
      engine: Engine.PostgreSQL,
    })
    if (existsSync(pgDir)) {
      rmSync(pgDir, { recursive: true, force: true })
    }

    const msDir = paths.getContainerPath(TEST_CONTAINER_MS, {
      engine: Engine.Meilisearch,
    })
    if (existsSync(msDir)) {
      rmSync(msDir, { recursive: true, force: true })
    }
  })

  describe('saveCredentials', () => {
    it('应将 SQL 凭据保存为 .env 文件', async () => {
      const credentials: UserCredentials = {
        username: 'appuser',
        password: 'PASSWORD',
        connectionString: 'postgresql://appuser:PASSWORD@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      const filePath = await saveCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        credentials,
      )

      assert(existsSync(filePath), '凭据文件应存在')
      assert(
        filePath.endsWith('.env.appuser'),
        '文件应命名为 .env.appuser',
      )

      const content = readFileSync(filePath, 'utf-8')
      assert(content.includes('DB_USER=appuser'), '应包含 DB_USER')
      assert(
        content.includes('DB_PASSWORD=PASSWORD'),
        '应包含 DB_PASSWORD',
      )
      assert(content.includes('DB_HOST=127.0.0.1'), '应包含 DB_HOST')
      assert(content.includes('DB_PORT=5432'), '应包含 DB_PORT')
      assert(content.includes('DB_NAME=mydb'), '应包含 DB_NAME')
      assert(
        content.includes(
          'DB_URL=postgresql://appuser:PASSWORD@127.0.0.1:5432/mydb',
        ),
        '应包含 DB_URL',
      )
    })

    it('应保存 API 密钥凭据', async () => {
      const credentials: UserCredentials = {
        username: 'search_key',
        password: '',
        connectionString: 'http://127.0.0.1:7700',
        engine: Engine.Meilisearch,
        container: TEST_CONTAINER_MS,
        apiKey: 'DUMMY_API_KEY',
      }

      const filePath = await saveCredentials(
        TEST_CONTAINER_MS,
        Engine.Meilisearch,
        credentials,
      )

      const content = readFileSync(filePath, 'utf-8')
      assert(
        content.includes('API_KEY_NAME=search_key'),
        '应包含 API_KEY_NAME',
      )
      assert(
        content.includes('API_KEY=DUMMY_API_KEY'),
        '应包含 API_KEY',
      )
      assert(
        content.includes('API_URL=http://127.0.0.1:7700'),
        '应包含 API_URL',
      )
    })

    it('如果缺失应创建凭据目录', async () => {
      const credentials: UserCredentials = {
        username: 'testuser',
        password: 'pass123',
        connectionString: 'postgresql://testuser:pass123@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      const credDir = join(
        paths.getContainerPath(TEST_CONTAINER, { engine: Engine.PostgreSQL }),
        'credentials',
      )
      assert(!existsSync(credDir), '凭据目录尚不应存在')

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, credentials)

      assert(existsSync(credDir), '凭据目录应已创建')
    })
  })

  describe('loadCredentials', () => {
    it('应加载已保存的 SQL 凭据', async () => {
      const original: UserCredentials = {
        username: 'appuser',
        password: 'secret123',
        connectionString: 'postgresql://appuser:secret123@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, original)
      const loaded = await loadCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        'appuser',
      )

      assert(loaded !== null, '应加载凭据')
      assertEqual(loaded!.username, 'appuser', '用户名应匹配')
      assertEqual(loaded!.password, 'secret123', '密码应匹配')
      assertEqual(loaded!.database, 'mydb', '数据库应匹配')
    })

    it('对不存在的凭据应返回 null', async () => {
      const loaded = await loadCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        'nonexistent',
      )
      assert(loaded === null, '应返回 null')
    })

    it('应加载 API 密钥凭据', async () => {
      const original: UserCredentials = {
        username: 'mykey',
        password: '',
        connectionString: 'http://127.0.0.1:7700',
        engine: Engine.Meilisearch,
        container: TEST_CONTAINER_MS,
        apiKey: 'key123',
      }

      await saveCredentials(TEST_CONTAINER_MS, Engine.Meilisearch, original)
      const loaded = await loadCredentials(
        TEST_CONTAINER_MS,
        Engine.Meilisearch,
        'mykey',
      )

      assert(loaded !== null, '应加载 API 密钥凭据')
      assertEqual(loaded!.apiKey, 'key123', 'API 密钥应匹配')
      assertEqual(
        loaded!.connectionString,
        'http://127.0.0.1:7700',
        'URL 应匹配',
      )
    })
  })

  describe('listCredentials', () => {
    it('应列出所有已保存的凭据', async () => {
      const base: Omit<UserCredentials, 'username' | 'connectionString'> = {
        password: 'pass',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'alice',
        connectionString: 'postgresql://alice:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'bob',
        connectionString: 'postgresql://bob:pass@127.0.0.1:5432/mydb',
      })

      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(users, ['alice', 'bob'], '应将两个用户排序后列出')
    })

    it('无论插入顺序如何都应返回排序结果', async () => {
      const base: Omit<UserCredentials, 'username' | 'connectionString'> = {
        password: 'pass',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      // 按反向字母顺序插入
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'zara',
        connectionString: 'postgresql://zara:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'alice',
        connectionString: 'postgresql://alice:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'mike',
        connectionString: 'postgresql://mike:pass@127.0.0.1:5432/mydb',
      })

      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(
        users,
        ['alice', 'mike', 'zara'],
        '无论插入顺序如何都应按字母顺序排序',
      )
    })

    it('无凭据时应返回空数组', async () => {
      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(users, [], '应返回空数组')
    })
  })

  describe('credentialsExist', () => {
    it('凭据存在时应返回 true', async () => {
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        username: 'testuser',
        password: 'pass',
        connectionString: 'postgresql://testuser:pass@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      })

      assert(
        credentialsExist(TEST_CONTAINER, Engine.PostgreSQL, 'testuser'),
        '应返回 true',
      )
    })

    it('凭据不存在时应返回 false', () => {
      assert(
        !credentialsExist(TEST_CONTAINER, Engine.PostgreSQL, 'nonexistent'),
        '应返回 false',
      )
    })
  })
})
