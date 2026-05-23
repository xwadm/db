/**
 * Valkey 恢复模块
 * 支持两种备份格式：
 * - RDB: 二进制快照（通过复制到数据目录恢复）
 * - Text: Valkey 命令文件（.valkey 文件，通过管道传入 valkey-cli 恢复）
 */

import { spawn } from 'child_process'
import { copyFile, open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { getValkeyCliPath, VALKEY_CLI_NOT_FOUND_ERROR } from './cli-utils'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

type ValkeyCliAuth = {
  username?: string
  password?: string
}

/**
 * 判断是否需要传递 valkey-cli 用户名参数
 */
function shouldPassValkeyCliUsername(
  username?: string,
): username is string {
  if (!username) {
    return false
  }

  const trimmed = username.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

/**
 * 用于检测文本格式备份文件的常见 Valkey 命令集合
 * 这些是 Valkey 命令转储文件开头常见的命令
 */
const VALKEY_COMMANDS = [
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
 * 检查文件内容是否看起来像 Valkey 命令
 * 如果前几行非注释、非空行以有效的 Valkey 命令开头，则返回 true
 * 仅读取前 4KB 以避免将大文件加载到内存中
 */
async function looksLikeValkeyCommands(filePath: string): Promise<boolean> {
  try {
    // 仅读取前 4KB —— 足够容纳多行 Valkey 命令
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
    // 使用 /\r?\n/ 处理 Unix (\n) 和 Windows (\r\n) 两种换行符
    const lines = content.split(/\r?\n/)

    let commandsFound = 0
    const linesToCheck = 10 // 检查前 10 行非空、非注释行

    for (const line of lines) {
      const trimmed = line.trim()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue

      // 获取第一个单词（命令）
      const firstWord = trimmed.split(/\s+/)[0].toUpperCase()

      if (VALKEY_COMMANDS.includes(firstWord)) {
        commandsFound++
        if (commandsFound >= 2) {
          // 找到至少 2 个有效 Valkey 命令 —— 很可能是一个 Valkey 转储文件
          return true
        }
      } else {
        // 发现不以 Valkey 命令开头的行
        // 可能是二进制数据或其他格式
        return false
      }

      if (commandsFound >= linesToCheck) break
    }

    // 如果找到了至少一个命令且没有无效行，则视为 Valkey 文件
    return commandsFound > 0
  } catch {
    return false
  }
}

/**
 * 从文件检测备份格式
 * 支持：
 * - RDB: 以 "REDIS" 开头的二进制格式（Valkey 使用与 Redis 相同的 RDB 格式）
 * - Text: Valkey 命令（通过 .valkey 扩展名或内容分析检测）
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '发现目录 —— Valkey 使用单文件备份',
      restoreCommand:
        'Valkey 需要一个单独的 .rdb 或 .valkey 文件来恢复',
    }
  }

  // 首先检查文件扩展名，识别 .valkey 文本文件
  if (filePath.endsWith('.valkey')) {
    return {
      format: 'text',
      description: 'Valkey 文本命令',
      restoreCommand:
        '将命令通过管道传入 valkey-cli（spindb restore 会自动处理）',
    }
  }

  // 检查文件内容是否为 RDB 格式（二进制，以 "REDIS" 开头）
  // 注意：Valkey 为了兼容性使用与 Redis 相同的 RDB 格式
  try {
    const buffer = Buffer.alloc(5)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 5, 0)
      const header = buffer.toString('ascii')

      if (header === 'REDIS') {
        return {
          format: 'rdb',
          description: 'Valkey RDB 快照',
          restoreCommand:
            '复制到数据目录并重启 Valkey（spindb restore 会自动处理）',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头部出错: ${error}`)
  }

  // 回退到通过文件扩展名检测 RDB
  if (filePath.endsWith('.rdb')) {
    return {
      format: 'rdb',
      description: 'Valkey RDB 快照（通过扩展名检测）',
      restoreCommand:
        '复制到数据目录并重启 Valkey（spindb restore 会自动处理）',
    }
  }

  // 基于内容的检测：检查文件是否包含 Valkey 命令
  // 这允许像 "users.txt" 或 "data" 这样的文件被检测为 Valkey 文本转储
  if (await looksLikeValkeyCommands(filePath)) {
    return {
      format: 'text',
      description: 'Valkey 文本命令（通过内容检测）',
      restoreCommand:
        '将命令通过管道传入 valkey-cli（spindb restore 会自动处理）',
    }
  }

  return {
    format: 'unknown',
    description: '未知的备份格式',
    restoreCommand: '请使用 .rdb（RDB 快照）或包含 Valkey 命令的文件',
  }
}

// Valkey 恢复选项
export type RestoreOptions = {
  containerName: string
  dataDir?: string
  // 运行中 Valkey 实例的端口（文本格式恢复时必需）
  port?: number
  // 恢复目标数据库编号（默认: 0）
  database?: string
  // 恢复前清空数据库（FLUSHDB）
  flush?: boolean
}

/**
 * 从文本备份恢复（.valkey 文件）
 * 将命令通过流式管道传入运行中的 Valkey 实例的 valkey-cli
 */
async function restoreTextBackup(
  backupPath: string,
  port: number,
  database: string,
  auth?: ValkeyCliAuth,
  flush: boolean = false,
): Promise<RestoreResult> {
  const valkeyCli = await getValkeyCliPath()
  if (!valkeyCli) {
    throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-p', String(port), '-n', database]
    if (shouldPassValkeyCliUsername(auth?.username)) {
      args.push('--user', auth.username)
    }
    const proc = spawn(valkeyCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: auth?.password
        ? { ...process.env, REDISCLI_AUTH: auth.password }
        : process.env,
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

    proc.on('close', (code) => {
      // 如果有流错误，报告之
      if (streamError) {
        reject(streamError)
        return
      }

      if (code === 0) {
        resolve({
          format: 'text',
          stdout: stdout || 'Valkey 命令执行成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `valkey-cli 退出码 ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`无法启动 valkey-cli: ${error.message}`))
    })

    // 如果请求清空数据库，先发送 FLUSHDB 命令
    if (flush) {
      logDebug('在恢复前先发送 FLUSHDB 清空数据库')
      proc.stdin.write('FLUSHDB\n')
    }

    // 将备份文件流式传输到 valkey-cli 的 stdin
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    fileStream.on('error', (error) => {
      streamError = new Error(`读取备份文件失败: ${error.message}`)
      fileStream.destroy()
      proc.stdin.end()
    })

    proc.stdin.on('error', (error) => {
      // 处理 stdin 错误（如进程意外关闭）
      streamError = new Error(
        `写入 valkey-cli stdin 失败: ${error.message}`,
      )
      fileStream.destroy()
    })

    fileStream.pipe(proc.stdin)
  })
}

/**
 * 从 RDB 备份恢复
 *
 * 重要：执行 RDB 恢复前必须先停止 Valkey。
 * RDB 文件被复制到数据目录，然后应重启 Valkey。
 */
async function restoreRdbBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'valkey' })
  const targetPath = join(targetDir, 'dump.rdb')

  logDebug(`正在将 RDB 恢复到: ${targetPath}`)

  // 将备份复制到数据目录
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `已将 RDB 恢复到 ${targetPath}。请重启 Valkey 以加载数据。`,
    code: 0,
  }
}

/**
 * 从备份恢复
 * 支持：
 * - RDB: 复制到数据目录（需要先停止 Valkey）
 * - Text: 通过管道传入 valkey-cli（需要 Valkey 处于运行状态）
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
    Engine.Valkey,
    getDefaultUsername(Engine.Valkey),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到: ${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式: ${format.format}`)

  if (format.format === 'text') {
    // 文本格式 —— 通过管道传入 valkey-cli（需要 Valkey 处于运行状态）
    if (!port) {
      throw new Error(
        '恢复 .valkey 文本文件需要提供端口号。Valkey 必须处于运行状态。',
      )
    }
    return restoreTextBackup(backupPath, port, database, auth, flush)
  }

  if (format.format === 'rdb') {
    // RDB 格式 —— 复制到数据目录（应停止 Valkey）
    // 注意：RDB 恢复始终替换全部数据（完整快照）
    return restoreRdbBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `无效的备份格式: ${format.format}。请使用 .rdb（RDB 快照）或 .valkey（文本命令文件）。`,
  )
}

/**
 * 解析 Valkey 连接字符串
 * 格式：redis://[user:password@]host[:port][/database]
 * （为了客户端兼容性使用 redis:// 方案）
 *
 * Valkey 数据库编号为 0-15（默认是 0）
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 Valkey 连接字符串: 期望一个非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // 如果存在凭据，在错误消息中遮盖它们
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 Valkey 连接字符串: "${sanitized}"。` +
        `期望格式: redis://[password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议 —— 为了兼容性同时接受 redis:// 和 rediss://
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `无效的 Valkey 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "redis://" 或 "rediss://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 6379

  // 数据库编号在 pathname 中（如 /0、/1 等）
  const dbStr = url.pathname.replace(/^\//, '') || '0'
  const dbNum = parseInt(dbStr, 10)

  // 验证数据库编号（0-15）
  if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
    throw new Error(`无效的 Valkey 数据库编号: ${dbStr}。必须为 0-15。`)
  }

  // Valkey 只使用密码（无用户名），但 URL 可能包含用户名字段
  const password = url.password || url.username || undefined

  return {
    host,
    port,
    database: String(dbNum),
    password,
  }
}