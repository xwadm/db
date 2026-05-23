import { basename, dirname } from 'path'
import { getLibraryEnv } from '../../core/library-env'

type RedisCliAuth = {
  username?: string
  password?: string
}

/**
 * 获取用于检测 Redis CLI 错误的正则表达式列表
 */
function getRedisCliErrorMarkers(): RegExp[] {
  return [
    /^ERR\b/m,
    /\bNOAUTH\b/,
    /\bWRONGPASS\b/,
    /\bNOPERM\b/,
    /\bACL\b/,
  ]
}

/**
 * 判断是否需要向 redis-cli 传递用户名参数
 * 仅当用户名非空且不是默认用户 'default' 时才需要传递
 */
export function shouldPassRedisCliUsername(username?: string): username is string {
  if (!username) {
    return false
  }

  const trimmed = username.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

/**
 * 构建 redis-cli 的命令行参数
 */
export function buildRedisCliArgs(
  port: number,
  auth?: RedisCliAuth,
  database?: string,
): string[] {
  const args = ['-h', '127.0.0.1', '-p', String(port)]

  if (database !== undefined) {
    args.push('-n', database)
  }

  if (shouldPassRedisCliUsername(auth?.username)) {
    args.push('--user', auth.username)
  }

  return args
}

/**
 * 获取 redis-cli 二进制文件所在目录的库路径环境变量
 * 用于在运行时解析动态链接库依赖
 */
function getRedisCliLibraryEnv(
  redisCliPath?: string,
): Record<string, string> | undefined {
  if (!redisCliPath) {
    return undefined
  }

  const cliDir = dirname(redisCliPath)
  const baseDir = basename(cliDir) === 'bin' ? dirname(cliDir) : cliDir
  return getLibraryEnv(baseDir)
}

/**
 * 构建 redis-cli 执行时的环境变量
 * 如果提供了密码，通过 REDISCLI_AUTH 环境变量传递，避免在进程列表中暴露
 */
export function buildRedisCliEnv(
  auth?: RedisCliAuth,
  redisCliPath?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
    ...getRedisCliLibraryEnv(redisCliPath),
  }

  if (auth?.password) {
    env.REDISCLI_AUTH = auth.password
  } else {
    delete env.REDISCLI_AUTH
  }

  return env
}

/**
 * 检测 redis-cli 输出中是否存在错误
 * 根据命令类型决定是否检查 stdout 中的错误标记
 */
export function hasRedisCliError(
  stdout: string,
  stderr: string,
  inspectStdout: boolean,
): boolean {
  const patterns = getRedisCliErrorMarkers()
  const stderrText = stderr.trim()
  if (patterns.some((pattern) => pattern.test(stderrText))) {
    return true
  }

  if (!inspectStdout) {
    return false
  }

  const stdoutText = stdout.trim()
  return patterns.some((pattern) => pattern.test(stdoutText))
}

export type { RedisCliAuth }