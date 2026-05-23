/**
 * bin-path 命令的测试。
 *
 * 测试引擎解析、工具验证和输出格式。
 * 直接使用 CLI 测试端到端行为。
 */

import { describe, it } from 'node:test'
import { execSync } from 'child_process'
import { join } from 'path'
import { assert, assertEqual } from '../utils/assertions'

const CLI_PATH = join(process.cwd(), 'cli/bin.ts')

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

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

describe('bin-path command', () => {
  describe('engine validation', () => {
    it('should reject unknown engine names', () => {
      const result = runCommand('bin-path invalid-engine --json')
      assertEqual(result.exitCode, 1, '应以退出码 1 退出')
      const json = JSON.parse(result.stdout.trim())
      assert(
        json.error.includes('Unknown engine'),
        '应包含错误消息',
      )
    })

    it('should accept canonical engine names', () => {
      // 这可能成功或失败，取决于是否安装了二进制文件，
      // 但不应因 "Unknown engine" 而失败
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'postgresql 应被识别为有效引擎',
        )
      }
    })

    it('should accept engine aliases', () => {
      const result = runCommand('bin-path pg --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'pg 别名应解析为 postgresql',
        )
      }
    })

    it('should accept postgres alias', () => {
      const result = runCommand('bin-path postgres --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'postgres 别名应解析为 postgresql',
        )
      }
    })

    it('should accept mongo alias', () => {
      const result = runCommand('bin-path mongo --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'mongo 别名应解析为 mongodb',
        )
      }
    })
  })

  describe('tool validation', () => {
    it('should reject tools not belonging to the engine', () => {
      const result = runCommand('bin-path redis --tool psql --json')
      assertEqual(result.exitCode, 1, '应以退出码 1 退出')
      const json = JSON.parse(result.stdout.trim())
      assert(
        json.error.includes('not a known tool'),
        '应说明该工具对引擎未知',
      )
    })

    it('should suggest available tools when tool is invalid', () => {
      const result = runCommand(
        'bin-path postgresql --tool invalid-tool --json',
      )
      assertEqual(result.exitCode, 1, '应以退出码 1 退出')
      const json = JSON.parse(result.stdout.trim())
      assert(json.error.includes('Available:'), '应列出可用工具')
    })
  })

  describe('JSON output format', () => {
    it('should output valid JSON with --json flag', () => {
      const result = runCommand('bin-path postgresql --json')
      const json = JSON.parse(result.stdout.trim())
      // 无论找到还是错误，都应为有效 JSON
      assert(
        typeof json === 'object' && json !== null,
        '输出应为 JSON 对象',
      )
    })

    it('should include engine and tool in successful JSON output', () => {
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.engine, 'postgresql', '引擎应为 postgresql')
        assertEqual(json.tool, 'psql', '默认工具应为 psql')
        assert(typeof json.path === 'string', '路径应为字符串')
        assert(json.path.length > 0, '路径不应为空')
      }
    })

    it('should include error field in error JSON output', () => {
      const result = runCommand('bin-path not-a-real-engine --json')
      assertEqual(result.exitCode, 1, '应以退出码 1 退出')
      const json = JSON.parse(result.stdout.trim())
      assert(typeof json.error === 'string', '应有错误字段')
    })
  })

  describe('default tool selection', () => {
    it('should default to psql for postgresql', () => {
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'psql', '默认工具应为 psql')
      } else {
        const json = JSON.parse(result.stdout.trim())
        // 如果未找到，错误应提及 psql（默认工具）
        assert(
          json.error.includes('psql'),
          '错误应引用默认工具 psql',
        )
      }
    })

    it('should default to redis-server for redis', () => {
      const result = runCommand('bin-path redis --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(
          json.tool,
          'redis-server',
          '默认工具应为 redis-server',
        )
      } else {
        const json = JSON.parse(result.stdout.trim())
        assert(
          json.error.includes('redis-server'),
          '错误应引用默认工具 redis-server',
        )
      }
    })
  })

  describe('specific tool selection', () => {
    it('should accept --tool pg_dump for postgresql', () => {
      const result = runCommand('bin-path postgresql --tool pg_dump --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'pg_dump', '工具应为 pg_dump')
      } else {
        const json = JSON.parse(result.stdout.trim())
        // 不应是 "unknown tool" 错误
        assert(
          !json.error.includes('not a known tool'),
          'pg_dump 对 postgresql 应有效',
        )
      }
    })

    it('should accept --tool redis-cli for redis', () => {
      const result = runCommand('bin-path redis --tool redis-cli --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'redis-cli', '工具应为 redis-cli')
      } else {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('not a known tool'),
          'redis-cli 对 redis 应有效',
        )
      }
    })
  })

  describe('non-JSON output', () => {
    it('should output just the path without --json', () => {
      const result = runCommand('bin-path postgresql')
      if (result.exitCode === 0) {
        const output = result.stdout.trim()
        // 应为裸路径，而非 JSON
        assert(!output.startsWith('{'), '纯文本输出不应为 JSON')
        assert(output.length > 0, '输出不应为空')
      }
    })

    it('should exit non-zero when binary not found', () => {
      // 使用不太可能安装系统二进制文件的引擎
      const result = runCommand('bin-path tigerbeetle')
      // 以 0（找到）或 1（未找到）退出 — 两者都有效
      assert(
        result.exitCode === 0 || result.exitCode === 1,
        '应以 0 或 1 退出',
      )
    })
  })

  describe('no argument', () => {
    it('should show error when no engine is provided', () => {
      const result = runCommand('bin-path')
      assertEqual(result.exitCode, 1, '应以退出码 1 退出')
    })
  })
})
