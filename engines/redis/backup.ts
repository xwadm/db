/**
 * Redis 备份模块
 * 支持两种备份格式：
 * - RDB：通过 BGSAVE 生成的二进制快照（默认，体积小，恢复快）
 * - Text：可读的 Redis 命令文件（.redis 文件）
 */

import { spawn } from 'child_process'
import { copyFile, stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import { detectLibraryError } from '../../core/library-env'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { paths } from '../../config/paths'
import { getRedisCliPath, REDIS_CLI_NOT_FOUND_ERROR } from './cli-utils'
import {
  buildRedisCliArgs,
  buildRedisCliEnv,
  hasRedisCliError,
  type RedisCliAuth,
} from './cli-common'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

/**
 * 通过 stdin 管道执行 Redis 命令
 * 比 shell 命令构造更安全，能正确处理包含空格和特殊字符的键/值
 */
async function execRedisCommand(
  redisCli: string,
  port: number,
  command: string,
  auth?: RedisCliAuth,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const commandName = command.trim().split(/\s+/)[0]?.toUpperCase() || ''
    // 读取类命令的 stdout 不包含错误标记，跳过错误检测
    const inspectStdoutErrors = !new Set([
      'GET',
      'HGETALL',
      'LRANGE',
      'SMEMBERS',
      'ZRANGE',
    ]).has(commandName)
    const args = buildRedisCliArgs(port, auth)
    const proc = spawn(redisCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRedisCliEnv(auth, redisCli),
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', (code, signal) => {
      const combinedOutput = `${stdout}\n${stderr}`.trim()
      const hasCliError = hasRedisCliError(
        stdout,
        stderr,
        inspectStdoutErrors,
      )
      const libraryError = detectLibraryError(combinedOutput, 'Redis')

      if (libraryError) {
        reject(new Error(libraryError))
      } else if (code === 0 && !hasCliError) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            combinedOutput ||
              `redis-cli 退出码为 ${code}，信号为 ${signal ?? '无'}`,
          ),
        )
      }
    })

    // 将命令写入 stdin 并关闭
    proc.stdin.write(command + '\n')
    proc.stdin.end()
  })
}

/**
 * 对 Redis 命令输出的字符串值进行转义
 * 用单引号包裹，并对反斜杠和单引号进行转义
 */
function escapeRedisValue(value: string): string {
  // 先转义反斜杠，再转义单引号（顺序很重要！）
  // 例如："test\'value" → "test\\\'value"（反斜杠和引号都被转义）
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * 创建文本格式备份（.redis 文件）
 * 将所有键导出为可重新执行的 Redis 命令
 */
async function createTextBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { name, port } = container

  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(REDIS_CLI_NOT_FOUND_ERROR)
  }
  const creds = await loadCredentials(
    name,
    Engine.Redis,
    getDefaultUsername(Engine.Redis),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  const commands: string[] = []
  commands.push('# SpinDB 生成的 Redis 备份')
  commands.push(`# 日期: ${new Date().toISOString()}`)
  commands.push('')

  // 使用 KEYS * 获取所有键（对于小数据集足够）
  // 生产环境中如果有数百万键，建议改用 SCAN
  const keysOutput = await execRedisCommand(redisCli, port, 'KEYS *', auth)
  // 使用 /\r?\n/ 同时兼容 Unix (\n) 和 Windows (\r\n) 换行符
  const keys = keysOutput
    .trim()
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter((k) => k)

  logDebug(`找到 ${keys.length} 个需要备份的键`)

  for (const key of keys) {
    // 获取键类型 — 对键加引号以处理空格/特殊字符
    const typeOutput = await execRedisCommand(
      redisCli,
      port,
      `TYPE "${key.replace(/"/g, '\\"')}"`,
      auth,
    )
    const keyType = typeOutput.trim()

    // 获取 TTL
    const ttlOutput = await execRedisCommand(
      redisCli,
      port,
      `TTL "${key.replace(/"/g, '\\"')}"`,
      auth,
    )
    const ttl = parseInt(ttlOutput.trim(), 10)

    // 如果键包含特殊字符，用引号包裹输出命令中的键名
    const quotedKey =
      key.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(key)
        ? `"${key.replace(/"/g, '\\"')}"`
        : key

    switch (keyType) {
      case 'string': {
        const value = await execRedisCommand(
          redisCli,
          port,
          `GET "${key.replace(/"/g, '\\"')}"`,
          auth,
        )
        commands.push(`SET ${quotedKey} ${escapeRedisValue(value.trim())}`)
        break
      }
      case 'hash': {
        const hashData = await execRedisCommand(
          redisCli,
          port,
          `HGETALL "${key.replace(/"/g, '\\"')}"`,
          auth,
        )
        const lines = hashData
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l)
        if (lines.length >= 2) {
          const pairs: string[] = []
          for (let i = 0; i < lines.length; i += 2) {
            const field = lines[i].trim()
            const value = lines[i + 1]?.trim() || ''
            // 如果字段包含特殊字符，用引号包裹
            const quotedField =
              field.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(field)
                ? `"${field.replace(/"/g, '\\"')}"`
                : field
            pairs.push(`${quotedField} ${escapeRedisValue(value)}`)
          }
          commands.push(`HSET ${quotedKey} ${pairs.join(' ')}`)
        }
        break
      }
      case 'list': {
        const listData = await execRedisCommand(
          redisCli,
          port,
          `LRANGE "${key.replace(/"/g, '\\"')}" 0 -1`,
          auth,
        )
        const items = listData
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l)
        if (items.length > 0) {
          const escapedItems = items.map((item) =>
            escapeRedisValue(item.trim()),
          )
          commands.push(`RPUSH ${quotedKey} ${escapedItems.join(' ')}`)
        }
        break
      }
      case 'set': {
        const setData = await execRedisCommand(
          redisCli,
          port,
          `SMEMBERS "${key.replace(/"/g, '\\"')}"`,
          auth,
        )
        const members = setData
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l)
        if (members.length > 0) {
          const escapedMembers = members.map((m) => escapeRedisValue(m.trim()))
          commands.push(`SADD ${quotedKey} ${escapedMembers.join(' ')}`)
        }
        break
      }
      case 'zset': {
        const zsetData = await execRedisCommand(
          redisCli,
          port,
          `ZRANGE "${key.replace(/"/g, '\\"')}" 0 -1 WITHSCORES`,
          auth,
        )
        const lines = zsetData
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l)
        if (lines.length >= 2) {
          const pairs: string[] = []
          for (let i = 0; i < lines.length; i += 2) {
            const member = lines[i].trim()
            const score = lines[i + 1]?.trim() || '0'
            pairs.push(`${score} ${escapeRedisValue(member)}`)
          }
          commands.push(`ZADD ${quotedKey} ${pairs.join(' ')}`)
        }
        break
      }
      default:
        logWarning(`跳过键 ${key}，不支持的类型: ${keyType}`)
    }

    // 如果键有 TTL，添加 EXPIRE 命令
    if (ttl > 0) {
      commands.push(`EXPIRE ${quotedKey} ${ttl}`)
    }
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 将命令写入文件
  const content = commands.join('\n') + '\n'
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'text',
    size: stats.size,
  }
}

