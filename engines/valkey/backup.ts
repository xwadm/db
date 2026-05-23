/**
 * Valkey 备份模块
 * 支持两种格式：
 * - RDB: 通过 BGSAVE 生成的二进制快照（默认，紧凑，恢复快）
 * - Text: 人类可读的 Valkey 命令文件（.valkey 文件）
 */

import { spawn } from 'child_process'
import { copyFile, stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { paths } from '../../config/paths'
import { getValkeyCliPath, VALKEY_CLI_NOT_FOUND_ERROR } from './cli-utils'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

type ValkeyCliAuth = {
  username?: string
  password?: string
}

/**
 * 判断是否需要传递 valkey-cli 用户名参数
 * 当用户名为空或等于 'default' 时跳过，避免 ACL 兼容性问题
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
 * 通过 stdin 管道执行 Valkey 命令
 * 比 shell 命令拼接更安全，能正确处理包含空格和特殊字符的键/值
 */
async function execValkeyCommand(
  valkeyCli: string,
  port: number,
  command: string,
  auth?: ValkeyCliAuth,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-p', String(port)]
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

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve(stdout)
      } else {
        reject(new Error(stderr || `valkey-cli 退出码: ${code}`))
      }
    })

    // 将命令写入 stdin 并关闭
    proc.stdin.write(command + '\n')
    proc.stdin.end()
  })
}

/**
 * 转义 Valkey 命令输出中的字符串值
 * 用单引号包裹，并转义反斜杠和单引号
 */
function escapeValkeyValue(value: string): string {
  // 先转义反斜杠，再转义单引号（顺序很重要！）
  // 示例："test\'value" → "test\\\'value"（反斜杠和引号均被转义）
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * 创建文本格式备份（.valkey 文件）
 * 将所有键导出为可回放的 Valkey 命令
 */
async function createTextBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { name, port } = container

  const valkeyCli = await getValkeyCliPath()
  if (!valkeyCli) {
    throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
  }
  const creds = await loadCredentials(
    name,
    Engine.Valkey,
    getDefaultUsername(Engine.Valkey),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  const commands: string[] = []
  commands.push('# Valkey 备份 由 SpinDB 生成')
  commands.push(`# 日期: ${new Date().toISOString()}`)
  commands.push('')

  // 使用 KEYS * 获取所有键（适用于小数据集）
  // 对于生产环境中有数百万键的场景，建议使用 SCAN 命令
  const keysOutput = await execValkeyCommand(valkeyCli, port, 'KEYS *', auth)
  // 使用 /\r?\n/ 处理 Unix (\n) 和 Windows (\r\n) 两种换行符
  const keys = keysOutput
    .trim()
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter((k) => k)

  logDebug(`找到 ${keys.length} 个键待备份`)

  for (const key of keys) {
    // 获取键类型 —— 给键加引号以处理空格/特殊字符
    const typeOutput = await execValkeyCommand(
      valkeyCli,
      port,
      `TYPE "${key.replace(/"/g, '\\"')}"`,
      auth,
    )
    const keyType = typeOutput.trim()

    // 获取 TTL
    const ttlOutput = await execValkeyCommand(
      valkeyCli,
      port,
      `TTL "${key.replace(/"/g, '\\"')}"`,
      auth,
    )
    const ttl = parseInt(ttlOutput.trim(), 10)

    // 为输出命令中的键加引号（如果包含特殊字符）
    const quotedKey =
      key.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(key)
        ? `"${key.replace(/"/g, '\\"')}"`
        : key

    switch (keyType) {
      case 'string': {
        const value = await execValkeyCommand(
          valkeyCli,
          port,
          `GET "${key.replace(/"/g, '\\"')}"`,
          auth,
        )
        commands.push(`SET ${quotedKey} ${escapeValkeyValue(value.trim())}`)
        break
      }
      case 'hash': {
        const hashData = await execValkeyCommand(
          valkeyCli,
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
            // 如果字段包含特殊字符，加引号
            const quotedField =
              field.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(field)
                ? `"${field.replace(/"/g, '\\"')}"`
                : field
            pairs.push(`${quotedField} ${escapeValkeyValue(value)}`)
          }
          commands.push(`HSET ${quotedKey} ${pairs.join(' ')}`)
        }
        break
      }
      case 'list': {
        const listData = await execValkeyCommand(
          valkeyCli,
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
            escapeValkeyValue(item.trim()),
          )
          commands.push(`RPUSH ${quotedKey} ${escapedItems.join(' ')}`)
        }
        break
      }
      case 'set': {
        const setData = await execValkeyCommand(
          valkeyCli,
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
          const escapedMembers = members.map((m) => escapeValkeyValue(m.trim()))
          commands.push(`SADD ${quotedKey} ${escapedMembers.join(' ')}`)
        }
        break
      }
      case 'zset': {
        const zsetData = await execValkeyCommand(
          valkeyCli,
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
            pairs.push(`${score} ${escapeValkeyValue(member)}`)
          }
          commands.push(`ZADD ${quotedKey} ${pairs.join(' ')}`)
        }
        break
      }
      default:
        logWarning(`跳过键 ${key}，不支持的类型: ${keyType}`)
    }

    // 如果键设置了 TTL，追加 EXPIRE 命令
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
 * Valkey 备份是 RDB 文件（二进制快照）。
 * 备份流程：
 * 1. 触发 BGSAVE 命令
 * 2. 轮询 LASTSAVE 直到时间戳变化（备份完成）
 * 3. 将 dump.rdb 复制到输出路径
 */
