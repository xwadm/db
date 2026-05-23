/**
 * 共享的 spawn 工具，用于安全执行命令
 *
 * 此模块提供基于 Promise 的 child_process.spawn 封装，
 * 具有适当的超时处理和错误消息。
 */

import { spawn } from 'child_process'

export type SpawnOptions = {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

export type SpawnResult = {
  stdout: string
  stderr: string
}

/**
 * 使用 spawn 以参数数组方式执行命令（比 shell 插值更安全）
 *
 * @param command - 要执行的命令
 * @param args - 传递给命令的参数数组
 * @param options - 可选配置（cwd、timeout）
 * @returns 解析为 { stdout, stderr } 的 Promise
 * @throws 命令失败、超时或无法执行时抛出 Error
 */
export function spawnAsync(
  command: string,
  args: string[],
  options?: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // 如果指定了超时则设置
    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGKILL')
        reject(
          new Error(
            `命令 "${command} ${args.join(' ')}" 在 ${options.timeout}ms 后超时`,
          ),
        )
      }, options.timeout)
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      cleanup()
      if (timedOut) return // 已由超时处理拒绝
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(
            `命令 "${command} ${args.join(' ')}" 失败，退出码 ${code}: ${stderr || stdout}`,
          ),
        )
      }
    })

    proc.on('error', (err) => {
      cleanup()
      if (timedOut) return // 已由超时处理拒绝
      reject(new Error(`执行 "${command}" 失败: ${err.message}`))
    })
  })
}

/**
 * 转义字符串以用于 PowerShell 单引号字符串。
 * PowerShell 通过双写单引号来转义: ' 变为 ''
 */
function escapeForPowerShell(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 使用 PowerShell Expand-Archive 解压 ZIP 归档文件（Windows）
 *
 * @param zipFile - ZIP 文件路径
 * @param destDir - 解压目标目录
 * @throws 解压失败时抛出 Error
 */
export async function extractWindowsArchive(
  zipFile: string,
  destDir: string,
): Promise<void> {
  // 转义路径以防止通过单引号进行命令注入
  // 使用 -LiteralPath 将路径视为字面值（不进行通配符展开）
  const safeZipFile = escapeForPowerShell(zipFile)
  const safeDestDir = escapeForPowerShell(destDir)

  await spawnAsync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${safeZipFile}' -DestinationPath '${safeDestDir}' -Force`,
  ])
}
