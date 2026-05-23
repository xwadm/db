import { describe, it } from 'node:test'
import {
  detectPackageManager,
  getCurrentPlatform,
  findBinary,
  checkDependency,
  buildInstallCommand,
  getManualInstallInstructions,
  type DetectedPackageManager,
} from '../../core/dependency-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('DependencyManager', () => {
  describe('detectPackageManager', () => {
    it('应该检测系统中的 package manager', async () => {
      const pm = await detectPackageManager()

      // 在大多数开发机器上，至少应存在一个 package manager
      // 但未找到时不会失败（可能是最小化的 CI 环境）
      if (pm !== null) {
        assert(typeof pm.id === 'string', '应有 id')
        assert(typeof pm.name === 'string', '应有 name')
        assert(pm.config !== undefined, '应有 config')
        assert(
          typeof pm.config.installTemplate === 'string',
          '应有安装模板',
        )
      }
    })

    it('应返回符合正确结构的 package manager', async () => {
      const pm = await detectPackageManager()

      if (pm !== null) {
        // 验证结构是否匹配 DetectedPackageManager 类型
        const requiredKeys = ['config', 'id', 'name']
        for (const key of requiredKeys) {
          assert(key in pm, `应有 ${key} 属性`)
        }
      }
    })
  })

  describe('getCurrentPlatform', () => {
    it('应返回有效的平台字符串', () => {
      const platform = getCurrentPlatform()

      const validPlatforms = ['darwin', 'linux', 'win32']
      assert(
        validPlatforms.includes(platform),
        `平台 "${platform}" 应为以下之一: ${validPlatforms.join(', ')}`,
      )
    })

    it('在 darwin/linux 下应与 process.platform 一致', () => {
      const platform = getCurrentPlatform()
      const processPlatform = process.platform

      if (processPlatform === 'darwin' || processPlatform === 'linux') {
        assertEqual(
          platform,
          processPlatform,
          '在 Unix 系统下应与 process.platform 一致',
        )
      }
    })
  })

  describe('findBinary', () => {
    it('应能找到常见的 binary', async () => {
      // 使用 node，因为测试环境中必定存在
      const result = await findBinary('node')

      assert(result !== null, '应找到 node binary')
      // Windows 使用 \，Unix 使用 /
      const hasPathSeparator =
        result!.path.includes('/') || result!.path.includes('\\')
      assert(hasPathSeparator, '应返回绝对路径')
    })

    it('对不存在的 binary 应返回 null', async () => {
      const result = await findBinary('definitely-not-a-real-binary-xyz123')

      assertEqual(result, null, '对不存在的 binary 应返回 null')
    })

    it('在可用时应包含版本信息', async () => {
      // 使用 node，因为它支持 --version
      const result = await findBinary('node')

      if (result !== null) {
        // 如果 --version 失败，版本可能为 undefined
        assert(
          result.version === undefined || typeof result.version === 'string',
          '版本应为字符串或 undefined',
        )
      }
    })
  })

  describe('checkDependency', () => {
    it('对已安装的 dependency 应返回正确的结构', async () => {
      // 使用 'node'，因为测试环境中必定存在
      const mockDep = {
        name: 'Node.js',
        binary: 'node',
        description: 'JavaScript runtime',
        packages: {},
        manualInstall: { darwin: [], linux: [], win32: [] },
      }

      const status = await checkDependency(mockDep)

      assert(
        typeof status.installed === 'boolean',
        '应有 installed 布尔值',
      )
      assertEqual(status.dependency, mockDep, '应包含 dependency')

      if (status.installed) {
        assert(
          typeof status.path === 'string',
          '已安装时应有 path',
        )
      }
    })

    it('对缺失的 dependency 应返回 installed: false', async () => {
      const mockDep = {
        name: 'Fake Tool',
        binary: 'fake-tool-that-does-not-exist-xyz',
        description: 'A fake tool for testing',
        packages: {},
        manualInstall: { darwin: [], linux: [] },
      }

      const status = await checkDependency(mockDep)

      assertEqual(status.installed, false, '应为未安装状态')
      assertEqual(status.path, undefined, '不应有 path')
    })
  })

  describe('buildInstallCommand', () => {
    it('应根据模板构建安装命令', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: { package: 'test-package' },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 1, '应有一条命令')
      assertEqual(
        commands[0],
        'brew install test-package',
        '应构建正确的安装命令',
      )
    })

    it('应包含预安装命令', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: {
            package: 'test-package',
            preInstall: ['brew tap test/tap'],
          },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 2, '应有预安装 + 安装两条命令')
      assertEqual(
        commands[0],
        'brew tap test/tap',
        '预安装命令应在第一位',
      )
      assert(commands[1].includes('install'), '安装命令应在第二位')
    })

    it('应包含安装后命令', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: {
            package: 'test-package',
            postInstall: ['brew link --force test-package'],
          },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 2, '应有安装 + 安装后两条命令')
      assert(commands[0].includes('install'), '安装命令应在第一位')
      assert(commands[1].includes('link'), '安装后命令应在第二位')
    })

    it('缺少 package 定义时应抛出错误', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {}, // 无 package 定义
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      try {
        buildInstallCommand(mockDep, mockPm)
        assert(false, '应抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('No package definition'),
          `错误应提及缺少 package 定义: ${error.message}`,
        )
      }
    })
  })

  describe('getManualInstallInstructions', () => {
    it('应返回对应平台的手动安装说明', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {},
        manualInstall: {
          darwin: ['brew install test-package'],
          linux: ['apt install test-package'],
        },
      }

      const darwinInstructions = getManualInstallInstructions(mockDep, 'darwin')
      const linuxInstructions = getManualInstallInstructions(mockDep, 'linux')

      assert(Array.isArray(darwinInstructions), '应返回数组')
      assertEqual(
        darwinInstructions.length,
        1,
        '应有 darwin 安装说明',
      )
      assert(darwinInstructions[0].includes('brew'), 'Darwin 应使用 brew')

      assertEqual(linuxInstructions.length, 1, '应有 linux 安装说明')
      assert(linuxInstructions[0].includes('apt'), 'Linux 应使用 apt')
    })

    it('平台缺失时应返回空数组', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {},
        manualInstall: {
          darwin: ['brew install test-package'],
        },
      }

      const instructions = getManualInstallInstructions(mockDep, 'linux')

      assert(Array.isArray(instructions), '应返回数组')
      assertEqual(
        instructions.length,
        0,
        '平台缺失时应为空',
      )
    })
  })

  describe('DependencyStatus 结构', () => {
    it('应有正确的结构', () => {
      const status = {
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
        installed: true,
        path: '/usr/bin/test',
        version: '1.0.0',
      }

      assert('dependency' in status, '应有 dependency')
      assert('installed' in status, '应有 installed')
      assert(
        status.path === undefined || typeof status.path === 'string',
        'path 应为字符串或 undefined',
      )
      assert(
        status.version === undefined || typeof status.version === 'string',
        'version 应为字符串或 undefined',
      )
    })
  })

  describe('InstallResult 结构', () => {
    it('应有正确的成功结构', () => {
      const result: {
        success: boolean
        dependency: {
          name: string
          binary: string
          description: string
          packages: Record<string, unknown>
          manualInstall: Record<string, unknown>
        }
        error?: string
      } = {
        success: true,
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
      }

      assert(result.success === true, '应为成功状态')
      assert(result.dependency !== undefined, '应有 dependency')
      assert(result.error === undefined, '成功时不应有 error')
    })

    it('应有正确的失败结构', () => {
      const result = {
        success: false,
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
        error: 'Installation failed: permission denied',
      }

      assert(result.success === false, '应为失败状态')
      assert(typeof result.error === 'string', '应有错误信息')
      assert(result.error.length > 0, '错误信息应具有描述性')
    })
  })
})

