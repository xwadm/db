/**
 * TypeDB 恢复模块
 * 支持使用 typedb 控制台导入方式进行基于 TypeQL 的恢复
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import {
  requireTypeDBConsolePath,
  getConsoleBaseArgs,
  validateTypeDBIdentifier,
} from './cli-utils'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

/**
 * 指示 TypeDB 备份的 TypeQL 关键字
 */
const TYPEQL_KEYWORDS = [
  'DEFINE',
  'MATCH',
  'INSERT',
  'DELETE',
  'PUT',
  'UNDEFINE',
  'RULE',
  'TYPE',
  'ENTITY',
  'RELATION',
  'ATTRIBUTE',
  'OWNS',
  'PLAYS',
  'RELATES',
  'SUB',
  'ISA',
  'HAS',
]

/**
 * 检查文件内容是否类似 TypeQL
 * 仅读取前 8KB 以避免将大文件加载到内存中
 */
async function looksLikeTypeQL(filePath: string): Promise<boolean> {
  try {
    const HEADER_SIZE = 8192
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
    const lines = content.split(/\r?\n/)

    let typeqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))
        continue

      checkedLines++

      // 检查 TypeQL 关键字
      for (const keyword of TYPEQL_KEYWORDS) {
        if (trimmed.startsWith(keyword) || trimmed.includes(` ${keyword} `)) {
          typeqlStatementsFound++
          break
        }
      }

      if (typeqlStatementsFound >= 2) {
        return true
      }
    }

    return typeqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * 检查 .typeql 备份路径是否有配套的 schema/data 配对文件
 */
function hasSchemaDataPair(filePath: string): boolean {
  return (
    filePath.endsWith('.typeql') &&
    (existsSync(filePath.replace(/\.typeql$/, '-schema.typeql')) ||
      existsSync(filePath.replace(/\.typeql$/, '-data.typeql')))
  )
}

/**
 * 从文件中检测备份格式
 * 支持：
 * - TypeQL：Schema + 数据语句
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // TypeDB 备份创建 schema/data 配对文件（-schema.typeql、-data.typeql）
  // 而非单个文件，因此也要检查这些变体
  const hasPair = hasSchemaDataPair(filePath)

  if (!existsSync(filePath) && !hasPair) {
    throw new Error(`备份文件未找到: ${filePath}`)
  }

  // 如果 schema/data 配对文件存在，则为 TypeQL 备份
  if (hasPair) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份（schema + data 配对文件）',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '发现目录 - TypeDB 恢复需要 TypeQL 文件',
      restoreCommand: 'TypeDB 恢复需要 .typeql 文件',
    }
  }

  // 先按文件扩展名检查 .typeql 文件
  if (filePath.endsWith('.typeql') || filePath.endsWith('.tql')) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  // 基于内容的检测
  if (await looksLikeTypeQL(filePath)) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL 备份（通过内容检测）',
      restoreCommand:
        '通过 typedb 控制台导入 TypeQL（spindb restore 会处理此操作）',
    }
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用包含 TypeQL 语句的 .typeql 文件',
  }
}

// TypeDB 的恢复选项
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
}

/**
 * 使用 typedb 控制台导入功能从 TypeQL 备份恢复
 *
 * TypeDB 导入需要 schema 和数据文件。
 * 我们同时检查 `-schema.typeql` 和 `-data.typeql` 变体。
 */
async function restoreTypeQLBackup(
  backupPath: string,
  containerName: string,
  port: number,
  database: string,
  version?: string,
): Promise<RestoreResult> {
  validateTypeDBIdentifier(database)
  const consolePath = await requireTypeDBConsolePath(version)

  // 通过去除可选的 -schema/-data 后缀和扩展名来推导基础名称
  const baseName = backupPath
    .replace(/\.(typeql|tql)$/, '')
    .replace(/-(schema|data)$/, '')
  const schemaPath = `${baseName}-schema.typeql`
  const dataPath = `${baseName}-data.typeql`

  const hasSchema = existsSync(schemaPath)
  const hasData = existsSync(dataPath)

  if (hasSchema || hasData) {
    // 分别导入 schema 和数据
    // 注意：不要在此处给路径加引号。TypeDB 控制台的 --command 解析器将
    // 双引号视为字面字符而非分隔符。加引号会导致所有导入失败。
    const paths = [
      ...(hasSchema ? [schemaPath] : []),
      ...(hasData ? [dataPath] : []),
    ]
    const command = `database import ${database} ${paths.join(' ')}`

    return runConsoleCommand(consolePath, containerName, port, command)
  }

  // 单文件导入 - 视为 schema
  const command = `database import ${database} ${backupPath}`
  return runConsoleCommand(consolePath, containerName, port, command)
}

/**
 * 运行 TypeDB 控制台命令并返回结果
 */
async function runConsoleCommand(
  consolePath: string,
  containerName: string,
  port: number,
  command: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<RestoreResult> {
  const savedCreds = await loadCredentials(
    containerName,
    Engine.TypeDB,
    getDefaultUsername(Engine.TypeDB),
  )

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      ...getConsoleBaseArgs(
        port,
        '127.0.0.1',
        true,
        savedCreds
          ? {
              username: savedCreds.username,
              password: savedCreds.password,
            }
          : undefined,
      ),
      '--command',
      command,
    ]

    const sanitizedArgs = args.map((a, i) =>
      args[i - 1] === '--password' ? '***' : a,
    )
    logDebug(`正在运行: typedb_console_bin ${sanitizedArgs.join(' ')}`)

    const proc = spawn(consolePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(
        new Error(
          `typedb 控制台在运行 ${Math.round(timeoutMs / 1000)}s 后超时，命令: ${command}`,
        ),
      )
    }, timeoutMs)

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({
          format: 'typeql',
          stdout: stdout || 'TypeQL 语句导入成功',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `typedb 控制台退出，返回码 ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`启动 typedb 控制台失败: ${error.message}`))
    })
  })
}

/**
 * 从备份恢复
 * 支持：
 * - TypeQL：通过 typedb 控制台导入
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database = 'default', version } = options

  // TypeDB 备份创建 schema/data 配对文件（-schema.typeql、-data.typeql）
  // 而非 backupPath 处的单个文件，因此也要检查这些文件
  if (!existsSync(backupPath) && !hasSchemaDataPair(backupPath)) {
    throw new Error(`备份文件未找到: ${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式: ${format.format}`)

  if (format.format === 'typeql') {
    return restoreTypeQLBackup(
      backupPath,
      containerName,
      port,
      database,
      version,
    )
  }

  throw new Error(
    `无效的备份格式: ${format.format}。请使用包含 TypeQL 语句的 .typeql 文件。`,
  )
}

/**
 * 解析 TypeDB 连接字符串
 * 格式：typedb://host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 TypeDB 连接字符串: 需要非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 TypeDB 连接字符串: "${connectionString}"。` +
        `期望格式: typedb://host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议
  if (url.protocol !== 'typedb:') {
    throw new Error(
      `无效的 TypeDB 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "typedb://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'

  let port = 1729
  if (url.port) {
    const parsed = Number(url.port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `无效的 TypeDB 连接字符串: 无效端口 '${url.port}'`,
      )
    }
    port = parsed
  }

  const database = url.pathname.replace(/^\//, '') || 'default'

  return {
    host,
    port,
    database,
  }
}
