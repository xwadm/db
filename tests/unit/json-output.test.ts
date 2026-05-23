/**
 * 测试所有带 --json 标志的命令输出有效的 JSON。
 *
 * 此测试套件确保：
 * 1. 带 --json 标志的命令输出纯 JSON（无额外文本）
 * 2. JSON 是可解析的
 * 3. 防止 --json 停止工作的回归问题
 *
 * 注意：需要参数的命令（如容器名称）会单独测试
 * 预期的 JSON 错误输出。
 */

import { describe, it } from 'node:test'
import { execSync } from 'child_process'
import { join } from 'path'

const CLI_PATH = join(process.cwd(), 'cli/bin.ts')

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 运行 CLI 命令并捕获输出
 * @param args - 传递给 CLI 的命令参数
 * @param timeout - 命令超时时间（毫秒，默认：30000，对于 doctor 等慢速命令使用 120000）
 */
function runCommand(args: string, timeout = 30000): CommandResult {
  try {
    const stdout = execSync(`node --import tsx "${CLI_PATH}" ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    }
  }
}

/**
 * 验证输出是否为有效的 JSON
 */
function isValidJson(output: string): { valid: boolean; error?: string } {
  const trimmed = output.trim()

  if (!trimmed) {
    return { valid: false, error: '空输出' }
  }

  try {
    JSON.parse(trimmed)
    return { valid: true }
  } catch (error) {
    const e = error as Error
    return { valid: false, error: e.message }
  }
}

/**
 * 断言输出为有效 JSON，并提供有用的错误信息
 */
function assertValidJson(
  output: string,
  command: string,
): asserts output is string {
  const result = isValidJson(output)
  if (!result.valid) {
    const preview = output.slice(0, 200)
    throw new Error(
      `命令 "${command}" 未输出有效的 JSON。\n` +
        `错误：${result.error}\n` +
        `输出预览：${preview}${output.length > 200 ? '...' : ''}`,
    )
  }
}

describe('JSON 输出验证', () => {
  describe('无需必需参数的命令', () => {
    // 这些命令无需任何参数即可输出有效的 JSON

    it('spindb list --json', () => {
      const result = runCommand('list --json')
      // list --json 即使没有容器也应成功
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'list --json')
        const parsed = JSON.parse(result.stdout.trim())
        // 应输出容器数组
        if (!Array.isArray(parsed)) {
          throw new Error('list --json 应输出数组')
        }
      } else {
        // 如果失败，错误仍应为 JSON
        assertValidJson(result.stdout || result.stderr, 'list --json (错误)')
      }
    })

    it('spindb info --json（列出所有容器）', () => {
      const result = runCommand('info --json')
      // info --json 不带容器名称时列出所有容器
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'info --json')
        const parsed = JSON.parse(result.stdout.trim())
        // 应输出容器信息数组
        if (!Array.isArray(parsed)) {
          throw new Error('info --json 应输出数组')
        }
      }
    })

    it('spindb engines --json', () => {
      const result = runCommand('engines --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'engines --json')
      } else {
        // 如果没有安装引擎可能会失败，但仍应为 JSON 错误
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'engines --json (错误)')
        }
      }
    })

    it('spindb engines list --json', () => {
      const result = runCommand('engines list --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'engines list --json')
      } else {
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'engines list --json (错误)')
        }
      }
    })

    it('spindb databases list --json（所有容器）', () => {
      const result = runCommand('databases list --json')
      // databases list --json 即使没有容器也应成功
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'databases list --json')
        const parsed = JSON.parse(result.stdout.trim())
        // 应输出包含其数据库的容器数组
        if (!Array.isArray(parsed)) {
          throw new Error('databases list --json 应输出数组')
        }
        // 如果有容器，验证结构
        for (const item of parsed) {
          if (!item.container || !item.engine || !item.databases) {
            throw new Error(
              'databases list 项缺少必需字段（container、engine、databases）',
            )
          }
        }
      }
    })

    it('spindb engines supported --json', () => {
      const result = runCommand('engines supported --json')
      // 这应始终成功 - 从 engines.json 读取
      if (result.exitCode !== 0) {
        throw new Error(
          `engines supported --json 以退出码 ${result.exitCode} 失败`,
        )
      }
      assertValidJson(result.stdout, 'engines supported --json')

      // 验证结构
      const parsed = JSON.parse(result.stdout.trim())
      if (!parsed.engines) {
        throw new Error(
          'engines supported --json 应包含 "engines" 对象',
        )
      }
      if (!parsed.engines.postgresql) {
        throw new Error('engines supported --json 应包含 postgresql')
      }
    })

    it('spindb config show --json', () => {
      const result = runCommand('config show --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'config show --json')
      } else {
        // 配置可能不存在，但错误应为 JSON
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'config show --json (错误)')
        }
      }
    })

    it('spindb doctor --json', () => {
      // doctor 命令在 Windows CI 上可能较慢，因为系统检查
      //（为所有 18 个引擎生成二进制检测 - 数十个进程生成）
      const result = runCommand('doctor --json', 120000)
      // doctor --json 应始终输出有效的 JSON
      assertValidJson(result.stdout, 'doctor --json')

      // 验证结构 - doctor 输出检查结果数组
      const parsed = JSON.parse(result.stdout.trim())
      if (!Array.isArray(parsed)) {
        throw new Error('doctor --json 应输出检查数组')
      }
      // 每个检查应有 name 和 status
      for (const check of parsed) {
        if (!check.name || !check.status) {
          throw new Error('doctor 检查缺少必需字段（name、status）')
        }
      }
    })
  })

  describe('需要参数的命令（错误情况）', () => {
    // 这些命令需要参数，缺少参数时应输出 JSON 错误

    it('spindb url --json（无容器）应失败', () => {
      const result = runCommand('url --json')
      // url 需要容器名称
      if (result.exitCode === 0) {
        throw new Error('url --json 无容器参数时应失败')
      }
    })

    it('spindb info nonexistent --json 应输出 JSON 错误', () => {
      const result = runCommand('info nonexistent-container-12345 --json')
      // 应失败，因为容器不存在
      if (result.exitCode === 0) {
        throw new Error('info --json 对不存在的容器应失败')
      }
      // 错误应为 JSON
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'info nonexistent --json')
      }
    })

    it('spindb url nonexistent --json 应输出 JSON 错误', () => {
      const result = runCommand('url nonexistent-container-12345 --json')
      if (result.exitCode === 0) {
        throw new Error('url --json 对不存在的容器应失败')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'url nonexistent --json')
      }
    })

    it('spindb attach /nonexistent/path --json 应输出 JSON 错误', () => {
      const result = runCommand('attach /nonexistent/path/db.sqlite --json')
      if (result.exitCode === 0) {
        throw new Error('attach --json 对不存在的路径应失败')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'attach nonexistent --json')
      }
    })

    it('spindb detach nonexistent --json 应输出 JSON 错误', () => {
      const result = runCommand('detach nonexistent-db-12345 --json')
      if (result.exitCode === 0) {
        throw new Error('detach --json 对不存在的容器应失败')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'detach nonexistent --json')
      }
    })

    it('spindb databases list nonexistent --json 应输出 JSON 错误', () => {
      const result = runCommand(
        'databases list nonexistent-container-12345 --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases list --json 对不存在的容器应失败',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases list nonexistent --json')
        // 验证错误结构
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases list 错误应包含 "error" 字段')
        }
      }
    })

    it('spindb databases add nonexistent db --json 应输出 JSON 错误', () => {
      const result = runCommand(
        'databases add nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases add --json 对不存在的容器应失败',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases add nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases add 错误应包含 "error" 字段')
        }
      }
    })

    it('spindb databases remove nonexistent db --json 应输出 JSON 错误', () => {
      const result = runCommand(
        'databases remove nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases remove --json 对不存在的容器应失败',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases remove nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases remove 错误应包含 "error" 字段')
        }
      }
    })

    it('spindb databases sync nonexistent old new --json 应输出 JSON 错误', () => {
      const result = runCommand(
        'databases sync nonexistent-container-12345 olddb newdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases sync --json 对不存在的容器应失败',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases sync nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases sync 错误应包含 "error" 字段')
        }
      }
    })

    it('spindb databases set-default nonexistent db --json 应输出 JSON 错误', () => {
      const result = runCommand(
        'databases set-default nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases set-default --json 对不存在的容器应失败',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases set-default nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error(
            'databases set-default 错误应包含 "error" 字段',
          )
        }
      }
    })
  })

  describe('JSON 结构验证', () => {
    it('list --json 应具有正确的结构', () => {
      const result = runCommand('list --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        // 应为数组
        if (!Array.isArray(parsed)) {
          throw new Error('list --json 应输出数组')
        }
        // 每个容器应有必需字段（如果存在）
        for (const container of parsed) {
          if (!container.name || !container.engine) {
            throw new Error('容器缺少必需字段（name、engine）')
          }
        }
      }
    })

    it('list --json 应包含引擎元数据字段', () => {
      const result = runCommand('list --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        for (const container of parsed) {
          if (typeof container.queryLanguage !== 'string') {
            throw new Error(
              `容器 "${container.name}" 缺少 queryLanguage 字段`,
            )
          }
          if (
            container.runtime !== 'server' &&
            container.runtime !== 'embedded'
          ) {
            throw new Error(
              `容器 "${container.name}" 的 runtime 无效：${container.runtime}`,
            )
          }
          if (
            container.connectionScheme !== null &&
            typeof container.connectionScheme !== 'string'
          ) {
            throw new Error(
              `容器 "${container.name}" 缺少 connectionScheme 字段`,
            )
          }
        }
      }
    })

    it('info --json 应包含引擎元数据字段', () => {
      const result = runCommand('info --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        const containers = Array.isArray(parsed) ? parsed : [parsed]
        for (const container of containers) {
          if (typeof container.queryLanguage !== 'string') {
            throw new Error(
              `容器 "${container.name}" 在 info 中缺少 queryLanguage`,
            )
          }
          if (
            container.runtime !== 'server' &&
            container.runtime !== 'embedded'
          ) {
            throw new Error(
              `容器 "${container.name}" 在 info 中的 runtime 无效：${container.runtime}`,
            )
          }
          if (
            container.connectionScheme !== null &&
            typeof container.connectionScheme !== 'string'
          ) {
            throw new Error(
              `容器 "${container.name}" 在 info 中缺少 connectionScheme`,
            )
          }
        }
      }
    })

    it('engines --json 应包含引擎元数据字段', () => {
      const result = runCommand('engines --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        if (Array.isArray(parsed)) {
          for (const engine of parsed) {
            if (typeof engine.queryLanguage !== 'string') {
              throw new Error(`引擎 "${engine.engine}" 缺少 queryLanguage`)
            }
            if (engine.runtime !== 'server' && engine.runtime !== 'embedded') {
              throw new Error(
                `引擎 "${engine.engine}" 的 runtime 无效：${engine.runtime}`,
              )
            }
            if (
              engine.connectionScheme !== null &&
              typeof engine.connectionScheme !== 'string'
            ) {
              throw new Error(
                `引擎 "${engine.engine}" 缺少 connectionScheme`,
              )
            }
          }
        }
      }
    })

    it('databases list --json 应包含引擎元数据字段', () => {
      const result = runCommand('databases list --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item.queryLanguage !== 'string') {
              throw new Error(
                `databases list 项 "${item.container}" 缺少 queryLanguage`,
              )
            }
            if (item.runtime !== 'server' && item.runtime !== 'embedded') {
              throw new Error(
                `databases list 项 "${item.container}" 的 runtime 无效：${item.runtime}`,
              )
            }
            if (
              item.connectionScheme !== null &&
              typeof item.connectionScheme !== 'string'
            ) {
              throw new Error(
                `databases list 项 "${item.container}" 缺少 connectionScheme`,
              )
            }
          }
        }
      }
    })

    it('engines supported --json 应具有正确的结构', () => {
      const result = runCommand('engines supported --json')
      const parsed = JSON.parse(result.stdout.trim())

      // 验证 schema 引用
      if (!parsed.$schema) {
        throw new Error('缺少 "$schema" 字段')
      }

      // 验证 engines 对象
      if (!parsed.engines || typeof parsed.engines !== 'object') {
        throw new Error('缺少或无效的 "engines" 对象')
      }

      // 验证至少一个引擎具有必需字段
      const postgresql = parsed.engines.postgresql
      if (!postgresql) {
        throw new Error('缺少 postgresql 引擎')
      }
      if (!postgresql.displayName || !postgresql.defaultVersion) {
        throw new Error('PostgreSQL 缺少必需字段')
      }
    })

    it('doctor --json 应具有正确的结构', () => {
      // doctor 命令在 Windows CI 上可能较慢，因为系统检查
      //（为所有 18 个引擎生成二进制检测 - 数十个进程生成）
      const result = runCommand('doctor --json', 120000)
      const parsed = JSON.parse(result.stdout.trim())

      // doctor 输出检查数组
      if (!Array.isArray(parsed)) {
        throw new Error('doctor --json 应输出数组')
      }

      // 每个检查应有 name、status 和 message
      for (const check of parsed) {
        if (!check.name) {
          throw new Error('检查缺少 "name" 字段')
        }
        if (!check.status) {
          throw new Error('检查缺少 "status" 字段')
        }
        if (!['ok', 'warning', 'error'].includes(check.status)) {
          throw new Error(`无效的检查状态：${check.status}`)
        }
      }
    })
  })
})