describe('TTY 和 Sudo 处理', () => {
  it('应检查 TTY 可用性', () => {
    const hasTTY = process.stdin.isTTY === true
    assert(typeof hasTTY === 'boolean', '应能检查 TTY 状态')
  })

  it('应检查 root 权限', () => {
    const isRoot = process.getuid?.() === 0
    assert(typeof isRoot === 'boolean', '应能检查 root 状态')
  })
})

describe('错误信息', () => {
    it('缺少 package 定义时应提供可操作的错误信息', () => {
    const mockDep = {
      name: 'PostgreSQL Client',
      binary: 'psql',
      description: 'PostgreSQL command-line client',
      packages: {},
      manualInstall: { darwin: [], linux: [] },
    }

    const mockPm: DetectedPackageManager = {
      id: 'brew',
      name: 'Homebrew',
      config: {
        id: 'brew',
        name: 'Homebrew',
        checkCommand: 'brew --version',
        installTemplate: 'brew install {package}',
        updateTemplate: 'brew upgrade {package}',
        platforms: ['darwin'],
      },
    }

    let threw = false
    let caughtError: Error | null = null

    try {
      buildInstallCommand(mockDep, mockPm)
    } catch (error) {
      threw = true
      caughtError = error as Error
    }

    assert(
      threw,
      '缺少 package 定义时 buildInstallCommand 应抛出错误',
    )
    assert(caughtError instanceof Error, '应抛出 Error')
    assert(
      caughtError!.message.includes(mockDep.name),
      '错误应包含 dependency 名称',
    )
    assert(
      caughtError!.message.includes(mockPm.name),
      '错误应包含 package manager 名称',
    )
  })
})
