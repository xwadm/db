/**
 * Redis 恢复模块
 * 支持两种备份格式：
 * - RDB：二进制快照（通过复制到数据目录恢复）
 * - 文本：Redis 命令（.redis 文件，通过管道传给 redis-cli 恢复）
 */

import { spawn } from 'child_process'
import { once } from 'events'
import { copyFile, open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import { paths } from '../../config/paths'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { detectLibraryError } from '../../core/library-env'
import { getRedisCliPath, REDIS_CLI_NOT_FOUND_ERROR } from './cli-utils'
import {
  buildRedisCliArgs,
  buildRedisCliEnv,
  hasRedisCliError,
  type RedisCliAuth,
} from './cli-common'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

/**
 * 常用于检测基于文本的备份文件的 Redis 命令
 * 这些命令通常出现在 Redis 命令转储文件的开头
 */
const REDIS_COMMANDS = [
  'SET',
  'GET',
  'DEL',
  'MSET',
  'MGET',
  'SETNX',
  'SETEX',
  'PSETEX',
  'APPEND',
  'HSET',
  'HGET',
  'HMSET',
  'HDEL',
  'HGETALL',
  'HSETNX',
  'LPUSH',
  'RPUSH',
  'LPOP',
  'RPOP',
  'LSET',
  'LINSERT',
  'LREM',
  'SADD',
  'SREM',
  'SMEMBERS',
  'SPOP',
  'ZADD',
  'ZREM',
  'ZINCRBY',
  'ZRANGE',
  'EXPIRE',
  'EXPIREAT',
  'PEXPIRE',
  'TTL',
  'PERSIST',
  'FLUSHDB',
  'FLUSHALL',
  'SELECT',
  'PFADD',
  'GEOADD',
  'XADD',
]

/**
 * 检查文件内容是否看起来像 Redis 命令
 * 如果第一个非注释、非空行以有效的 Redis 命令开头，则返回 true
 * 仅读取前 4KB 以避免将大文件加载到内存
 */
async function looksLikeRedisCommands(filePath: string): Promise<boolean> {
  try {
    // 仅读取前 4KB —— 足够容纳数行 Redis 命令
    const HEADER_SIZE = 4096
    const buffer = Buffer.alloc(HEADER_SIZE)

    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close()
    }

    const content = buffer.toString('utf-8', 0, bytesRead)
    // 使用 /\r?\n/ 同时处理 Unix (\n) 和 Windows (\r\n) 换行符
    const lines = content.split(/\r?\n/)

    let commandsFound = 0
    const linesToCheck = 10 // 检查前 10 行非空非注释行

    for (const line of lines) {
      const trimmed = line.trim()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue

      // 获取第一个单词（命令）
      const firstWord = trimmed.split(/\s+/)[0].toUpperCase()

      if (REDIS_COMMANDS.includes(firstWord)) {
        commandsFound++
        if (commandsFound >= 2) {
          // 找到至少 2 个有效的 Redis 命令 —— 很可能是 Redis 转储
          return true
        }
      } else {
        // 发现不以 Redis 命令开头的行
        // 可能是二进制数据或其他格式
        return false
      }

      if (commandsFound >= linesToCheck) break
    }

    // 如果至少找到一个命令且没有无效行，则视为 Redis
    return commandsFound > 0
  } catch {
    return false
  }
}

/**
 * 从文件检测备份格式
 * 支持：
 * - RDB：以 "REDIS" 开头的二进制格式
 * - 文本：Redis 命令（通过 .redis 扩展名或内容分析检测）
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到：${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '检测到目录 - Redis 使用单文件备份',
      restoreCommand: 'Redis 需要单个 .rdb 或 .redis 文件进行恢复',
    }
  }

  // 首先检查 .redis 文本文件的文件扩展名
  if (filePath.endsWith('.redis')) {
    return {
      format: 'text',
      description: 'Redis 文本命令',
      restoreCommand: '将命令管道传递给 redis-cli（spindb restore 可自动处理）',
    }
  }

  // 检查文件内容是否为 RDB 格式（二进制，以 "REDIS" 开头）
  try {
    const buffer = Buffer.alloc(5)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 5, 0)
      const header = buffer.toString('ascii')

      if (header === 'REDIS') {
        return {
          format: 'rdb',
          description: 'Redis RDB 快照',
          restoreCommand:
            '复制到数据目录并重启 Redis（spindb restore 可自动处理）',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头时出错：${error}`)
  }

  // 作为回退，检查 RDB 的文件扩展名
  if (filePath.endsWith('.rdb')) {
    return {
      format: 'rdb',
      description: 'Redis RDB 快照（通过扩展名检测）',
      restoreCommand: '复制到数据目录并重启 Redis（spindb restore 可自动处理）',
    }
  }

  // 基于内容的检测：检查文件是否包含 Redis 命令
  // 这允许像 "users.txt" 或 "data" 这样的文件被检测为 Redis 文本转储
  if (await looksLikeRedisCommands(filePath)) {
    return {
      format: 'text',
      description: 'Redis 文本命令（通过内容检测）',
      restoreCommand: '将命令管道传递给 redis-cli（spindb restore 可自动处理）',
    }
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用 .rdb（RDB 快照）或包含 Redis 命令的文件',
  }
}

// Redis 恢复选项
export type RestoreOptions = {
  containerName: string
  dataDir?: string
  // 正在运行的 Redis 实例的端口（文本恢复需要）
  port?: number
  // 要恢复到的数据库编号（默认：0）
  database?: string
  // 恢复前清空数据库（FLUSHDB）
  flush?: boolean
}

/**
 * 从文本备份（.redis 文件）恢复
 * 将命令通过管道流传给正在运行的 Redis 实例的 redis-cli
 */
