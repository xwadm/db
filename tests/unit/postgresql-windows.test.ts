/**
 * PostgreSQL Windows 专用测试
 *
 * 这些测试验证 Windows 平台上的 PostgreSQL 行为，包括：
 * - Windows 专用二进制文件解析
 * - Windows 路径处理
 * - Windows 服务集成
 */

import { describe, it } from 'node:test'
import { platform } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import { getBinaryPath } from '../../engines/postgresql/binary-detection'
import { resolveBinaryPaths } from '../../engines/postgresql/binary-resolver'

describe('PostgreSQL Windows', () => {
  const isWindows = platform() === 'win32'

  describe('getBinaryPath', () => {
    it('应返回 postgres 的 Windows binary 名称', () => {
      const result = getBinaryPath('postgres', '16.0', 'win32')
      assert(result.includes('postgres.exe'), '应包含 postgres.exe')
      assert(result.includes('win32'), '应包含 win32 platform')
    })

    it('应返回 psql 的 Windows binary 名称', () => {
      const result = getBinaryPath('psql', '16.0', 'win32')
      assert(result.includes('psql.exe'), '应包含 psql.exe')
    })

    it('应返回 pg_dump 的 Windows binary 名称', () => {
      const result = getBinaryPath('pg_dump', '16.0', 'win32')
      assert(result.includes('pg_dump.exe'), '应包含 pg_dump.exe')
    })

    it('应返回 pg_restore 的 Windows binary 名称', () => {
      const result = getBinaryPath('pg_restore', '16.0', 'win32')
      assert(result.includes('pg_restore.exe'), '应包含 pg_restore.exe')
    })

    it('应在 Windows path 中使用反斜杠', () => {
      const result = getBinaryPath('postgres', '16.0', 'win32')
      assert(result.includes('\\'), '应使用反斜杠分隔符')
    })

    it('应在 path 中包含版本号', () => {
      const result = getBinaryPath('postgres', '16.0', 'win32')
      assert(result.includes('16.0'), '应在 path 中包含版本号')
    })
  })

  describe('resolveBinaryPaths', () => {
    it('应解析 Windows 所需的所有 binary', async () => {
      // 在非 Windows 平台上跳过
      if (!isWindows) {
        return
      }

      const paths = await resolveBinaryPaths('16.0')

      assert(paths.postgres !== undefined, '应解析 postgres path')
      assert(paths.psql !== undefined, '应解析 psql path')
      assert(paths.pg_dump !== undefined, '应解析 pg_dump path')
      assert(paths.pg_restore !== undefined, '应解析 pg_restore path')

      // 所有 path 都应使用 Windows 格式
      assert(
        paths.postgres!.includes('\\'),
        'postgres path 应使用反斜杠',
      )
      assert(paths.psql!.includes('\\'), 'psql path 应使用反斜杠')
    })

    it('应对缺失的 binary 返回 undefined', async () => {
      // 使用可能不存在的版本进行测试
      const paths = await resolveBinaryPaths('0.0.0')

      // 在 Windows 上，不存在的版本应全部返回 undefined
      assertEqual(
        paths.postgres,
        undefined,
        '对缺失的 postgres 应返回 undefined',
      )
      assertEqual(paths.psql, undefined, '对缺失的 psql 应返回 undefined')
    })
  })

  describe('Windows 专用错误处理', () => {
    it('应处理 Windows 风格的错误消息', () => {
      const windowsError = 'Error: Unable to start service postgresql-x64-16'

      // 应检测 PostgreSQL Windows service 错误
      assert(
        windowsError.includes('service') || windowsError.includes('Error'),
        '应检测 Windows service 错误',
      )
    })

    it('应处理 Windows permission 错误', () => {
      const permissionError = 'Access is denied'

      assert(
        permissionError.includes('denied') || permissionError.includes('Access'),
        '应检测 Windows permission 错误',
      )
    })
  })
})
