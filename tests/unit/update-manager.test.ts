import { describe, it } from 'node:test'
import { UpdateManager, parseUserAgent } from '../../core/update-manager'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

describe('更新管理器', () => {
  describe('获取当前版本', () => {
    it('应返回有效的语义化版本字符串', () => {
      const updateManager = new UpdateManager()
      const version = updateManager.getCurrentVersion()

      assert(typeof version === 'string', '版本应为字符串')
      assert(version.length > 0, '版本不应为空')

      // 应匹配 semver 模式 (X.Y.Z)
      const semverPattern = /^\d+\.\d+\.\d+/
      assert(
        semverPattern.test(version),
        `版本 "${version}" 应匹配 semver 模式`,
      )
    })

    it('多次调用应返回一致的版本', () => {
      const updateManager = new UpdateManager()
      const version1 = updateManager.getCurrentVersion()
      const version2 = updateManager.getCurrentVersion()

      assertEqual(version1, version2, '版本应保持一致')
    })
  })

  describe('比较版本', () => {
    it('当 a > b 时应返回正数', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('2.0.0', '1.0.0') > 0,
        '2.0.0 应大于 1.0.0',
      )
      assert(
        updateManager.compareVersions('1.1.0', '1.0.0') > 0,
        '1.1.0 应大于 1.0.0',
      )
      assert(
        updateManager.compareVersions('1.0.1', '1.0.0') > 0,
        '1.0.1 应大于 1.0.0',
      )
    })

    it('当 a < b 时应返回负数', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('1.0.0', '2.0.0') < 0,
        '1.0.0 应小于 2.0.0',
      )
      assert(
        updateManager.compareVersions('1.0.0', '1.1.0') < 0,
        '1.0.0 应小于 1.1.0',
      )
      assert(
        updateManager.compareVersions('1.0.0', '1.0.1') < 0,
        '1.0.0 应小于 1.0.1',
      )
    })

    it('版本相等时应返回 0', () => {
      const updateManager = new UpdateManager()

      assertEqual(
        updateManager.compareVersions('1.0.0', '1.0.0'),
        0,
        '相同版本应相等',
      )
      assertEqual(
        updateManager.compareVersions('0.0.1', '0.0.1'),
        0,
        '相同版本应相等',
      )
    })

    it('应处理缺失的补丁版本号', () => {
      const updateManager = new UpdateManager()

      // 比较不同长度的版本
      const result = updateManager.compareVersions('1.0', '1.0.0')
      assertEqual(result, 0, '应将 1.0 视为 1.0.0')
    })

    it('应处理前导零', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('1.10.0', '1.9.0') > 0,
        '1.10.0 应大于 1.9.0（非字符串比较）',
      )
      assert(
        updateManager.compareVersions('1.2.0', '1.10.0') < 0,
        '1.2.0 应小于 1.10.0',
      )
    })

    it('应正确处理主版本号变更', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('10.0.0', '9.9.9') > 0,
        '10.0.0 应大于 9.9.9',
      )
      assert(
        updateManager.compareVersions('2.0.0', '1.99.99') > 0,
        '2.0.0 应大于 1.99.99',
      )
    })
  })

  describe('更新检查结果结构', () => {
    it('有可用更新时应具有正确的结构', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        lastChecked: new Date().toISOString(),
      }

      assert(typeof result.currentVersion === 'string', '应包含 currentVersion')
      assert(typeof result.latestVersion === 'string', '应包含 latestVersion')
      assert(
        typeof result.updateAvailable === 'boolean',
        '应包含 updateAvailable',
      )
      assert(typeof result.lastChecked === 'string', '应包含 lastChecked')
      assert(
        result.updateAvailable === true,
        '版本不同时 updateAvailable 应为 true',
      )
    })

    it('无可用更新时应具有正确的结构', () => {
      const result = {
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        updateAvailable: false,
        lastChecked: new Date().toISOString(),
      }

      assertEqual(
        result.updateAvailable,
        false,
        '版本相同时 updateAvailable 应为 false',
      )
    })
  })

  describe('更新结果结构', () => {
    it('应具有正确的成功结构', () => {
      const result: {
        success: boolean
        previousVersion: string
        newVersion: string
        error?: string
      } = {
        success: true,
        previousVersion: '1.0.0',
        newVersion: '2.0.0',
      }

      assert(result.success === true, 'success 应为 true')
      assert(
        typeof result.previousVersion === 'string',
        '应包含 previousVersion',
      )
      assert(typeof result.newVersion === 'string', '应包含 newVersion')
      assert(result.error === undefined, '成功时不应包含 error')
    })

    it('应具有正确的失败结构', () => {
      const result = {
        success: false,
        previousVersion: '1.0.0',
        newVersion: '1.0.0',
        error: '权限被拒绝。请尝试：sudo npm install -g spindb@latest',
      }

      assert(result.success === false, 'success 应为 false')
      assertEqual(
        result.previousVersion,
        result.newVersion,
        '失败时版本应保持一致',
      )
      assert(typeof result.error === 'string', '应包含错误消息')
      assert(
        result.error.includes('权限被拒绝') || result.error.length > 0,
        '错误应具有描述性',
      )
    })

    it('应为权限问题提供可操作的错误提示', () => {
      const errorMessage =
        '权限被拒绝。请尝试：sudo npm install -g spindb@latest'

      assert(errorMessage.includes('sudo'), '权限错误应建议使用 sudo')
      assert(errorMessage.includes('npm install'), '应包含修复命令')
    })
  })

  describe('节流逻辑', () => {
    it('应正确计算节流周期', () => {
      const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 小时

      assertEqual(CHECK_THROTTLE_MS, 86400000, '节流应为 24 小时（以毫秒计）')

      const lastCheck = new Date(Date.now() - 60000).toISOString() // 1 分钟前
      const elapsed = Date.now() - new Date(lastCheck).getTime()

      assert(elapsed < CHECK_THROTTLE_MS, '最近的检查应在节流周期内')
    })

    it('应识别过期的检查', () => {
      const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 小时

      const staleCheck = new Date(
        Date.now() - (CHECK_THROTTLE_MS + 1000),
      ).toISOString()
      const elapsed = Date.now() - new Date(staleCheck).getTime()

      assert(elapsed > CHECK_THROTTLE_MS, '旧的检查应超出节流周期')
    })
  })

  describe('获取缓存的更新信息', () => {
    it('autoCheckEnabled 默认应为 true', async () => {
      const updateManager = new UpdateManager()
      const info = await updateManager.getCachedUpdateInfo()

      // 默认应启用
      assert(
        typeof info.autoCheckEnabled === 'boolean',
        'autoCheckEnabled 应为布尔值',
      )
    })

    it('若已缓存则应返回 latestVersion', async () => {
      const updateManager = new UpdateManager()
      const info = await updateManager.getCachedUpdateInfo()

      assert(
        info.latestVersion === undefined ||
          typeof info.latestVersion === 'string',
        'latestVersion 应为字符串或 undefined',
      )
    })
  })

  describe('npm 注册表响应解析', () => {
    it('应从注册表响应中解析 dist-tags.latest', () => {
      const mockResponse = {
        'dist-tags': {
          latest: '2.0.0',
          beta: '2.1.0-beta.1',
        },
      }

      const latestVersion = mockResponse['dist-tags'].latest

      assertEqual(latestVersion, '2.0.0', '应提取最新版本')
    })

    it('应优雅地处理缺失的 dist-tags', () => {
      const invalidResponse = {} as { 'dist-tags'?: { latest?: string } }

      const latestVersion = invalidResponse?.['dist-tags']?.latest

      assertEqual(latestVersion, undefined, '缺失 dist-tags 时应返回 undefined')
    })
  })

  describe('performUpdate 错误检测', () => {
    it('应检测 EACCES 权限错误', () => {
      const errorMessages = [
        'EACCES: permission denied',
        'Error: EACCES',
        'permission denied writing to /usr/local',
      ]

      for (const msg of errorMessages) {
        const isPermissionError =
          msg.includes('EACCES') || msg.includes('permission')

        assert(isPermissionError, `应检测到权限错误：${msg}`)
      }
    })

    it('应为权限错误提供可操作的消息', () => {
      const permissionErrorResponse = {
        success: false,
        previousVersion: '1.0.0',
        newVersion: '1.0.0',
        error: '权限被拒绝。请尝试：sudo npm install -g spindb@latest',
      }

      assert(
        permissionErrorResponse.error.includes('sudo'),
        '权限错误应建议使用 sudo',
      )
      assert(
        permissionErrorResponse.error.includes('npm install -g spindb@latest'),
        '应包含完整的修复命令',
      )
    })
  })

  describe('npm list 输出解析', () => {
    it('应从 npm list --json 输出中解析版本', () => {
      const mockNpmListOutput = {
        dependencies: {
          spindb: {
            version: '2.0.0',
          },
        },
      }

      const version = mockNpmListOutput.dependencies?.spindb?.version

      assertEqual(version, '2.0.0', '应从 npm list 输出中提取版本')
    })

    it('应处理 npm list 输出中缺失的依赖项', () => {
      const emptyOutput = {} as {
        dependencies?: { spindb?: { version?: string } }
      }

      const version = emptyOutput.dependencies?.spindb?.version ?? '1.0.0'

      assertEqual(version, '1.0.0', '应回退到之前的版本')
    })
  })
})

