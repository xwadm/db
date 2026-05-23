import { describe, it } from 'node:test'
import { postgresqlBinaryManager } from '../../engines/postgresql/binary-manager'
import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from '../../engines/postgresql/version-maps'
import { assert, assertEqual } from '../utils/assertions'
import { Platform, Arch } from '../../types'

describe('PostgreSQL BinaryManager', () => {
  describe('getFullVersion', () => {
    it('should map major versions to full versions', () => {
      // 从规范版本映射动态派生测试用例
      for (const majorVersion of SUPPORTED_MAJOR_VERSIONS) {
        const expected = POSTGRESQL_VERSION_MAP[majorVersion]
        const result = postgresqlBinaryManager.getFullVersion(majorVersion)
        assertEqual(
          result,
          expected,
          `主版本 ${majorVersion} 应该映射到 ${expected}`,
        )
      }
    })

    it('should return unknown two-part versions unchanged', () => {
      // 不在映射中的未知版本应保持不变（带警告）
      // 这允许在版本不存在时下载失败并显示清晰的错误
      assertEqual(
        postgresqlBinaryManager.getFullVersion('16.9'),
        '16.9',
        '未知的两部分版本应保持不变',
      )
      assertEqual(
        postgresqlBinaryManager.getFullVersion('15.4'),
        '15.4',
        '未知的两部分版本应保持不变',
      )
    })

    it('should return three-part versions unchanged', () => {
      assertEqual(
        postgresqlBinaryManager.getFullVersion('16.9.0'),
        '16.9.0',
        '不应修改三部分版本',
      )
      assertEqual(
        postgresqlBinaryManager.getFullVersion('17.7.0'),
        '17.7.0',
        '不应修改三部分版本',
      )
    })
  })

  describe('getDownloadUrl', () => {
    it('should generate valid layerbase registry URL for darwin-arm64', () => {
      const url = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(
        url.includes('registry.layerbase.host'),
        'URL 应使用 layerbase 注册表',
      )
      assert(
        url.includes('darwin-arm64'),
        'URL 应包含 ARM Mac 的平台标识符',
      )
      assert(url.endsWith('.tar.gz'), 'URL 应指向 tar.gz 文件')
    })

    it('should generate valid URL for darwin-x64', () => {
      const url = postgresqlBinaryManager.getDownloadUrl(
        '16',
        Platform.Darwin,
        Arch.X64,
      )

      assert(
        url.includes('darwin-x64'),
        'URL 应包含 Intel Mac 的平台标识符',
      )
    })

    it('should generate valid URL for linux-x64', () => {
      const url = postgresqlBinaryManager.getDownloadUrl(
        '16',
        Platform.Linux,
        Arch.X64,
      )

      assert(
        url.includes('linux-x64'),
        'URL 应包含 Linux x64 的平台标识符',
      )
    })

    it('should generate valid URL for Windows platform', () => {
      const url = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Win32,
        Arch.X64,
      )

      assert(
        url.includes('registry.layerbase.host'),
        'Windows URL 应使用 layerbase 注册表',
      )
      assert(
        url.includes('win32-x64'),
        'Windows URL 应包含平台标识符',
      )
    })

    it('should throw error for unsupported platform', () => {
      try {
        postgresqlBinaryManager.getDownloadUrl(
          '17',
          'freebsd' as Platform,
          'x64' as Arch,
        )
        assert(false, '应抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('Unsupported platform'),
          `错误应提及不支持的平台: ${error.message}`,
        )
        assert(
          error.message.includes('freebsd-x64'),
          `错误应包含平台键: ${error.message}`,
        )
      }
    })

    it('should include full version in URL', () => {
      const url = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )
      const expectedVersion = POSTGRESQL_VERSION_MAP['17']

      assert(
        url.includes(expectedVersion),
        `URL 应包含完整版本 (${expectedVersion})，而非仅主版本`,
      )
    })
  })

  describe('getBinaryExecutable', () => {
    it('should return correct path for postgres binary', () => {
      const path = postgresqlBinaryManager.getBinaryExecutable(
        '17',
        Platform.Darwin,
        Arch.ARM64,
        'postgres',
      )
      const expectedVersion = POSTGRESQL_VERSION_MAP['17']

      assert(
        path.includes('bin/postgres') || path.includes('bin\\postgres'),
        '路径应包含 bin/postgres',
      )
      assert(
        path.includes(expectedVersion),
        `路径应使用完整版本 (${expectedVersion})`,
      )
    })

    it('should return correct path for pg_ctl binary', () => {
      const path = postgresqlBinaryManager.getBinaryExecutable(
        '16',
        Platform.Darwin,
        Arch.ARM64,
        'pg_ctl',
      )

      assert(
        path.includes('bin/pg_ctl') || path.includes('bin\\pg_ctl'),
        '路径应包含 bin/pg_ctl',
      )
    })

    it('should return correct path for initdb binary', () => {
      const path = postgresqlBinaryManager.getBinaryExecutable(
        '16',
        Platform.Darwin,
        Arch.ARM64,
        'initdb',
      )

      assert(
        path.includes('bin/initdb') || path.includes('bin\\initdb'),
        '路径应包含 bin/initdb',
      )
    })
  })

  describe('listInstalled', () => {
    it('should return array of InstalledBinary objects', async () => {
      const installed = await postgresqlBinaryManager.listInstalled()

      assert(Array.isArray(installed), '应返回数组')

      for (const binary of installed) {
        assert(typeof binary.engine === 'string', '应有引擎')
        assert(typeof binary.version === 'string', '应有版本')
        assert(typeof binary.platform === 'string', '应有平台')
        assert(typeof binary.arch === 'string', '应有架构')
      }
    })
  })

  describe('isInstalled', () => {
    it('should return boolean', async () => {
      const result = await postgresqlBinaryManager.isInstalled(
        '99',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', '应返回布尔值')
      // 版本 99 不应该存在
      assertEqual(result, false, '不存在的版本不应已安装')
    })

    it('should use full version for path checking', async () => {
      // 测试 isInstalled 内部调用 getFullVersion
      const result = await postgresqlBinaryManager.isInstalled(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', '应处理主版本输入')
    })
  })

  describe('verify', () => {
    it('should throw error for non-existent binary', async () => {
      try {
        await postgresqlBinaryManager.verify('99', Platform.Darwin, Arch.ARM64)
        assert(false, '应抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('not found'),
          `错误应指示二进制文件未找到: ${error.message}`,
        )
      }
    })

    it('should parse postgres --version output correctly', () => {
      const testOutputs = [
        { output: 'postgres (PostgreSQL) 16.9', expected: '16.9' },
        { output: 'postgres (PostgreSQL) 17.7', expected: '17.7' },
        { output: 'postgres (PostgreSQL) 15.4', expected: '15.4' },
        // Percona Server 格式（hostdb 二进制文件使用）
        {
          output:
            'postgres (PostgreSQL) 18.1 - Percona Server for PostgreSQL 18.1.1',
          expected: '18.1',
        },
        {
          output:
            'postgres (PostgreSQL) 17.7 - Percona Server for PostgreSQL 17.7.0',
          expected: '17.7',
        },
      ]

      for (const { output, expected } of testOutputs) {
        const match = output.match(/postgres \(PostgreSQL\) ([\d.]+)/)
        assert(match !== null, `应在以下输出中匹配模式: ${output}`)
        assertEqual(match![1], expected, `应提取版本 ${expected}`)
      }
    })
  })

  describe('ensureInstalled', () => {
    it('should invoke progress callback with cached stage when already installed', async () => {
      const isInstalled = await postgresqlBinaryManager.isInstalled(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (isInstalled) {
        const progressCalls: Array<{ stage: string; message: string }> = []

        // 实际调用 ensureInstalled 并验证回调
        await postgresqlBinaryManager.ensureInstalled(
          '17',
          Platform.Darwin,
          Arch.ARM64,
          (progress) => {
            progressCalls.push(progress)
          },
        )

        assert(progressCalls.length > 0, '应调用进度回调')
        assertEqual(
          progressCalls[0].stage,
          'cached',
          '应报告缓存阶段',
        )
        assert(
          progressCalls[0].message.includes('cached'),
          '消息应提及缓存',
        )
      }
    })

    it('should return path to binary directory', async () => {
      const isInstalled = await postgresqlBinaryManager.isInstalled(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (isInstalled) {
        const binPath = await postgresqlBinaryManager.ensureInstalled(
          '17',
          Platform.Darwin,
          Arch.ARM64,
        )
        const expectedVersion = POSTGRESQL_VERSION_MAP['17']

        assert(typeof binPath === 'string', '应返回路径字符串')
        assert(
          binPath.includes(expectedVersion),
          `路径应包含完整版本 (${expectedVersion})`,
        )
        assert(binPath.includes('darwin-arm64'), '路径应包含平台')
      }
    })
  })

  describe('platform mappings via getDownloadUrl', () => {
    it('should use correct hostdb platform identifiers in URLs', () => {
      // 测试 darwin-arm64 使用标准命名
      const armUrl = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Darwin,
        Arch.ARM64,
      )
      assert(armUrl.includes('darwin-arm64'), 'ARM Mac 应使用 darwin-arm64')

      // 测试 darwin-x64 使用标准命名
      const intelUrl = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Darwin,
        Arch.X64,
      )
      assert(intelUrl.includes('darwin-x64'), 'Intel Mac 应使用 darwin-x64')

      // 测试 linux-x64 使用标准命名
      const linuxUrl = postgresqlBinaryManager.getDownloadUrl(
        '17',
        Platform.Linux,
        Arch.X64,
      )
      assert(linuxUrl.includes('linux-x64'), 'Linux x64 应使用 linux-x64')
    })
  })
})
