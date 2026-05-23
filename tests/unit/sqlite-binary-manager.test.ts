import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { sqliteBinaryManager } from '../../engines/sqlite/binary-manager'
import { getBinaryUrl } from '../../engines/sqlite/binary-urls'
import { getHostdbPlatform } from '../../core/hostdb-client'
import {
  normalizeVersion,
  getFullVersion,
  SQLITE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from '../../engines/sqlite/version-maps'
import { Platform, Arch } from '../../types'

// =============================================================================
// 版本映射测试
// =============================================================================

// TODO - 从单一数据源派生版本
describe('SQLite version-maps', () => {
  describe('normalizeVersion', () => {
    it('should map major version 3 to full version', () => {
      const result = normalizeVersion('3')
      assertEqual(result, '3.53.1', '主版本 3 应映射到 3.53.1')
    })

    it('should map minor version 3.51 to full version', () => {
      const result = normalizeVersion('3.51')
      assertEqual(result, '3.51.2', '版本 3.51 应映射到 3.51.2')
    })

    it('should return full version unchanged', () => {
      const result = normalizeVersion('3.51.2')
      assertEqual(result, '3.51.2', '完整版本应保持不变')
    })

    it('should return unknown single-part version unchanged', () => {
      // 映射中不存在的未知版本应原样返回（并发出警告）
      // 这允许在版本不存在时下载失败并显示清晰的错误
      const result = normalizeVersion('4')
      assertEqual(result, '4', '未知主版本应保持不变')
    })

    it('should return unknown two-part version unchanged', () => {
      // 映射中不存在的未知版本应原样返回（并发出警告）
      const result = normalizeVersion('4.0')
      assertEqual(result, '4.0', '未知次版本应保持不变')
    })
  })

  describe('getFullVersion', () => {
    it('should return full version for major version 3', () => {
      const result = getFullVersion('3')
      assertEqual(result, '3.53.1', '应返回主版本 3 的完整版本')
    })

    it('should return null for unknown major version', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, '未知版本应返回 null')
    })
  })

  describe('SQLITE_VERSION_MAP', () => {
    it('should have entries for major version 3', () => {
      assert('3' in SQLITE_VERSION_MAP, '应有主版本 3 的条目')
    })

    it('should have entries for minor version 3.51', () => {
      assert(
        '3.51' in SQLITE_VERSION_MAP,
        '应有次版本 3.51 的条目',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('should include version 3', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('3'),
        '应支持主版本 3',
      )
    })

    it('should have at least one supported version', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        '应至少有一个支持的版本',
      )
    })
  })
})

// =============================================================================
// 二进制 URL 测试
// =============================================================================

