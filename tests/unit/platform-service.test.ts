/**
 * 平台服务测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  getCurrentPlatform,
  getCurrentArch,
  isPlatformSupported,
  getPlatformDisplayName,
  getSupportedPlatforms,
} from '../../core/platform-service'

describe('Platform Service', () => {
  describe('getCurrentPlatform', () => {
    it('应返回有效的 platform 字符串', () => {
      const platform = getCurrentPlatform()
      const validPlatforms = ['darwin', 'linux', 'win32']

      assert(
        validPlatforms.includes(platform),
        `Platform "${platform}" 应该是以下之一: ${validPlatforms.join(', ')}`,
      )
    })

    it('应匹配 process.platform', () => {
      const platform = getCurrentPlatform()
      assertEqual(
        platform,
        process.platform,
        '应匹配 process.platform',
      )
    })
  })

  describe('getCurrentArch', () => {
    it('应返回有效的 architecture 字符串', () => {
      const arch = getCurrentArch()
      const validArchs = ['x64', 'arm64', 'ia32']

      assert(
        validArchs.includes(arch),
        `Architecture "${arch}" 应该是以下之一: ${validArchs.join(', ')}`,
      )
    })

    it('应匹配 process.arch', () => {
      const arch = getCurrentArch()
      assertEqual(arch, process.arch, '应匹配 process.arch')
    })
  })

  describe('isPlatformSupported', () => {
    it('应为支持的 platform-arch 组合返回 true', () => {
      assert(
        isPlatformSupported('darwin', 'arm64'),
        'macOS ARM64 应该被支持',
      )
      assert(
        isPlatformSupported('darwin', 'x64'),
        'macOS x64 应该被支持',
      )
      assert(
        isPlatformSupported('linux', 'x64'),
        'Linux x64 应该被支持',
      )
      assert(
        isPlatformSupported('linux', 'arm64'),
        'Linux ARM64 应该被支持',
      )
      assert(
        isPlatformSupported('win32', 'x64'),
        'Windows x64 应该被支持',
      )
    })

    it('应为不支持的平台组合返回 false', () => {
      assert(
        !isPlatformSupported('win32', 'arm64'),
        'Windows ARM64 不应该被支持',
      )
      assert(
        !isPlatformSupported('linux', 'ia32'),
        'Linux ia32 不应该被支持',
      )
    })

    it('应为未知 platform 返回 false', () => {
      assert(
        !isPlatformSupported('freebsd', 'x64'),
        'FreeBSD 不应该被支持',
      )
      assert(
        !isPlatformSupported('aix', 'x64'),
        'AIX 不应该被支持',
      )
    })
  })

  describe('getPlatformDisplayName', () => {
    it('应为 darwin 返回显示名称', () => {
      assertEqual(
        getPlatformDisplayName('darwin'),
        'macOS',
        '应为 darwin 返回 macOS',
      )
    })

    it('应为 linux 返回显示名称', () => {
      assertEqual(
        getPlatformDisplayName('linux'),
        'Linux',
        '应为 linux 返回 Linux',
      )
    })

    it('应为 win32 返回显示名称', () => {
      assertEqual(
        getPlatformDisplayName('win32'),
        'Windows',
        '应为 win32 返回 Windows',
      )
    })

    it('应为未知 platform 返回 platform 本身', () => {
      assertEqual(
        getPlatformDisplayName('freebsd'),
        'freebsd',
        '应为未知 platform 返回 platform 名称',
      )
    })
  })

  describe('getSupportedPlatforms', () => {
    it('应返回支持的 platform 数组', () => {
      const platforms = getSupportedPlatforms()

      assert(Array.isArray(platforms), '应返回数组')
      assert(platforms.length > 0, '应至少有一个 platform')

      // 应包含主要 platform
      assert(
        platforms.includes('darwin'),
        '应包含 darwin',
      )
      assert(
        platforms.includes('linux'),
        '应包含 linux',
      )
      assert(
        platforms.includes('win32'),
        '应包含 win32',
      )
    })

    it('应返回唯一的 platform', () => {
      const platforms = getSupportedPlatforms()
      const uniquePlatforms = [...new Set(platforms)]

      assertEqual(
        platforms.length,
        uniquePlatforms.length,
        '所有 platform 应该是唯一的',
      )
    })
  })
})
