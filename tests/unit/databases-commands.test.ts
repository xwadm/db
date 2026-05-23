/**
 * 数据库创建、删除和重命名 CLI 子命令测试。
 *
 * 这些测试验证：
 * 1. 缺少容器时的错误
 * 2. 错误的 JSON 输出格式
 * 3. JSON 模式下缺少参数的情况
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

// 执行 CLI 命令并捕获输出和退出码
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

// 将输出字符串解析为 JSON 对象
function parseJson(output: string): Record<string, unknown> {
  const trimmed = output.trim()
  return JSON.parse(trimmed) as Record<string, unknown>
}

describe('databases create command', () => {
  it('容器不存在时应报错 (--json)', () => {
    const result = runCommand('databases create nonexistent testdb --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
    assert((json.error as string).includes('not found'), '应提示未找到')
  })

  it('--json 模式下缺少数据库名称时应报错', () => {
    // 即使容器不存在，容器检查也会先执行
    const result = runCommand('databases create nonexistent --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
  })

  it('错误时应输出有效的 JSON', () => {
    const result = runCommand('databases create nonexistent mydb --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    // 解析时不应抛出异常
    const json = parseJson(result.stdout)
    assert(json !== null, '应解析为有效的 JSON')
  })
})

describe('databases drop command', () => {
  it('容器不存在时应报错 (--json)', () => {
    const result = runCommand(
      'databases drop nonexistent testdb --json --force',
    )
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
    assert((json.error as string).includes('not found'), '应提示未找到')
  })

  it('--json 模式下缺少数据库名称时应报错', () => {
    const result = runCommand('databases drop nonexistent --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
  })
})

describe('databases rename command', () => {
  it('容器不存在时应报错 (--json)', () => {
    const result = runCommand('databases rename nonexistent olddb newdb --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
    assert((json.error as string).includes('not found'), '应提示未找到')
  })

  it('--json 模式下缺少名称时应报错', () => {
    const result = runCommand('databases rename nonexistent --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
  })

  it('--json 模式下仅提供旧名称时应报错', () => {
    const result = runCommand('databases rename nonexistent olddb --json')
    assertEqual(result.exitCode, 1, '应退出，退出码为 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', '应有 error 字段')
  })
})

describe('databases commands - help output', () => {
  it('databases create --help 应显示用法', () => {
    const result = runCommand('databases create --help')
    assertEqual(result.exitCode, 0, '帮助应退出，退出码为 0')
    assert(
      result.stdout.includes('container'),
      '应提及 container 参数',
    )
    assert(
      result.stdout.includes('database'),
      '应提及 database 参数',
    )
  })

  it('databases drop --help 应显示用法', () => {
    const result = runCommand('databases drop --help')
    assertEqual(result.exitCode, 0, '帮助应退出，退出码为 0')
    assert(
      result.stdout.includes('container'),
      '应提及 container 参数',
    )
    assert(result.stdout.includes('--force'), '应提及 --force 选项')
  })

  it('databases rename --help 应显示用法', () => {
    const result = runCommand('databases rename --help')
    assertEqual(result.exitCode, 0, '帮助应退出，退出码为 0')
    assert(
      result.stdout.includes('container'),
      '应提及 container 参数',
    )
    assert(result.stdout.includes('--backup'), '应提及 --backup 选项')
    assert(
      result.stdout.includes('--no-drop'),
      '应提及 --no-drop 选项',
    )
  })
})
