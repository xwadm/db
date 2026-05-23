/**
 * PostgreSQL 版本验证器单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseToolVersion,
  checkVersionCompatibility,
  isValidVersionString,
  compareVersions,
} from '../../engines/postgresql/version-validator'

describe('PostgreSQL 版本验证器', () => {
  describe('parseToolVersion', () => {
    it('应该解析 psql 版本输出', () => {
      const version = parseToolVersion('psql (PostgreSQL) 17.7')
      assertEqual(version, '17.7', '应该解析出 17.7')
    })

    it('应该解析 pg_dump 版本输出', () => {
      const version = parseToolVersion('pg_dump (PostgreSQL) 16.4')
      assertEqual(version, '16.4', '应该解析出 16.4')
    })

    it('应该解析带详细信息的版本', () => {
      const version = parseToolVersion('pg_dump (PostgreSQL) 15.3 (Ubuntu 15.3-1.pgdg22.04+1)')
      assertEqual(version, '15.3', '应该解析出 15.3')
    })

    it('应该对无效输出返回 null', () => {
      const version = parseToolVersion('invalid output')
      assertEqual(version, null, '无效输出应该返回 null')
    })

    it('应该处理空输入', () => {
      const version = parseToolVersion('')
      assertEqual(version, null, '空输入应该返回 null')
    })
  })

  describe('checkVersionCompatibility', () => {
    it('应该接受相同主版本的客户端', () => {
      const result = checkVersionCompatibility('17.7', '17.2')
      assert(result.compatible, '相同主版本应该兼容')
      assertEqual(result.warning, undefined, '不应该有警告')
    })

    it('应该接受较新的客户端连接较旧的服务器', () => {
      const result = checkVersionCompatibility('17.7', '16.4')
      assert(result.compatible, '较新的客户端应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })

    it('应该警告较旧的客户端连接较新的服务器', () => {
      const result = checkVersionCompatibility('16.4', '17.7')
      assert(result.compatible, '较旧的客户端应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })

    it('应该拒绝主版本差距过大的组合', () => {
      const result = checkVersionCompatibility('15.0', '17.7')
      assert(!result.compatible, '主版本差距过大不应该兼容')
      assert(result.warning !== undefined, '应该有警告')
    })

    it('应该处理无效的客户端版本', () => {
      const result = checkVersionCompatibility('invalid', '17.7')
      assert(!result.compatible, '无效版本不应该兼容')
    })

    it('应该处理无效的服务器版本', () => {
      const result = checkVersionCompatibility('17.7', 'invalid')
      assert(!result.compatible, '无效版本不应该兼容')
    })
  })

  describe('isValidVersionString', () => {
    it('应该接受有效的版本字符串', () => {
      assert(isValidVersionString('17.7'), '17.7 应该有效')
      assert(isValidVersionString('16.4.2'), '16.4.2 应该有效')
      assert(isValidVersionString('15'), '15 应该有效')
    })

    it('应该拒绝无效的版本字符串', () => {
      assert(!isValidVersionString(''), '空字符串应该无效')
      assert(!isValidVersionString('latest'), 'latest 应该无效')
      assert(!isValidVersionString('17.x'), '17.x 应该无效')
    })

    it('应该接受带 v 前缀的版本', () => {
      assert(isValidVersionString('v17.7'), 'v17.7 应该有效')
      assert(isValidVersionString('v16'), 'v16 应该有效')
    })
  })

  describe('compareVersions', () => {
    it('应该正确比较相等版本', () => {
      assertEqual(compareVersions('17.7', '17.7'), 0, '相等版本应该返回 0')
      assertEqual(compareVersions('16.4.2', '16.4.2'), 0, '相等版本应该返回 0')
    })

    it('应该正确比较不同版本', () => {
      assertEqual(compareVersions('17.7', '16.4'), 1, '17.7 > 16.4')
      assertEqual(compareVersions('16.4', '17.7'), -1, '16.4 < 17.7')
      assertEqual(compareVersions('17.7', '17.6'), 1, '17.7 > 17.6')
      assertEqual(compareVersions('17.6', '17.7'), -1, '17.6 < 17.7')
    })

    it('应该处理不同长度的版本', () => {
      assertEqual(compareVersions('17', '17.0'), 0, '17 == 17.0')
      assertEqual(compareVersions('17.7', '17.7.0'), 0, '17.7 == 17.7.0')
      assertEqual(compareVersions('17', '16.4'), 1, '17 > 16.4')
    })

    it('应该对无效版本返回 null', () => {
      assertEqual(compareVersions('invalid', '17.7'), null, '无效版本应该返回 null')
      assertEqual(compareVersions('17.7', 'invalid'), null, '无效版本应该返回 null')
    })
  })
})