async function restoreTextBackup(
  backupPath: string,
  port: number,
  database: string,
  auth?: RedisCliAuth,
  flush: boolean = false,
): Promise<RestoreResult> {
  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(REDIS_CLI_NOT_FOUND_ERROR)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = buildRedisCliArgs(port, auth, database)
    const proc = spawn(redisCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRedisCliEnv(auth, redisCli),
    })

    let stdout = ''
    let stderr = ''
    let streamError: Error | null = null

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code, signal) => {
      // 如果存在流错误，报告它
      if (streamError) {
        reject(streamError)
        return
      }

      const combinedOutput = `${stdout}\n${stderr}`.trim()
      const hasCliError = hasRedisCliError(stdout, stderr, true)
      const libraryError = detectLibraryError(combinedOutput, 'Redis')

      if (libraryError) {
        reject(new Error(libraryError))
      } else if (code === 0 && !hasCliError) {
        resolve({
          format: 'text',
          stdout: stdout || 'Redis 命令执行成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            combinedOutput ||
              `redis-cli 退出码为 ${code}，信号为 ${signal ?? '无'}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`无法启动 redis-cli：${error.message}`))
    })

    // 如果请求了 FLUSHDB，则在恢复前清空数据库
    if (flush) {
      logDebug('在恢复前预先执行 FLUSHDB 以清空数据库')
      proc.stdin.write('FLUSHDB\n')
    }

    // 将备份命令通过管道流传给 redis-cli 的标准输入，跳过注释/空行。
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })
    const lineReader = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })

    fileStream.on('error', (error) => {
      streamError = new Error(`读取备份文件失败：${error.message}`)
      fileStream.destroy()
      lineReader.close()
      proc.stdin.end()
    })

    proc.stdin.on('error', (error) => {
      // 处理标准输入错误（例如，进程意外关闭）
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        streamError = new Error(`写入 redis-cli 标准输入失败：${error.message}`)
      }
      fileStream.destroy()
      lineReader.close()
    })
    ;(async () => {
      try {
        for await (const rawLine of lineReader) {
          const line = rawLine.trim()
          if (!line || line.startsWith('#')) {
            continue
          }
          if (proc.stdin.destroyed) {
            break
          }
          if (!proc.stdin.write(rawLine + '\n')) {
            await once(proc.stdin, 'drain')
          }
        }
      } catch (error) {
        streamError = new Error(
          `传输备份命令失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      } finally {
        proc.stdin.end()
      }
    })().catch((error) => {
      streamError = new Error(
        `处理备份命令失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      proc.stdin.end()
    })
  })
}

/**
 * 从 RDB 备份恢复
 *
 * 重要：RDB 恢复前必须停止 Redis。
 * RDB 文件被复制到数据目录，然后应重启 Redis。
 */
async function restoreRdbBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'redis' })
  const targetPath = join(targetDir, 'dump.rdb')

  logDebug(`正在将 RDB 恢复到：${targetPath}`)

  // 将备份复制到数据目录
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `已将 RDB 恢复到 ${targetPath}。重启 Redis 以加载数据。`,
    code: 0,
  }
}

/**
 * 从备份恢复
 * 支持：
 * - RDB：复制到数据目录（需要 Redis 停止运行）
 * - 文本：将命令管道传递给 redis-cli（需要 Redis 正在运行）
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    containerName,
    dataDir,
    port,
    database = '0',
    flush = false,
  } = options
  const creds = await loadCredentials(
    containerName,
    Engine.Redis,
    getDefaultUsername(Engine.Redis),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式：${format.format}`)

  if (format.format === 'text') {
    // 文本格式 - 管道传递给 redis-cli（Redis 必须正在运行）
    if (!port) {
      throw new Error('恢复 .redis 文本文件需要提供端口。Redis 必须正在运行。')
    }
    return restoreTextBackup(backupPath, port, database, auth, flush)
  }

  if (format.format === 'rdb') {
    // RDB 格式 - 复制到数据目录（Redis 应该停止运行）
    // 注意：RDB 恢复总是替换所有内容（完整快照）
    return restoreRdbBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `无效的备份格式：${format.format}。请使用 .rdb（RDB 快照）或 .redis（文本命令）。`,
  )
}

/**
 * 解析 Redis 连接字符串
 * 格式：redis://[user:password@]host[:port][/database]
 *
 * Redis 数据库编号为 0-15（默认为 0）
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('无效的 Redis 连接字符串：期望一个非空字符串')
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // 如果存在凭证，在错误消息中掩盖它们
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 Redis 连接字符串："${sanitized}"。` +
        `期望格式：redis://[password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `无效的 Redis 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望使用 "redis://" 或 "rediss://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 6379

  // 数据库编号在 pathname 中（例如 /0、/1 等）
  const dbStr = url.pathname.replace(/^\//, '') || '0'
  const dbNum = parseInt(dbStr, 10)

  // 验证数据库编号（0-15）
  if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
    throw new Error(`无效的 Redis 数据库编号：${dbStr}。必须为 0-15。`)
  }

  // Redis 仅使用密码（无用户名），但 URL 可能包含用户名字段
  const password = url.password || url.username || undefined

  return {
    host,
    port,
    database: String(dbNum),
    password,
  }
}
