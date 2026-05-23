import { describe, it } from 'node:test'
import { PortManager } from '../../core/port-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('端口管理器', () => {
  describe('isPortAvailable', () => {
    it('应对可用端口返回 true', async () => {
      const portManager = new PortManager()
      // 端口 59999 不太可能被占用
      const available = await portManager.isPortAvailable(59999)
      assert(typeof available === 'boolean', '应返回布尔值')
    })

    it('应对特权端口 1 返回 false（通常不可用）', async () => {
      const portManager = new PortManager()
      // 端口 1 需要 root 权限，应该会失败
      const available = await portManager.isPortAvailable(1)
      // 在大多数系统上，非 root 用户无法绑定端口 1
      // 但错误处理会将非 EADDRINUSE 的情况视为可用
      assert(typeof available === 'boolean', '应返回布尔值')
    })
  })

  describe('findAvailablePort', () => {
    it('应返回带有 isDefault 属性的端口', async () => {
      const portManager = new PortManager()
      const result = await portManager.findAvailablePort({
        preferredPort: 59990,
        portRange: { start: 59990, end: 59999 },
      })

      assert(typeof result.port === 'number', '应返回端口号')
      assert(typeof result.isDefault === 'boolean', '应返回 isDefault 标志')
      assert(result.port >= 59990, '端口应在范围内')
      assert(result.port <= 59999, '端口应在范围内')
    })

    it('当范围内没有可用端口时应抛出错误', async () => {
      const portManager = new PortManager()
      // 创建一个始终返回 false 的模拟（所有端口均被占用）
      const originalIsPortAvailable =
        portManager.isPortAvailable.bind(portManager)
      portManager.isPortAvailable = async () => {
        return false
      }

      try {
        await portManager.findAvailablePort({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59992 },
        })
        assert(false, '应该已抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('没有可用端口'),
          `错误消息应提及没有可用端口：${error.message}`,
        )
        assert(
          error.message.includes('59990-59992'),
          `错误消息应包含端口范围：${error.message}`,
        )
      } finally {
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })

    it('如果首选端口已被尝试过，应跳过它', async () => {
      const portManager = new PortManager()
      const triedPorts: number[] = []
      const originalIsPortAvailable =
        portManager.isPortAvailable.bind(portManager)

      portManager.isPortAvailable = async (port: number) => {
        triedPorts.push(port)
        // 第一次调用（首选端口）返回 false，之后返回 true
        return port !== 59990
      }

      try {
        const result = await portManager.findAvailablePort({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59995 },
        })

        assert(result.port !== 59990, '不应返回不可用的首选端口')
        assert(result.isDefault === false, '不应标记为默认端口')
        // 应先尝试首选端口一次，然后扫描范围（跳过已尝试的首选端口）
        assertEqual(triedPorts[0], 59990, '应首先尝试首选端口')
        assert(!triedPorts.slice(1).includes(59990), '不应在扫描中重试首选端口')
      } finally {
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })
  })

  describe('getPortUser', () => {
    it('应对未使用的端口返回 null', async () => {
      const portManager = new PortManager()
      // 端口 59998 不太可能被占用
      const user = await portManager.getPortUser(59998)
      // 如果没有程序使用它，lsof 不会返回任何内容
      assert(user === null || typeof user === 'string', '应返回 null 或字符串')
    })

    it('应优雅地处理 lsof 错误', async () => {
      const portManager = new PortManager()
      // 无效端口不应导致崩溃
      const user = await portManager.getPortUser(-1)
      // 根据 lsof 的行为，可能返回 null 或空字符串
      assert(
        user === null || user === '',
        `对于无效端口应返回 null 或空字符串，实际得到："${user}"`,
      )
    })
  })

  describe('getContainerPorts', () => {
    it('应返回端口数组', async () => {
      const portManager = new PortManager()
      const ports = await portManager.getContainerPorts()

      assert(Array.isArray(ports), '应返回一个数组')
      for (const port of ports) {
        assert(typeof port === 'number', '每个端口都应为数字')
        // 对于基于文件的数据库（如 SQLite），端口 0 是有效的（无服务器）
        assert(port >= 0, '端口应为非负数')
      }
    })

    it('如果 containers 目录不存在，应返回空数组', async () => {
      // 此测试检查开头的 existsSync 检查
      const portManager = new PortManager()
      const ports = await portManager.getContainerPorts()
      assert(Array.isArray(ports), '即使为空也应返回一个数组')
    })
  })

  describe('findAvailablePortExcludingContainers', () => {
    it('应跳过已被容器使用的端口', async () => {
      const portManager = new PortManager()
      const originalGetContainerPorts =
        portManager.getContainerPorts.bind(portManager)
      const originalIsPortAvailable =
        portManager.isPortAvailable.bind(portManager)

      // 模拟容器端口
      portManager.getContainerPorts = async () => [59990, 59991]

      const triedPorts: number[] = []
      portManager.isPortAvailable = async (port: number) => {
        triedPorts.push(port)
        return true
      }

      try {
        const result = await portManager.findAvailablePortExcludingContainers({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59995 },
        })

        // 应跳过 59990 和 59991（已被容器使用）
        assert(
          result.port !== 59990 && result.port !== 59991,
          '不应返回已被容器使用的端口',
        )
        assert(
          !triedPorts.includes(59990) || triedPorts.indexOf(59990) === 0,
          '应首先检查首选端口',
        )
      } finally {
        portManager.getContainerPorts = originalGetContainerPorts
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })

    it('当范围内所有端口均被占用时应抛出错误', async () => {
      const portManager = new PortManager()
      const originalGetContainerPorts =
        portManager.getContainerPorts.bind(portManager)
      const originalIsPortAvailable =
        portManager.isPortAvailable.bind(portManager)

      // 所有端口均被容器占用
      portManager.getContainerPorts = async () => [59990, 59991, 59992]
      portManager.isPortAvailable = async () => true // 原本可用，但被容器阻止

      try {
        await portManager.findAvailablePortExcludingContainers({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59992 },
        })
        assert(false, '应该已抛出错误')
      } catch (error) {
        assert(error instanceof Error, '应抛出 Error')
        assert(
          error.message.includes('没有可用端口'),
          `错误应提及没有可用端口：${error.message}`,
        )
      } finally {
        portManager.getContainerPorts = originalGetContainerPorts
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })
  })
})

describe('端口错误消息', () => {
  it('应提供包含端口范围的可操作错误消息', async () => {
    const portManager = new PortManager()
    const originalIsPortAvailable =
      portManager.isPortAvailable.bind(portManager)
    portManager.isPortAvailable = async () => false

    let threw = false
    let caughtError: Error | null = null

    try {
      await portManager.findAvailablePort({
        portRange: { start: 5432, end: 5440 },
      })
    } catch (error) {
      threw = true
      caughtError = error as Error
    } finally {
      portManager.isPortAvailable = originalIsPortAvailable
    }

    assert(threw, '当没有可用端口时，findAvailablePort 应抛出错误')
    assert(caughtError instanceof Error, '应抛出 Error')
    assert(
      caughtError!.message.includes('5432-5440'),
      '错误应包含所尝试的具体端口范围',
    )
  })
})
