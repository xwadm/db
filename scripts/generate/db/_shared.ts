/**
 * 数据库生成脚本的共享工具函数。
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(__dirname, '..', '..', '..')

export type ContainerConfig = {
  name: string
  engine: string
  port: number
  status: string
  database: string
}

export type ParsedArgs = {
  containerName: string
  port: number | null
  version: string | null
}

export function parseArgs(defaultName: string): ParsedArgs {
  const args = process.argv.slice(2)
  let containerName = defaultName
  let port: number | null = null
  let version: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port') {
      const portValue = args[i + 1]
      if (!portValue || portValue.startsWith('-')) {
        console.error('错误: --port 需要一个值')
        process.exit(1)
      }
      port = parseInt(portValue, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(
          `错误: 无效的端口号 "${portValue}"。必须是 1 到 65535 之间的数字。`,
        )
        process.exit(1)
      }
      i++ // 跳过端口值
    } else if (arg === '--version') {
      const versionValue = args[i + 1]
      if (!versionValue || versionValue.startsWith('-')) {
        console.error('错误: --version 需要一个值')
        process.exit(1)
      }
      version = versionValue
      i++ // 跳过版本值
    } else if (!arg.startsWith('-')) {
      containerName = arg
    }
  }

  return { containerName, port, version }
}

export function runSpindb(args: string[]): {
  success: boolean
  output: string
} {
  const result = spawnSync('pnpm', ['start', ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true, // Windows 必需，因为 pnpm 是 .cmd 包装脚本
  })

  return {
    success: result.status === 0,
    output: result.stdout + result.stderr,
  }
}

export function runSpindbStreaming(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['start', ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true, // Windows 必需，因为 pnpm 是 .cmd 包装脚本
    })

    child.on('close', (code) => {
      resolve(code ?? 1)
    })

    child.on('error', () => {
      resolve(1)
    })
  })
}

export type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * 通过 `spindb run` 在容器内运行命令。
 * 使用 shell: true 以兼容 Windows，因为 pnpm 是 .cmd 包装脚本。
 */
export function runContainerCommand(
  containerName: string,
  args: string[],
): CommandResult {
  const result = spawnSync(
    'pnpm',
    ['start', 'run', containerName, '--', ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    },
  )

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

export async function getContainerConfig(
  engine: string,
  name: string,
): Promise<ContainerConfig | null> {
  const homeDir = process.env.HOME || process.env.USERPROFILE
  if (!homeDir) {
    throw new Error(
      '无法确定主目录。请设置 HOME 或 USERPROFILE 环境变量。',
    )
  }

  const containerJsonPath = join(
    homeDir,
    '.spindb',
    'containers',
    engine,
    name,
    'container.json',
  )

  if (!existsSync(containerJsonPath)) {
    return null
  }

  try {
    const content = await readFile(containerJsonPath, 'utf-8')
    return JSON.parse(content) as ContainerConfig
  } catch {
    return null
  }
}

export async function waitForReady(
  containerName: string,
  checkCommand: string[],
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync(
      'pnpm',
      ['start', 'run', containerName, ...checkCommand],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true, // Windows 必需，因为 pnpm 是 .cmd 包装脚本
        timeout: 5000, // 防止无响应命令挂起
      },
    )

    // 检查超时或终止信号
    if (result.error || result.signal) {
      // 超时或被终止 - 视为失败尝试，继续重试
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }

    if (result.status === 0) {
      return true
    }

    // 等待 500ms 后重试
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

export async function waitForHttpReady(
  port: number,
  path: string = '/',
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: controller.signal,
      })
      if (response.ok) {
        return true
      }
    } catch {
      // 服务器尚未就绪或请求超时
    } finally {
      clearTimeout(timeout)
    }

    // 等待 500ms 后重试
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

export function getSeedFile(engine: string, filename: string): string {
  return join(PROJECT_ROOT, 'tests', 'fixtures', engine, 'seeds', filename)
}

/**
 * 将命令字符串解析为参数数组，支持单引号和双引号。
 * 用于包含带空格 JSON 的 Redis/Valkey 命令。
 *
 * 注意: 不处理引号字符串内的转义引号（例如 'it\'s'）。
 *
 * 示例: `SET user:1 '{"name":"Alice Johnson"}'` 变为
 *          ['SET', 'user:1', '{"name":"Alice Johnson"}']
 */
export function parseQuotedCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (!inQuote && (char === "'" || char === '"')) {
      inQuote = true
      quoteChar = char
    } else if (inQuote && char === quoteChar) {
      inQuote = false
      quoteChar = ''
    } else if (!inQuote && char === ' ') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