describe('SQLite binary-urls', () => {
  describe('getHostdbPlatform', () => {
    it('should return darwin-arm64 for macOS ARM', () => {
      const result = getHostdbPlatform(Platform.Darwin, Arch.ARM64)
      assertEqual(result, 'darwin-arm64', '应返回 darwin-arm64')
    })

    it('should return darwin-x64 for macOS Intel', () => {
      const result = getHostdbPlatform(Platform.Darwin, Arch.X64)
      assertEqual(result, 'darwin-x64', '应返回 darwin-x64')
    })

    it('should return linux-x64 for Linux x64', () => {
      const result = getHostdbPlatform(Platform.Linux, Arch.X64)
      assertEqual(result, 'linux-x64', '应返回 linux-x64')
    })

    it('should return linux-arm64 for Linux ARM', () => {
      const result = getHostdbPlatform(Platform.Linux, Arch.ARM64)
      assertEqual(result, 'linux-arm64', '应返回 linux-arm64')
    })

    it('should return win32-x64 for Windows', () => {
      const result = getHostdbPlatform(Platform.Win32, Arch.X64)
      assertEqual(result, 'win32-x64', '应返回 win32-x64')
    })

    it('should return undefined for unsupported platform', () => {
      // 强制转换为 Platform 以测试无效输入的运行时验证
      const result = getHostdbPlatform('freebsd' as Platform, 'x64' as Arch)
      assertEqual(result, undefined, '不支持的平台应返回 undefined')
    })
  })

  describe('getBinaryUrl', () => {
    it('should generate valid layerbase registry URL for darwin-arm64', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(
        url.includes('registry.layerbase.host'),
        'URL 应使用 layerbase 注册表',
      )
      assert(url.includes('darwin-arm64'), 'URL 应包含 darwin-arm64')
      assert(url.endsWith('.tar.gz'), 'URL 应指向 tar.gz 文件')
    })

    it('should generate valid URL for darwin-x64', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.X64)

      assert(url.includes('darwin-x64'), 'URL 应包含 darwin-x64')
      assert(url.endsWith('.tar.gz'), 'Unix 系统应使用 tar.gz')
    })

    it('should generate valid URL for linux-x64', () => {
      const url = getBinaryUrl('3', Platform.Linux, Arch.X64)

      assert(url.includes('linux-x64'), 'URL 应包含 linux-x64')
      assert(url.endsWith('.tar.gz'), 'Linux 应使用 tar.gz')
    })

    it('should generate valid URL for linux-arm64', () => {
      const url = getBinaryUrl('3', Platform.Linux, Arch.ARM64)

      assert(url.includes('linux-arm64'), 'URL 应包含 linux-arm64')
    })

    it('should generate zip URL for Windows', () => {
      const url = getBinaryUrl('3', Platform.Win32, Arch.X64)

      assert(url.includes('win32-x64'), 'URL 应包含 win32-x64')
      assert(url.endsWith('.zip'), 'Windows 应使用 .zip')
    })

    it('should include full version in URL', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(url.includes('3.53.1'), 'URL 应包含完整版本 3.53.1')
    })

    it('should include sqlite tag in URL', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(
        url.includes('sqlite-3.53.1'),
        'URL 应包含 sqlite 版本标签',
      )
    })

    it('should throw error for unsupported platform', () => {
      try {
        // 使用类型断言测试无效平台的运行时验证
        getBinaryUrl('3', 'freebsd' as Platform, 'x64' as Arch)
        assert(false, '应抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('Unsupported platform'),
          `错误应提及不支持的平台: ${error.message}`,
        )
        assert(
          error.message.includes('freebsd-x64'),
          `错误应包含平台标识: ${error.message}`,
        )
      }
    })
  })
})

// =============================================================================
// 二进制管理器测试
// =============================================================================

