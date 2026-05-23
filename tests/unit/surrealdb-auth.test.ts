import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertEqual } from '../utils/assertions'
import {
  buildSurrealUserConnectionString,
  inferSurrealAuthLevel,
  parseSurrealConnectionString,
} from '../../engines/surrealdb/auth'
import { sanitizeBackupContent } from '../../engines/surrealdb/backup'

describe('SurrealDB 认证辅助函数', () => {
  it('使用连接字符串中的显式 authLevel', () => {
    const connectionString = buildSurrealUserConnectionString({
      username: 'alice',
      password: 'secret',
      port: 8000,
      namespace: 'demo_ns',
      database: 'demo_db',
      authLevel: 'namespace',
    })

    assertEqual(
      inferSurrealAuthLevel({
        username: 'alice',
        database: 'demo_db',
        connectionString,
      }),
      'namespace',
      '显式 authLevel 应优先于启发式推断',
    )
  })

  it('拒绝没有 authLevel 的模糊非 root 连接字符串', () => {
    assert.throws(
      () =>
        inferSurrealAuthLevel({
          username: 'alice',
          database: 'demo_db',
          connectionString:
            'surrealdb://alice:secret@127.0.0.1:8000/demo_ns/demo_db',
        }),
      /must include \?authLevel=/,
    )
  })

  it('将没有 authLevel 的 root 连接字符串解析为 root 认证', () => {
    const parsed = parseSurrealConnectionString(
      'surrealdb://root:root@127.0.0.1:8000/demo_ns/demo_db',
    )

    assertEqual(parsed.authLevel, 'root', 'Root 认证应保持隐式')
  })
})

describe('sanitizeBackupContent', () => {
  it('即使引号值包含分号也移除认证语句', () => {
    const content = [
      "DEFINE USER app ON ROOT PASSWORD 'abc;123' ROLES OWNER;",
      'DEFINE ACCESS api ON DATABASE TYPE RECORD SIGNUP NONE SIGNIN NONE;',
      'OPTION IMPORT;',
      'USE NS demo_ns;',
      'USE DB demo_db;',
      "CREATE item:1 SET password = 'keep;this';",
    ].join('\n')

    const sanitized = sanitizeBackupContent(content)

    assert.equal(
      sanitized.includes('DEFINE USER app'),
      false,
      'DEFINE USER 应被移除',
    )
    assert.equal(
      sanitized.includes('DEFINE ACCESS api'),
      false,
      'DEFINE ACCESS 应被移除',
    )
    assert.equal(
      sanitized.includes('OPTION IMPORT'),
      false,
      'OPTION IMPORT 应被移除',
    )
    assert.equal(
      sanitized.includes('USE NS demo_ns'),
      false,
      'USE NS 应被移除',
    )
    assert.equal(
      sanitized.includes('USE DB demo_db'),
      false,
      'USE DB 应被移除',
    )
    assertEqual(
      sanitized.includes("CREATE item:1 SET password = 'keep;this';"),
      true,
      '引号字符串内包含分号的数据语句应被保留',
    )
  })
})
