import { describe, it } from 'node:test'
import {
  parseCSVToQueryResult,
  parseTSVToQueryResult,
  parseJSONToQueryResult,
  parseClickHouseJSONResult,
  parseSurrealDBResult,
  parseMongoDBResult,
  parseRedisResult,
  parseRESTAPIResult,
} from '../../core/query-parser'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'

describe('Query Parser', () => {
  describe('parseCSVToQueryResult', () => {
    it('should parse simple CSV with headers', () => {
      const csv =
        'id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com'
      const result = parseCSVToQueryResult(csv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        '列名应匹配',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
      assertEqual(result.rows[0].id, 1, '第一行id应为1')
      assertEqual(
        result.rows[0].name,
        'Alice',
        '第一行name应为Alice',
      )
      assertEqual(result.rows[1].id, 2, '第二行id应为2')
    })

    it('should handle quoted fields with commas', () => {
      const csv = 'id,description\n1,"Hello, World"\n2,"Test, with, commas"'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].description,
        'Hello, World',
        '应保留引号字段中的逗号',
      )
      assertEqual(
        result.rows[1].description,
        'Test, with, commas',
        '应处理多个逗号',
      )
    })

    it('should handle escaped quotes', () => {
      const csv = 'id,value\n1,"He said ""hello"""\n2,"Test"'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].value,
        'He said "hello"',
        '应取消转义双引号',
      )
    })

    it('should convert numeric strings to numbers', () => {
      const csv = 'int_val,float_val,str_val\n42,3.14,hello'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rows[0].int_val, 42, '整数应被转换')
      assertEqual(result.rows[0].float_val, 3.14, '浮点数应被转换')
      assertEqual(
        result.rows[0].str_val,
        'hello',
        '字符串应保持为字符串',
      )
    })

    it('should handle NULL values', () => {
      const csv = 'id,value\n1,NULL\n2,\\N\n3,'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rows[0].value, null, 'NULL应转为null')
      assertEqual(result.rows[1].value, null, '\\N应转为null')
      assertEqual(result.rows[2].value, null, '空值应转为null')
    })

    it('should handle boolean values', () => {
      const csv = 'id,active,verified\n1,true,t\n2,false,f'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].active,
        true,
        'true应转为布尔值true',
      )
      assertEqual(result.rows[0].verified, true, 't应转为布尔值true')
      assertEqual(
        result.rows[1].active,
        false,
        'false应转为布尔值false',
      )
      assertEqual(
        result.rows[1].verified,
        false,
        'f应转为布尔值false',
      )
    })

    it('should return empty result for empty input', () => {
      const result = parseCSVToQueryResult('')

      assertDeepEqual(result.columns, [], '列名应为空')
      assertDeepEqual(result.rows, [], '行数据应为空')
      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle header-only CSV', () => {
      const csv = 'id,name,email'
      const result = parseCSVToQueryResult(csv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        '列名应被解析',
      )
      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle Windows line endings', () => {
      const csv = 'id,name\r\n1,Alice\r\n2,Bob'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rowCount, 2, '应处理CRLF换行符')
    })
  })

  describe('parseTSVToQueryResult', () => {
    it('should parse tab-separated values', () => {
      const tsv =
        'id\tname\temail\n1\tAlice\talice@example.com\n2\tBob\tbob@example.com'
      const result = parseTSVToQueryResult(tsv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        '列名应匹配',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
      assertEqual(
        result.rows[0].name,
        'Alice',
        '第一行name应为Alice',
      )
    })

    it('should convert types correctly', () => {
      const tsv = 'int_val\tfloat_val\tbool_val\n42\t3.14\ttrue'
      const result = parseTSVToQueryResult(tsv)

      assertEqual(result.rows[0].int_val, 42, '整数应被转换')
      assertEqual(result.rows[0].float_val, 3.14, '浮点数应被转换')
      assertEqual(result.rows[0].bool_val, true, '布尔值应被转换')
    })

    it('should return empty result for empty input', () => {
      const result = parseTSVToQueryResult('')

      assertEqual(result.rowCount, 0, '行数应为0')
    })
  })

  describe('parseJSONToQueryResult', () => {
    it('should parse array of objects', () => {
      const json = '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        '列名应从第一个对象提取',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
      assertEqual(result.rows[0].id, 1, '第一行id应为1')
    })

    it('should handle empty array', () => {
      const json = '[]'
      const result = parseJSONToQueryResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle single object', () => {
      const json = '{"count":42,"status":"ok"}'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['count', 'status'],
        '列名应匹配对象键',
      )
      assertEqual(result.rowCount, 1, '应有1行数据')
      assertEqual(result.rows[0].count, 42, 'count应为42')
    })

    it('should handle scalar value', () => {
      const json = '42'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['result'],
        '应使用result作为列名',
      )
      assertEqual(result.rows[0].result, 42, '值应被保留')
    })

    it('should handle nested objects', () => {
      const json = '[{"id":1,"data":{"nested":"value"}}]'
      const result = parseJSONToQueryResult(json)

      assertEqual(result.rowCount, 1, '应有1行数据')
      assertDeepEqual(
        result.rows[0].data,
        { nested: 'value' },
        '嵌套对象应被保留',
      )
    })
  })

  describe('parseClickHouseJSONResult', () => {
    it('should parse ClickHouse JSON format', () => {
      const json = JSON.stringify({
        meta: [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String' },
        ],
        data: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rows: 2,
        statistics: { elapsed: 0.001 },
      })
      const result = parseClickHouseJSONResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        '列名应从meta提取',
      )
      assertEqual(result.rowCount, 2, '行数应匹配')
      assertEqual(
        result.executionTimeMs,
        1,
        '执行时间应转换为毫秒',
      )
    })

    it('should handle empty result', () => {
      const json = JSON.stringify({
        meta: [{ name: 'id', type: 'UInt64' }],
        data: [],
        rows: 0,
      })
      const result = parseClickHouseJSONResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle missing statistics', () => {
      const json = JSON.stringify({
        meta: [{ name: 'count', type: 'UInt64' }],
        data: [{ count: 42 }],
        rows: 1,
      })
      const result = parseClickHouseJSONResult(json)

      assertEqual(
        result.executionTimeMs,
        undefined,
        '执行时间应为undefined',
      )
    })
  })

  describe('parseSurrealDBResult', () => {
    it('should parse SurrealDB result format', () => {
      const json = JSON.stringify([
        {
          result: [
            { id: 'user:1', name: 'Alice' },
            { id: 'user:2', name: 'Bob' },
          ],
          status: 'OK',
          time: '1.234ms',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        '列名应被提取',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
      assertEqual(
        result.executionTimeMs,
        1.234,
        '执行时间应被解析',
      )
    })

    it('should handle microsecond timing', () => {
      const json = JSON.stringify([
        {
          result: [{ count: 1 }],
          status: 'OK',
          time: '500µs',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(
        result.executionTimeMs,
        0.5,
        '微秒应转换为毫秒',
      )
    })

    it('should handle second timing', () => {
      const json = JSON.stringify([
        {
          result: [{ count: 1 }],
          status: 'OK',
          time: '1.5s',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(
        result.executionTimeMs,
        1500,
        '秒应转换为毫秒',
      )
    })

    it('should handle empty result', () => {
      const json = JSON.stringify([
        {
          result: [],
          status: 'OK',
          time: '0.1ms',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle empty array response', () => {
      const json = '[]'
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should parse SurrealDB v2 double-nested array format', () => {
      // SurrealDB v2 with --json returns [[{...}, {...}]] format
      const json = JSON.stringify([
        [
          { id: 'user:1', name: 'Alice', email: 'alice@example.com' },
          { id: 'user:2', name: 'Bob', email: 'bob@example.com' },
        ],
      ])
      const result = parseSurrealDBResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        '列名应被提取',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
      assertEqual(result.rows[0].name, 'Alice', '第一行应为Alice')
      assertEqual(result.rows[1].name, 'Bob', '第二行应为Bob')
    })

    it('should handle SurrealDB v2 empty inner array', () => {
      const json = JSON.stringify([[]])
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should ignore SurrealDB prompt lines before JSON output', () => {
      const json = [
        'surrealdb_test/test> SELECT * FROM test_user;',
        JSON.stringify([
          [{ id: 'test_user:1', name: 'Alice' }],
        ]),
      ].join('\n')
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 1, '应解析JSON数据')
      assertEqual(result.rows[0].name, 'Alice', '行数据应被保留')
    })

    it('should ignore SurrealDB prompt text after JSON output', () => {
      const json = [
        JSON.stringify([[{ id: 'test_user:1', name: 'Alice' }]]),
        'surrealdb_test/test> ',
      ].join('\n')
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 1, '应解析第一个JSON文档')
      assertEqual(result.rows[0].name, 'Alice', '尾部提示符应被忽略')
    })
  })

  describe('parseMongoDBResult', () => {
    it('should parse array of documents', () => {
      const json = JSON.stringify([
        { _id: '1', name: 'Alice', age: 30 },
        { _id: '2', name: 'Bob', age: 25 },
      ])
      const result = parseMongoDBResult(json)

      assert(result.columns.includes('_id'), '列名应包含_id')
      assert(result.columns.includes('name'), '列名应包含name')
      assert(result.columns.includes('age'), '列名应包含age')
      assertEqual(result.rowCount, 2, '应有2行数据')
    })

    it('should collect all unique keys from documents with different fields', () => {
      const json = JSON.stringify([
        { _id: '1', name: 'Alice' },
        { _id: '2', email: 'bob@example.com' },
      ])
      const result = parseMongoDBResult(json)

      assert(result.columns.includes('_id'), '列名应包含_id')
      assert(result.columns.includes('name'), '列名应包含name')
      assert(result.columns.includes('email'), '列名应包含email')
    })

    it('should handle empty array', () => {
      const json = '[]'
      const result = parseMongoDBResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle single document', () => {
      const json = '{"_id":"1","name":"Alice"}'
      const result = parseMongoDBResult(json)

      assertEqual(result.rowCount, 1, '应有1行数据')
      assertEqual(result.rows[0].name, 'Alice', 'name应为Alice')
    })
  })

  describe('parseRedisResult', () => {
    it('should parse KEYS command result', () => {
      const output = 'user:1\nuser:2\nuser:3'
      const result = parseRedisResult(output, 'KEYS user:*')

      assertDeepEqual(result.columns, ['value'], '应有value列')
      assertEqual(result.rowCount, 3, '应有3个键')
      assertEqual(result.rows[0].value, 'user:1', '第一个键应匹配')
    })

    it('should parse SMEMBERS command result', () => {
      const output = 'member1\nmember2'
      const result = parseRedisResult(output, 'SMEMBERS myset')

      assertDeepEqual(result.columns, ['value'], '应有value列')
      assertEqual(result.rowCount, 2, '应有2个成员')
    })

    it('should parse HGETALL command result', () => {
      const output = 'field1\nvalue1\nfield2\nvalue2'
      const result = parseRedisResult(output, 'HGETALL myhash')

      assertDeepEqual(
        result.columns,
        ['key', 'value'],
        '应有key和value列',
      )
      assertEqual(result.rowCount, 2, '应有2个键值对')
      assertEqual(result.rows[0].key, 'field1', '第一个key应为field1')
      assertEqual(
        result.rows[0].value,
        'value1',
        '第一个value应为value1',
      )
    })

    it('should parse ZRANGE with WITHSCORES', () => {
      const output = 'member1\n1.5\nmember2\n2.5'
      const result = parseRedisResult(output, 'ZRANGE myset 0 -1 WITHSCORES')

      assertDeepEqual(
        result.columns,
        ['member', 'score'],
        '应有member和score列',
      )
      assertEqual(result.rowCount, 2, '应有2个成员')
      assertEqual(result.rows[0].member, 'member1', '第一个member应匹配')
      assertEqual(result.rows[0].score, 1.5, '第一个score应为1.5')
    })

    it('should parse INFO command result', () => {
      const output = '# Server\nredis_version:7.0.0\nredis_mode:standalone'
      const result = parseRedisResult(output, 'INFO')

      assertDeepEqual(
        result.columns,
        ['key', 'value'],
        '应有key和value列',
      )
      assertEqual(
        result.rows[0].key,
        'redis_version',
        '第一个key应为redis_version',
      )
      assertEqual(result.rows[0].value, '7.0.0', '第一个value应为7.0.0')
    })

    it('should parse TYPE command result', () => {
      const output = 'string'
      const result = parseRedisResult(output, 'TYPE mykey')

      assertDeepEqual(result.columns, ['type'], '应有type列')
      assertEqual(result.rows[0].type, 'string', 'type应为string')
    })

    it('should parse SCAN command result', () => {
      const output = '0\nkey1\nkey2\nkey3'
      const result = parseRedisResult(output, 'SCAN 0')

      assertDeepEqual(result.columns, ['value'], '应有value列')
      assertEqual(result.rowCount, 3, '应有3个键（不包括游标）')
    })

    it('should handle GET command as default', () => {
      const output = 'hello world'
      const result = parseRedisResult(output, 'GET mykey')

      assertDeepEqual(result.columns, ['result'], '应有result列')
      assertEqual(result.rows[0].result, 'hello world', 'result应匹配')
    })

    it('should handle empty output', () => {
      const output = ''
      const result = parseRedisResult(output, 'KEYS nonexistent:*')

      assertEqual(result.rowCount, 0, '行数应为0')
    })
  })

  describe('parseRESTAPIResult', () => {
    it('should parse Qdrant result format', () => {
      const json = JSON.stringify({
        result: [
          { id: 1, payload: { name: 'Alice' } },
          { id: 2, payload: { name: 'Bob' } },
        ],
        status: 'ok',
        time: 0.001,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'payload'],
        '列名应被提取',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
    })

    it('should parse Meilisearch hits format', () => {
      const json = JSON.stringify({
        hits: [
          { id: '1', title: 'Movie 1' },
          { id: '2', title: 'Movie 2' },
        ],
        query: 'action',
        processingTimeMs: 5,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'title'],
        '列名应从hits提取',
      )
      assertEqual(result.rowCount, 2, '应有2个hits')
      assertEqual(
        result.executionTimeMs,
        5,
        '处理时间应被捕获',
      )
    })

    it('should parse CouchDB rows format', () => {
      const json = JSON.stringify({
        rows: [
          { id: 'doc1', key: 'doc1', value: { rev: '1-abc' } },
          { id: 'doc2', key: 'doc2', value: { rev: '1-def' } },
        ],
        total_rows: 2,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'key', 'value'],
        '列名应从rows提取',
      )
      assertEqual(result.rowCount, 2, '应有2行数据')
    })

    it('should handle single object result', () => {
      const json = JSON.stringify({
        result: { name: 'test_collection', vectors_count: 100 },
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 1, '应有1行数据')
      assertEqual(result.rows[0].name, 'test_collection', 'name应匹配')
    })

    it('should handle scalar result', () => {
      const json = JSON.stringify({
        result: 42,
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(
        result.rows[0].result,
        42,
        '标量结果应被保留',
      )
    })

    it('should handle empty array result', () => {
      const json = JSON.stringify({
        result: [],
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 0, '行数应为0')
    })

    it('should handle array of primitives', () => {
      const json = JSON.stringify({
        result: ['collection1', 'collection2', 'collection3'],
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['value'],
        '原始类型应使用value列',
      )
      assertEqual(result.rowCount, 3, '应有3行数据')
      assertEqual(
        result.rows[0].value,
        'collection1',
        '第一个值应匹配',
      )
    })

    it('should fall back to generic JSON parsing', () => {
      const json = '[{"a":1},{"a":2}]'
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 2, '应解析为数组')
    })
  })
})
