/**
 * CockroachDB CLI 工具单元测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  escapeSqlValue,
  parseCsvLine,
  isInsecureConnection,
  escapeCockroachIdentifier,
} from '../../engines/cockroachdb/cli-utils'

describe('CockroachDB CLI Utils', () => {
  describe('escapeSqlValue', () => {
    it('对 null 值应返回 NULL', () => {
      assert.strictEqual(escapeSqlValue(null), 'NULL')
    })

    it('对 undefined 值应返回 NULL', () => {
      assert.strictEqual(escapeSqlValue(undefined), 'NULL')
    })

    it('对未引用的空字符串应返回 NULL', () => {
      assert.strictEqual(escapeSqlValue(''), 'NULL')
      assert.strictEqual(escapeSqlValue('', false), 'NULL')
    })

    it('对引用的空字符串应返回空字符串', () => {
      assert.strictEqual(escapeSqlValue('', true), "''")
    })

    it('应将字面量 NULL 字符串视为字符串值', () => {
      // 字面量 "NULL" 是字符串，不是 SQL NULL - 防止数据损坏
      // CockroachDB CSV 使用未引用的空字段表示 NULL，而非字符串标记
      assert.strictEqual(escapeSqlValue('NULL'), "'NULL'")
    })

    it('应将 \\N 视为字符串值', () => {
      // 字面量 "\\N" 是字符串，不是 SQL NULL - 防止数据损坏
      assert.strictEqual(escapeSqlValue('\\N'), "'\\N'")
    })

    it('应将布尔值类值作为字符串引用（无类型推断）', () => {
      // 所有值都被引用以避免数据损坏 - 数据库处理类型强制
      assert.strictEqual(escapeSqlValue('true'), "'true'")
      assert.strictEqual(escapeSqlValue('TRUE'), "'TRUE'")
      assert.strictEqual(escapeSqlValue('t'), "'t'")
      assert.strictEqual(escapeSqlValue('false'), "'false'")
      assert.strictEqual(escapeSqlValue('FALSE'), "'FALSE'")
      assert.strictEqual(escapeSqlValue('f'), "'f'")
    })

    it('应将数值作为字符串引用（无类型推断）', () => {
      // 所有值都被引用以保留前导零（例如 "001"）
      // 并避免数据损坏 - 数据库处理类型强制
      assert.strictEqual(escapeSqlValue('42'), "'42'")
      assert.strictEqual(escapeSqlValue('-123'), "'-123'")
      assert.strictEqual(escapeSqlValue('3.14'), "'3.14'")
      assert.strictEqual(escapeSqlValue('-0.5'), "'-0.5'")
      assert.strictEqual(escapeSqlValue('001'), "'001'") // 保留前导零
    })

    it('应引用所有字符串值', () => {
      assert.strictEqual(escapeSqlValue('hello'), "'hello'")
      assert.strictEqual(escapeSqlValue('world'), "'world'")
    })

    it('应在字符串中转义单引号', () => {
      assert.strictEqual(escapeSqlValue("it's"), "'it''s'")
      assert.strictEqual(escapeSqlValue("Bob's data"), "'Bob''s data'")
      assert.strictEqual(escapeSqlValue("'quoted'"), "'''quoted'''")
    })

    it('应一致地处理各种字符串格式', () => {
      // 所有非 NULL 值都是引用的字符串
      assert.strictEqual(escapeSqlValue('42abc'), "'42abc'")
      assert.strictEqual(escapeSqlValue('3.14.15'), "'3.14.15'")
      assert.strictEqual(escapeSqlValue('hello world'), "'hello world'")
    })
  })

  describe('parseCsvLine', () => {
    it('应解析无引号的简单 CSV', () => {
      const result = parseCsvLine('a,b,c')
      assert.deepStrictEqual(result, [
        { value: 'a', wasQuoted: false },
        { value: 'b', wasQuoted: false },
        { value: 'c', wasQuoted: false },
      ])
    })

    it('应解析带引用字段的 CSV', () => {
      const result = parseCsvLine('"hello","world"')
      assert.deepStrictEqual(result, [
        { value: 'hello', wasQuoted: true },
        { value: 'world', wasQuoted: true },
      ])
    })

    it('应处理引用字段内的逗号', () => {
      const result = parseCsvLine('"hello, world",test')
      assert.deepStrictEqual(result, [
        { value: 'hello, world', wasQuoted: true },
        { value: 'test', wasQuoted: false },
      ])
    })

    it('应处理转义引号（双引号）', () => {
      const result = parseCsvLine('"say ""hello""",test')
      assert.deepStrictEqual(result, [
        { value: 'say "hello"', wasQuoted: true },
        { value: 'test', wasQuoted: false },
      ])
    })

    it('应处理混合引用和未引用字段', () => {
      const result = parseCsvLine('1,"hello",3')
      assert.deepStrictEqual(result, [
        { value: '1', wasQuoted: false },
        { value: 'hello', wasQuoted: true },
        { value: '3', wasQuoted: false },
      ])
    })

    it('应处理空字段（未引用 - 应变为 NULL）', () => {
      const result = parseCsvLine('a,,c')
      assert.deepStrictEqual(result, [
        { value: 'a', wasQuoted: false },
        { value: '', wasQuoted: false },
        { value: 'c', wasQuoted: false },
      ])
      // 验证未引用空值变为 NULL
      assert.strictEqual(
        escapeSqlValue(result[1].value, result[1].wasQuoted),
        'NULL',
      )
    })

    it('应处理空引用字段（应保留为空字符串）', () => {
      const result = parseCsvLine('"",b,""')
      assert.deepStrictEqual(result, [
        { value: '', wasQuoted: true },
        { value: 'b', wasQuoted: false },
        { value: '', wasQuoted: true },
      ])
      // 验证引用空值变为空字符串，而非 NULL
      assert.strictEqual(
        escapeSqlValue(result[0].value, result[0].wasQuoted),
        "''",
      )
      assert.strictEqual(
        escapeSqlValue(result[2].value, result[2].wasQuoted),
        "''",
      )
    })
  })

  describe('isInsecureConnection', () => {
    it('对 sslmode=disable 应返回 true', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@host:26257/db?sslmode=disable'),
        true,
      )
    })

    it('对无 sslmode 的 localhost 应返回 true', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@localhost:26257/db'),
        true,
      )
      assert.strictEqual(
        isInsecureConnection('postgresql://root@127.0.0.1:26257/db'),
        true,
      )
      assert.strictEqual(
        isInsecureConnection('postgresql://root@[::1]:26257/db'),
        true,
      )
    })

    it('对带 sslmode=require 的 localhost 应返回 false', () => {
      assert.strictEqual(
        isInsecureConnection(
          'postgresql://root@localhost:26257/db?sslmode=require',
        ),
        false,
      )
    })

    it('对无 sslmode 的远程主机应返回 false', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@remote.example.com:26257/db'),
        false,
      )
    })

    it('对带 sslmode=require 的远程主机应返回 false', () => {
      assert.strictEqual(
        isInsecureConnection(
          'postgresql://root@remote.example.com:26257/db?sslmode=require',
        ),
        false,
      )
    })

    it('对无效连接字符串应返回 false', () => {
      assert.strictEqual(isInsecureConnection('not-a-url'), false)
    })
  })

  describe('escapeCockroachIdentifier', () => {
    it('应将标识符用双引号包裹', () => {
      assert.strictEqual(escapeCockroachIdentifier('users'), '"users"')
    })

    it('应转义现有双引号', () => {
      assert.strictEqual(escapeCockroachIdentifier('my"table'), '"my""table"')
    })

    it('应处理保留字', () => {
      assert.strictEqual(escapeCockroachIdentifier('select'), '"select"')
    })
  })
})