/**
 * 使用 BGSAVE 创建 RDB 格式备份
 *
 * Redis 备份为 RDB 文件（二进制快照）。备份流程如下：
 * 1. 触发 BGSAVE 命令
 * 2. 轮询 LASTSAVE 直到时间戳变化（备份完成）
 * 3. 将 dump.rdb 复制到输出路径
 */
async function createRdbBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { port, name } = container

  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(REDIS_CLI_NOT_FOUND_ERROR)
  }
  const creds = await loadCredentials(
    name,
    Engine.Redis,
    getDefaultUsername(Engine.Redis),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  // 触发后台保存
  let bgsaveResponse: string
  try {
    bgsaveResponse = await execRedisCommand(redisCli, port, 'BGSAVE', auth)
    bgsaveResponse = bgsaveResponse.trim()
  } catch (error) {
    const execError = error as Error
    throw new Error(`BGSAVE 命令执行失败: ${execError.message}`)
  }

  logDebug(`BGSAVE 响应: ${bgsaveResponse}`)

  // 检查 stdout 中的 Redis 错误响应
  // Redis 错误以 "ERR ..." 或 "(error) ..." 形式出现在 stdout 中
  if (
    bgsaveResponse.startsWith('ERR') ||
    bgsaveResponse.startsWith('(error)')
  ) {
    // 特殊情况：如果后台保存已在进行中，等待其完成即可
    if (bgsaveResponse.includes('Background save already in progress')) {
      logDebug('BGSAVE 已在执行中，等待其完成')
    } else {
      throw new Error(`BGSAVE 失败: ${bgsaveResponse}`)
    }
  } else if (
    !bgsaveResponse.includes('Background saving started') &&
    !bgsaveResponse.includes('Background save already in progress')
  ) {
    // 非预期响应 — 记录警告但继续（可能是不同 Redis 版本）
    logDebug(
      `BGSAVE 非预期响应（继续执行）: ${bgsaveResponse}`,
    )
  }

  // 通过检查 rdb_bgsave_in_progress 等待保存完成
  // 比 LASTSAVE 时间戳更可靠（LASTSAVE 精度仅为秒级）
  const startTime = Date.now()
  const timeout = 60000 // 1 分钟超时

  while (Date.now() - startTime < timeout) {
    const infoOutput = await execRedisCommand(
      redisCli,
      port,
      'INFO persistence',
      auth,
    )

    // 检查 BGSAVE 是否仍在进行中
    const inProgress = infoOutput.includes('rdb_bgsave_in_progress:1')
    if (!inProgress) {
      // 同时检查是否有错误
      const statusMatch = infoOutput.match(/rdb_last_bgsave_status:(\w+)/)
      const status = statusMatch?.[1]
      if (status === 'err') {
        throw new Error('BGSAVE 失败，请查看 Redis 日志获取详情。')
      }
      logDebug('BGSAVE 成功完成')
      break
    }

    await new Promise((r) => setTimeout(r, 100))
  }

  if (Date.now() - startTime >= timeout) {
    throw new Error('BGSAVE 在 60 秒后超时')
  }

  // 从 Redis 数据目录获取 RDB 文件路径
  const dataDir = paths.getContainerDataPath(name, { engine: 'redis' })
  const rdbPath = join(dataDir, 'dump.rdb')

  if (!existsSync(rdbPath)) {
    throw new Error(
      `BGSAVE 后在 ${rdbPath} 未找到 RDB 文件，请检查 Redis 配置。`,
    )
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 将 RDB 文件复制到输出路径
  await copyFile(rdbPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'rdb',
    size: stats.size,
  }
}

/**
 * 创建备份
 * 支持两种格式：
 * - 'text'：可读的 Redis 命令文件（.redis 文件）
 * - 'rdb'（默认）：二进制 RDB 快照
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  // 'text' 格式指基于文本的 Redis 命令备份
  if (options.format === 'text') {
    return createTextBackup(container, outputPath)
  }
  // 默认为 RDB 格式
  return createRdbBackup(container, outputPath)
}

/**
 * 为克隆目的创建备份
 * 始终使用 RDB 格式，以确保速度和可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createRdbBackup(container, outputPath)
}