async function createRdbBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { port, name } = container

  const valkeyCli = await getValkeyCliPath()
  if (!valkeyCli) {
    throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
  }
  const creds = await loadCredentials(
    name,
    Engine.Valkey,
    getDefaultUsername(Engine.Valkey),
  )
  const auth = creds
    ? { username: creds.username, password: creds.password }
    : undefined

  // 触发后台保存
  let bgsaveResponse: string
  try {
    bgsaveResponse = await execValkeyCommand(valkeyCli, port, 'BGSAVE', auth)
    bgsaveResponse = bgsaveResponse.trim()
  } catch (error) {
    const execError = error as Error
    throw new Error(`BGSAVE 命令执行失败: ${execError.message}`)
  }

  logDebug(`BGSAVE 响应: ${bgsaveResponse}`)

  // 检查 stdout 中的 Valkey 错误响应
  // Valkey 在 stdout 中返回类似 "ERR ..." 或 "(error) ..." 的错误
  if (
    bgsaveResponse.startsWith('ERR') ||
    bgsaveResponse.startsWith('(error)')
  ) {
    // 特殊情况：如果已有后台保存正在进行，可以等待其完成
    if (bgsaveResponse.includes('Background save already in progress')) {
      logDebug('BGSAVE 已在执行中，等待其完成')
    } else {
      throw new Error(`BGSAVE 失败: ${bgsaveResponse}`)
    }
  } else if (
    !bgsaveResponse.includes('Background saving started') &&
    !bgsaveResponse.includes('Background save already in progress')
  ) {
    // 意外的响应 —— 警告但继续（可能是不同的 Valkey 版本）
    logDebug(
      `BGSAVE 非预期响应（继续执行）: ${bgsaveResponse}`,
    )
  }

  // 通过检查 rdb_bgsave_in_progress 等待保存完成
  // 此方法比 LASTSAVE 时间戳更可靠（LASTSAVE 只有秒级精度）
  const startTime = Date.now()
  const timeout = 60000 // 1 分钟超时

  while (Date.now() - startTime < timeout) {
    const infoOutput = await execValkeyCommand(
      valkeyCli,
      port,
      'INFO persistence',
      auth,
    )

    // 检查 BGSAVE 是否仍在进行中
    const inProgress = infoOutput.includes('rdb_bgsave_in_progress:1')
    if (!inProgress) {
      // 同时检查错误
      const statusMatch = infoOutput.match(/rdb_last_bgsave_status:(\w+)/)
      const status = statusMatch?.[1]
      if (status === 'err') {
        throw new Error('BGSAVE 失败，请查看 Valkey 日志以获取详细信息。')
      }
      logDebug('BGSAVE 已成功完成')
      break
    }

    await new Promise((r) => setTimeout(r, 100))
  }

  if (Date.now() - startTime >= timeout) {
    throw new Error('BGSAVE 超时，超过 60 秒未完成')
  }

  // 从 Valkey 数据目录获取 RDB 文件路径
  const dataDir = paths.getContainerDataPath(name, { engine: 'valkey' })
  const rdbPath = join(dataDir, 'dump.rdb')

  if (!existsSync(rdbPath)) {
    throw new Error(
      `BGSAVE 后在 ${rdbPath} 未找到 RDB 文件，请检查 Valkey 配置。`,
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
 * - 'text': 人类可读的 Valkey 命令文件（.valkey 文件）
 * - 'rdb'（默认）: 二进制 RDB 快照
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  // 'text' 格式表示 Valkey 文本命令备份
  if (options.format === 'text') {
    return createTextBackup(container, outputPath)
  }
  // 默认使用 RDB 格式
  return createRdbBackup(container, outputPath)
}

/**
 * 为克隆目的创建备份
 * 始终使用 RDB 格式以保证速度和可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createRdbBackup(container, outputPath)
}