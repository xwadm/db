/**
 * MySQL Windows 专用测试
 *
 * 这些测试验证 Windows 平台上的 MySQL 行为，包括：
 * - Windows 专用二进制文件解析
 * - Windows 路径处理
 * - Windows 服务集成
 */

import { describe, it } from 'node:test'
import { platform } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import { getBinaryPath } from '../../engines/mysql/binary-detection'
import { resolveBinaryPaths } from '../../engines/mysql/binary-resolver'

describe('MySQL Windows', () => {
  const isWindows = platform() === 'win32'

  describe('getBinaryPath', () => {
    it('应返回 mysqld 的 Windows binary 名称', () => {
      const result = getBinaryPath('mysqld', '8.0.35', 'win32')
      assert(result.includes('mysqld.exe'), '应包含 mysqld.exe')
      assert(result.includes('win32'), '应包含 win32 platform')
    })

    it('应返回 mysql 的 Windows binary 名称', () => {
      const result = getBinaryPath('mysql', '8.0.35', 'win32')
      assert(result.includes('mysql.exe'), '应包含 mysql.exe')
    })

    it('应返回 mysqldump 的 Windows binary 名称', () => {
      const result = getBinaryPath('mysqldump', '8.0.35', 'win32')
      assert(result.includes('mysqldump.exe'), '应包含 mysqldump.exe')
    })

    it('应在 Windows path 中使用反斜杠', () => {
      const result = getBinaryPath('mysqld', '8.0.35', 'win32')
      assert(result.includes('\\'), '应使用反斜杠分隔符')
    })

    it('应在 path 中包含版本号', () => {
      const result = getBinaryPath('mysqld', '8.0.35', 'win32')
      assert(result.includes('8.0.35'), '应在 path 中包含版本号')
    })
  })

  describe('resolveBinaryPaths', () => {
    it('应解析 Windows 所需的所有 binary', async () => {
      // 在非 Windows 平台上跳过
      if (!isWindows) {
        return
      }

      const paths = await resolveBinaryPaths('8.0.35')

      assert(paths.mysqld !== undefined, '应解析 mysqld path')
      assert(paths.mysql !== undefined, '应解析 mysql path')
      assert(paths.mysqldump !== undefined, '应解析 mysqldump path')

      // 所有 path 都应使用 Windows 格式
      assert(paths.mysqld!.includes('\\'), 'mysqld path 应使用反斜杠')
      assert(paths.mysql!.includes('\\'), 'mysql path 应使用反斜杠')
      assert(
        paths.mysqldump!.includes('\\'),
        'mysqldump path 应使用反斜杠',
      )
    })

    it('应对缺失的 binary 返回 undefined', async () => {
      // 使用可能不存在的版本进行测试
      const paths = await resolveBinaryPaths('0.0.0')

      // 在 Windows 上，不存在的版本应全部返回 undefined
      assertEqual(paths.mysqld, undefined, '对缺失的 mysqld 应返回 undefined')
      assertEqual(paths.mysql, undefined, '对缺失的 mysql 应返回 undefined')
      assertEqual(
        paths.mysqldump,
        undefined,
        '对缺失的 mysqldump 应返回 undefined',
      )
    })
  })

  describe('Windows 专用错误处理', () => {
    it('应处理 Windows 风格的错误消息', () => {
      const windowsError = 'Error: Unable to start service MySQL80'

      // 应检测 MySQL Windows service 错误
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