describe('SQLiteBinaryManager', () => {
  describe('getFullVersion', () => {
    it('should map major version 3 to full version', () => {
      const result = sqliteBinaryManager.getFullVersion('3')
      assertEqual(result, '3.53.1', '主版本 3 应映射到 3.53.1')
    })

    it('should return full version unchanged', () => {
      const result = sqliteBinaryManager.getFullVersion('3.51.2')
      assertEqual(result, '3.51.2', '完整版本应保持不变')
    })
  })

  describe('getDownloadUrl', () => {
    it('should generate valid hostdb URL', () => {
      const url = sqliteBinaryManager.getDownloadUrl(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(
        url.includes('registry.layerbase.host'),
        'URL 应使用 layerbase 注册表',
      )
      assert(url.includes('3.53.1'), 'URL 应包含完整版本')
      assert(url.includes('darwin-arm64'), 'URL 应包含平台')
    })

    it('should use correct file extension for platform', () => {
      const unixUrl = sqliteBinaryManager.getDownloadUrl(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )
      const winUrl = sqliteBinaryManager.getDownloadUrl(
        '3',
        Platform.Win32,
        Arch.X64,
      )

      assert(unixUrl.endsWith('.tar.gz'), 'Unix 系统应使用 tar.gz')
      assert(winUrl.endsWith('.zip'), 'Windows 应使用 zip')
    })
  })

  describe('getBinaryExecutable', () => {
    it('should return correct path for sqlite3 binary', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3',
      )

      assert(
        path.includes('bin/sqlite3') || path.includes('bin\\sqlite3'),
        '路径应包含 bin/sqlite3',
      )
      assert(path.includes('3.53.1'), '路径应使用完整版本')
      assert(path.includes('darwin-arm64'), '路径应包含平台')
    })

    it('should return correct path for sqldiff binary', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqldiff',
      )

      assert(
        path.includes('bin/sqldiff') || path.includes('bin\\sqldiff'),
        '路径应包含 bin/sqldiff',
      )
    })

    it('should return correct path for sqlite3_analyzer', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3_analyzer',
      )

      assert(
        path.includes('bin/sqlite3_analyzer') ||
          path.includes('bin\\sqlite3_analyzer'),
        '路径应包含 bin/sqlite3_analyzer',
      )
    })

    it('should return correct path for sqlite3_rsync', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3_rsync',
      )

      assert(
        path.includes('bin/sqlite3_rsync') ||
          path.includes('bin\\sqlite3_rsync'),
        '路径应包含 bin/sqlite3_rsync',
      )
    })

    it('should add .exe extension on Windows', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Win32,
        Arch.X64,
        'sqlite3',
      )

      assert(path.endsWith('.exe'), 'Windows 二进制文件应有 .exe 扩展名')
    })
  })

  describe('listInstalled', () => {
    it('should return array of InstalledBinary objects', async () => {
      const installed = await sqliteBinaryManager.listInstalled()

      assert(Array.isArray(installed), '应返回数组')

      for (const binary of installed) {
        assert(binary.engine === 'sqlite', 'engine 应为 sqlite')
        assert(typeof binary.version === 'string', '应有 version')
        assert(typeof binary.platform === 'string', '应有 platform')
        assert(typeof binary.arch === 'string', '应有 arch')
      }
    })
  })

  describe('isInstalled', () => {
    it('should return boolean', async () => {
      const result = await sqliteBinaryManager.isInstalled(
        '99',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', '应返回布尔值')
      assertEqual(result, false, '不存在的版本不应已安装')
    })

    it('should use full version for path checking', async () => {
      const result = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', '应能处理主版本输入')
    })
  })

  describe('verify', () => {
    it('should throw error for non-existent binary', async () => {
      try {
        await sqliteBinaryManager.verify('99', Platform.Darwin, Arch.ARM64)
        assert(false, '应抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('not found'),
          `错误应指示二进制文件未找到: ${error.message}`,
        )
      }
    })

    it('should parse sqlite3 --version output format', () => {
      // 测试用于解析的正则表达式模式
      const testOutputs = [
        { output: '3.51.2 2025-01-08 12:00:00', expected: '3.51.2' },
        { output: '3.45.0 2024-01-01 00:00:00', expected: '3.45.0' },
        { output: '3.40.1 2023-06-15 10:30:00 abc123', expected: '3.40.1' },
      ]

      for (const { output, expected } of testOutputs) {
        const match = output.match(/^(\d+\.\d+\.\d+)/)
        assert(match !== null, `应在以下内容中匹配模式: ${output}`)
        assertEqual(match![1], expected, `应提取版本 ${expected}`)
      }
    })
  })

  describe('ensureInstalled', () => {
    it('should invoke progress callback with cached stage when already installed', async () => {
      const isInstalled = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (!isInstalled) {
        // 跳过: SQLite 二进制文件未在本地安装 - 此测试需要缓存的二进制文件
        return
      }

      const progressCalls: Array<{ stage: string; message: string }> = []

      await sqliteBinaryManager.ensureInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        (progress) => {
          progressCalls.push(progress)
        },
      )

      assert(progressCalls.length > 0, '进度回调应被调用')
      assertEqual(
        progressCalls[0].stage,
        'cached',
        '应报告 cached 阶段',
      )
      assert(
        progressCalls[0].message.includes('cached'),
        '消息应提及 cached',
      )
    })

    it('should return path to binary directory', async () => {
      const isInstalled = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (!isInstalled) {
        // 跳过: SQLite 二进制文件未在本地安装 - 此测试需要缓存的二进制文件
        return
      }

      const binPath = await sqliteBinaryManager.ensureInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof binPath === 'string', '应返回路径字符串')
      assert(binPath.includes('3.53.1'), '路径应包含完整版本')
      assert(binPath.includes('darwin-arm64'), '路径应包含平台')
    })
  })
})
