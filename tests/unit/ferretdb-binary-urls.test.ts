/**
 * FerretDB 二进制 URL 生成的单元测试
 *
 * 测试 v1 与 v2 的平台支持及二进制 URL 差异。
 */

import { describe, it } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import {
  isPlatformSupported,
  getBinaryUrls,
  FERRETDB_V1_SUPPORTED_PLATFORMS,
  FERRETDB_V2_SUPPORTED_PLATFORMS,
} from '../../engines/ferretdb/binary-urls'
import { Arch, Platform } from '../../types'

describe('FerretDB Binary URLs', () => {
  describe('FERRETDB_V1_SUPPORTED_PLATFORMS', () => {
    it('应有 5 个条目（包含 Windows）', () => {
      assertEqual(
        FERRETDB_V1_SUPPORTED_PLATFORMS.size,
        5,
        'v1 应该支持 5 个平台',
      )
    })

    it('应包含 win32-x64', () => {
      assert(
        FERRETDB_V1_SUPPORTED_PLATFORMS.has('win32-x64'),
        'v1 应该支持 Windows x64',
      )
    })
  })

  describe('FERRETDB_V2_SUPPORTED_PLATFORMS', () => {
    it('应有 4 个条目（不含 Windows）', () => {
      assertEqual(
        FERRETDB_V2_SUPPORTED_PLATFORMS.size,
        4,
        'v2 应该支持 4 个平台',
      )
    })

    it('不应包含 win32-x64', () => {
      assert(
        !FERRETDB_V2_SUPPORTED_PLATFORMS.has('win32-x64'),
        'v2 不应该支持 Windows x64',
      )
    })
  })

  describe('isPlatformSupported', () => {
    it('v1 下 Windows x64 应返回 true', () => {
      assert(
        isPlatformSupported(Platform.Win32, Arch.X64, '1'),
        'Windows x64 在 v1 下应该被支持',
      )
    })

    it('v2 下 Windows x64 应返回 false', () => {
      assert(
        !isPlatformSupported(Platform.Win32, Arch.X64, '2'),
        'Windows x64 在 v2 下不应该被支持',
      )
    })

    it('v1 下 macOS arm64 应返回 true', () => {
      assert(
        isPlatformSupported(Platform.Darwin, Arch.ARM64, '1'),
        'macOS arm64 在 v1 下应该被支持',
      )
    })

    it('v2 下 macOS arm64 应返回 true', () => {
      assert(
        isPlatformSupported(Platform.Darwin, Arch.ARM64, '2'),
        'macOS arm64 在 v2 下应该被支持',
      )
    })

    it('v1 下 Linux x64 应返回 true', () => {
      assert(
        isPlatformSupported(Platform.Linux, Arch.X64, '1'),
        'Linux x64 在 v1 下应该被支持',
      )
    })

    it('完整 v1 版本字符串应返回 true', () => {
      assert(
        isPlatformSupported(Platform.Win32, Arch.X64, '1.24.2'),
        'Windows x64 在 v1 完整版本下应该被支持',
      )
    })
  })

  describe('getBinaryUrls', () => {
    it('v1 应仅返回 ferretdb URL', () => {
      const urls = getBinaryUrls('1', '17-0.107.0', Platform.Darwin, Arch.ARM64)
      assert(urls.ferretdb !== undefined, '应有 ferretdb URL')
      assert(urls.documentdb === undefined, 'v1 不应有 documentdb URL')
    })

    it('v2 应同时返回 ferretdb 和 documentdb URL', () => {
      const urls = getBinaryUrls('2', '17-0.107.0', Platform.Darwin, Arch.ARM64)
      assert(urls.ferretdb !== undefined, '应有 ferretdb URL')
      assert(urls.documentdb !== undefined, 'v2 应有 documentdb URL')
    })

    it('v1 和 v2 URL 应使用 ferretdb 引擎并带有版本特定路径', () => {
      const v1Urls = getBinaryUrls(
        '1',
        '17-0.107.0',
        Platform.Darwin,
        Arch.ARM64,
      )
      const v2Urls = getBinaryUrls(
        '2',
        '17-0.107.0',
        Platform.Darwin,
        Arch.ARM64,
      )
      assert(
        !v1Urls.ferretdb.includes('ferretdb-v1-'),
        'v1 URL 不应包含 ferretdb-v1 引擎名称',
      )
      assert(
        v1Urls.ferretdb.includes('/ferretdb-1.'),
        'v1 URL 应使用 ferretdb 引擎并带有 v1 版本',
      )
      assert(
        v2Urls.ferretdb.includes('/ferretdb-2.'),
        'v2 URL 应使用 ferretdb 引擎并带有 v2 版本',
      )
    })

    it('v2 在 Windows 上应抛出异常', () => {
      let threw = false
      try {
        getBinaryUrls('2', '17-0.107.0', Platform.Win32, Arch.X64)
      } catch {
        threw = true
      }
      assert(threw, 'v2 在 Windows 上应抛出异常')
    })

    it('v1 在 Windows 上不应抛出异常', () => {
      let threw = false
      try {
        getBinaryUrls('1', '17-0.107.0', Platform.Win32, Arch.X64)
      } catch {
        threw = true
      }
      assert(!threw, 'v1 在 Windows 上不应抛出异常')
    })
  })
})