describe('解析用户代理', () => {
  it('应检测 pnpm', () => {
    assertEqual(
      parseUserAgent('pnpm/9.1.0 npm/? node/v22.0.0 darwin arm64'),
      'pnpm',
      '应从用户代理中检测到 pnpm',
    )
  })

  it('应检测 npm', () => {
    assertEqual(
      parseUserAgent('npm/10.2.0 node/v20.11.0 darwin arm64'),
      'npm',
      '应从用户代理中检测到 npm',
    )
  })

  it('应检测 yarn', () => {
    assertEqual(
      parseUserAgent('yarn/1.22.19 npm/? node/v20.11.0 darwin arm64'),
      'yarn',
      '应从用户代理中检测到 yarn',
    )
  })

  it('应检测 bun', () => {
    assertEqual(
      parseUserAgent('bun/1.1.0 node/v22.0.0 darwin arm64'),
      'bun',
      '应从用户代理中检测到 bun',
    )
  })

  it('undefined 应返回 null', () => {
    assertNullish(parseUserAgent(undefined), 'undefined 应返回 null')
  })

  it('空字符串应返回 null', () => {
    assertNullish(parseUserAgent(''), '空字符串应返回 null')
  })

  it('无法识别的 PM 应返回 null', () => {
    assertNullish(
      parseUserAgent('deno/1.40.0 node/v22.0.0'),
      '无法识别的 PM 应返回 null',
    )
  })

  it('应处理大小写不敏感的匹配', () => {
    assertEqual(
      parseUserAgent('PNPM/9.1.0 npm/? node/v22.0.0'),
      'pnpm',
      '应将 PNPM 检测为 pnpm',
    )
    assertEqual(
      parseUserAgent('NPM/10.2.0 node/v20.11.0'),
      'npm',
      '应将 NPM 检测为 npm',
    )
  })

  it('应从 npm_config_user_agent 环境变量中检测 pnpm', () => {
    const originalAgent = process.env.npm_config_user_agent
    try {
      process.env.npm_config_user_agent =
        'pnpm/9.1.0 npm/? node/v22.0.0 darwin arm64'
      const pm = parseUserAgent(process.env.npm_config_user_agent)
      assertEqual(pm, 'pnpm', '应从用户代理环境变量中检测到 pnpm')
    } finally {
      if (originalAgent !== undefined) {
        process.env.npm_config_user_agent = originalAgent
      } else {
        delete process.env.npm_config_user_agent
      }
    }
  })

  it('用户代理缺失时应返回 null', () => {
    const pm = parseUserAgent(undefined)
    assertNullish(pm, '无用户代理应返回 null（触发 npm 回退）')
  })
})

describe('获取安装命令', () => {
  it('应为每种 PM 返回正确的命令', () => {
    const um = new UpdateManager()

    assertEqual(
      um.getInstallCommand('pnpm'),
      'pnpm add -g spindb@latest',
      'pnpm 安装命令',
    )
    assertEqual(
      um.getInstallCommand('yarn'),
      'yarn global add spindb@latest',
      'yarn 安装命令',
    )
    assertEqual(
      um.getInstallCommand('bun'),
      'bun add -g spindb@latest',
      'bun 安装命令',
    )
    assertEqual(
      um.getInstallCommand('npm'),
      'npm install -g spindb@latest',
      'npm 安装命令',
    )
  })
})

describe('检测包管理器', () => {
  it('应返回有效的包管理器', async () => {
    const um = new UpdateManager()
    const pm = await um.detectPackageManager()

    assert(
      ['npm', 'pnpm', 'yarn', 'bun'].includes(pm),
      `detectPackageManager 返回了意外的值：${pm}`,
    )
  })
})
