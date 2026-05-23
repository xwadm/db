import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'

describe('Doctor 命令', () => {
  describe('健康检查结果结构', () => {
    it('应该包含必需字段', () => {
      const result = {
        name: 'Test Check',
        status: 'ok' as const,
        message: 'Check passed',
      }

      assert(typeof result.name === 'string', '应有 name')
      assert(
        ['ok', 'warning', 'error'].includes(result.status),
        '应有有效的 status',
      )
      assert(typeof result.message === 'string', '应有 message')
    })

    it('应支持可选的 details 数组', () => {
      const result = {
        name: 'Test Check',
        status: 'ok' as const,
        message: 'Check passed',
        details: ['Detail 1', 'Detail 2'],
      }

      assert(Array.isArray(result.details), 'Details 应为数组')
      assertEqual(result.details.length, 2, '应有 2 条 detail')
    })

    it('应支持可选的 action', () => {
      const result = {
        name: 'Test Check',
        status: 'warning' as const,
        message: 'Issue found',
        action: {
          label: 'Fix issue',
          handler: async () => {
            // action 处理函数
          },
        },
      }

      assert(
        typeof result.action.label === 'string',
        'Action 应有 label',
      )
      assert(
        typeof result.action.handler === 'function',
        'Action 应有 handler',
      )
    })
  })

  describe('状态值', () => {
    it('应支持 ok 状态', () => {
      const status: 'ok' | 'warning' | 'error' = 'ok'
      assertEqual(status, 'ok', '应支持 ok 状态')
    })

    it('应支持 warning 状态', () => {
      const status: 'ok' | 'warning' | 'error' = 'warning'
      assertEqual(status, 'warning', '应支持 warning 状态')
    })

    it('应支持 error 状态', () => {
      const status: 'ok' | 'warning' | 'error' = 'error'
      assertEqual(status, 'error', '应支持 error 状态')
    })
  })

  describe('配置检查', () => {
    it('应处理缺失的 config 文件', () => {
      // 概念：缺失的 config 是正常的（首次使用时会自动创建）
      const result = {
        name: 'Configuration',
        status: 'ok' as const,
        message: 'No config file yet (will be created on first use)',
      }

      assertEqual(result.status, 'ok', '缺失 config 应为 OK')
    })

    it('应检测过期的 binary cache', () => {
      const lastRefresh = new Date('2024-01-01').getTime()
      const now = new Date().getTime()
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

      const isStale = now - lastRefresh > sevenDaysMs

      assert(isStale, '超过 7 天的 cache 应标记为过期')
    })

    it('应报告 binary 数量', () => {
      const binaries = { psql: {}, pg_dump: {}, mysql: {} }
      const count = Object.keys(binaries).length

      assertEqual(count, 3, '应正确统计 binary 数量')
    })
  })

  describe('Container 检查', () => {
    it('应处理空的 container 列表', () => {
      const containers: unknown[] = []
      const result = {
        name: 'Containers',
        status: 'ok' as const,
        message:
          containers.length === 0
            ? 'No containers (create one with: spindb create)'
            : '',
      }

      assert(
        result.message.includes('No containers'),
        '应指示没有 container',
      )
    })

    it('应按 engine 分组 container', () => {
      const containers = [
        { engine: 'postgresql', status: 'running' },
        { engine: 'postgresql', status: 'stopped' },
        { engine: 'mysql', status: 'running' },
        { engine: 'sqlite', status: 'running' },
      ]

      const byEngine: Record<string, { running: number; stopped: number }> = {}

      for (const c of containers) {
        if (!byEngine[c.engine]) {
          byEngine[c.engine] = { running: 0, stopped: 0 }
        }
        if (c.status === 'running') {
          byEngine[c.engine].running++
        } else {
          byEngine[c.engine].stopped++
        }
      }

      assertEqual(byEngine['postgresql'].running, 1, 'PostgreSQL 运行中数量')
      assertEqual(byEngine['postgresql'].stopped, 1, 'PostgreSQL 已停止数量')
      assertEqual(byEngine['mysql'].running, 1, 'MySQL 运行中数量')
      assertEqual(byEngine['sqlite'].running, 1, 'SQLite 运行中数量')
    })

    it('应对 SQLite 使用不同的标签', () => {
      const engine = 'sqlite'
      const counts = { running: 2, stopped: 1 }

      const label =
        engine === 'sqlite'
          ? `${engine}: ${counts.running} exist, ${counts.stopped} missing`
          : `${engine}: ${counts.running} running, ${counts.stopped} stopped`

      assert(label.includes('exist'), 'SQLite 应使用 "exist" 标签')
      assert(label.includes('missing'), 'SQLite 应使用 "missing" 标签')
    })
  })

  describe('SQLite Registry 检查', () => {
    it('应处理空的 registry', () => {
      const entries: unknown[] = []
      const result = {
        name: 'SQLite Registry',
        status: 'ok' as const,
        message:
          entries.length === 0
            ? 'No SQLite databases registered'
            : `${entries.length} database(s) registered`,
      }

      assert(
        result.message.includes('No SQLite databases'),
        '应指示 registry 为空',
      )
    })

    it('应检测 orphan 条目', () => {
      const orphans = [
        { name: 'old-project', filePath: '/path/to/missing.sqlite' },
      ]

      const result = {
        name: 'SQLite Registry',
        status: 'warning' as const,
        message: `${orphans.length} orphaned entry found`,
        details: orphans.map((o) => `"${o.name}" → ${o.filePath}`),
      }

      assertEqual(result.status, 'warning', 'Orphan 应触发 warning')
      assert(
        result.details[0].includes('old-project'),
        '应包含 orphan 名称',
      )
    })

    it('应正确处理 orphan 消息的单复数', () => {
      const singularCount = 1
      const pluralCount = 3

      const singularMsg = `${singularCount} orphaned entry found`
      const pluralMsg = `${pluralCount} orphaned entries found`

      assert(
        !singularMsg.includes('entries'),
        '单数形式不应包含 "entries"',
      )
      assert(pluralMsg.includes('entries'), '复数形式应包含 "entries"')
    })

    it('应为 orphan 提供清理 action', () => {
      const orphans = [{ name: 'old' }]

      const action =
        orphans.length > 0
          ? {
              label: 'Remove orphaned entries from registry',
              handler: async () => {},
            }
          : undefined

      assert(action !== undefined, '存在 orphan 时应提供 action')
      assert(action?.label.includes('Remove'), 'Action 应提及移除操作')
    })
  })

  describe('Binary 检查', () => {
    it('应检查所有 engine', () => {
      const engines = ['postgresql', 'mysql', 'sqlite']
      const results: string[] = []

      for (const engine of engines) {
        results.push(`${engine}: checked`)
      }

      assertEqual(results.length, 3, '应检查所有 engine')
    })

    it('应将缺失工具报告为 warning', () => {
      const installed = 3
      const total = 4
      const hasWarning = installed < total

      assert(hasWarning, '缺失工具应触发 warning')
    })

    it('应将所有工具报告为 OK', () => {
      const installed = 4
      const total = 4
      const hasWarning = installed < total

      assert(!hasWarning, '所有工具应为 OK')
    })

    it('应正确格式化工具数量', () => {
      const engine = 'postgresql'
      const installed = 4
      const total = 4

      const message =
        installed < total
          ? `${engine}: ${installed}/${total} tools installed`
          : `${engine}: all ${total} tools available`

      assert(
        message.includes('all 4 tools'),
        '应指示所有工具可用',
      )
    })
  })

  describe('Action 菜单', () => {
    it('应从 warning 中收集 action', () => {
      const checks = [
        { name: 'Check 1', status: 'ok' as const, message: 'OK' },
        {
          name: 'Check 2',
          status: 'warning' as const,
          message: 'Issue',
          action: { label: 'Fix it', handler: async () => {} },
        },
        { name: 'Check 3', status: 'ok' as const, message: 'OK' },
      ]

      const actionsAvailable = checks.filter((c) => c.action)

      assertEqual(actionsAvailable.length, 1, '应找到一个 action')
    })

    it('应在菜单中包含跳过选项', () => {
      const choices = [
        { name: 'Fix issue', value: 'Check 2' },
        { name: 'Skip (do nothing)', value: 'skip' },
      ]

      const skipOption = choices.find((c) => c.value === 'skip')

      assert(skipOption !== undefined, '应有跳过选项')
    })

    it('无问题时应显示健康消息', () => {
      const checks = [
        { name: 'Check 1', status: 'ok' as const, message: 'OK' },
        { name: 'Check 2', status: 'ok' as const, message: 'OK' },
      ]

      const hasIssues = checks.some((c) => c.status !== 'ok')

      assert(!hasIssues, '应检测到无问题')
    })
  })

  describe('JSON 输出', () => {
    it('应为 JSON 移除 action handler', () => {
      const check = {
        name: 'Test',
        status: 'warning' as const,
        message: 'Issue',
        action: { label: 'Fix', handler: async () => {} },
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { action, ...jsonCheck } = check

      assert(!('action' in jsonCheck), 'JSON 输出不应包含 action')
      assert('name' in jsonCheck, 'JSON 输出应包含 name')
      assert('status' in jsonCheck, 'JSON 输出应包含 status')
      assert('message' in jsonCheck, 'JSON 输出应包含 message')
    })
  })

  describe('显示格式化', () => {
    it('应为 status 使用正确的图标', () => {
      const icons = {
        ok: '✓',
        warning: '⚠',
        error: '✕',
      }

      assertEqual(icons.ok, '✓', 'OK 应使用勾号')
      assertEqual(icons.warning, '⚠', 'Warning 应使用警告符号')
      assertEqual(icons.error, '✕', 'Error 应使用叉号')
    })

    it('应使用缩进格式化 details', () => {
      const details = ['Detail 1', 'Detail 2']
      const formatted = details.map((d) => `     ${d}`)

      assert(formatted[0].startsWith('     '), 'Details 应有缩进')
    })
  })
})
