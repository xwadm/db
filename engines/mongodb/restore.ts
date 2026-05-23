/**
 * MongoDB 恢复模块
 * 封装 mongorestore，用于恢复数据库备份
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import { getMongorestorePath, MONGORESTORE_NOT_FOUND_ERROR } from './cli-utils'
import { buildMongoUri } from '../mongo-uri'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

// 检测 MongoDB 备份的格式
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到: ${filePath}`)
  }

  const stats = statSync(filePath)

  // 目录转储
  if (stats.isDirectory()) {
    return {
      format: 'directory',
      description: 'MongoDB 目录转储（BSON 文件）',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
    }
  }

  // 读取文件头部以判断归档格式
  try {
    const buffer = Buffer.alloc(16)
    const fd = await open(filePath, 'r')
    let header: string
    try {
      await fd.read(buffer, 0, 16, 0)
      header = buffer.toString('utf8', 0, 6)
    } finally {
      await fd.close().catch(() => {})
    }

    // 检查 gzip 魔数
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return {
        format: 'archive-gzip',
        description: 'MongoDB 归档（gzip 压缩）',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath} --gzip`,
      }
    }

    // 检查未压缩归档（以 "mtools" 开头）
    if (header === 'mtools' || header.includes('mongo')) {
      return {
        format: 'archive',
        description: 'MongoDB 归档（未压缩）',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
      }
    }

    // 检查 BSON 文件
    if (filePath.endsWith('.bson')) {
      return {
        format: 'bson',
        description: 'MongoDB BSON 文件',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
      }
    }

    // 默认按归档格式处理
    return {
      format: 'unknown',
      description: '未知格式 - 尝试按归档处理',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT ${filePath}`,
    }
  } catch {
    return {
      format: 'unknown',
      description: '无法检测格式',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT ${filePath}`,
    }
  }
}

// 恢复选项
export type RestoreOptions = {
  containerName?: string
  port: number
  database: string
  drop?: boolean // 恢复前是否删除已有数据
  validateVersion?: boolean
  sourceDatabase?: string // 备份中的原始数据库名称（用于命名空间重映射）
  containerVersion?: string // 容器的 MongoDB 版本，用于版本匹配查找
}

/**
 * 为归档格式恢复添加命名空间重映射参数。
 * 如果提供了 sourceDatabase 则使用它，否则使用 $prefix$ 占位符。
 *
 * 重要：mongorestore 使用 $prefix$ 和 $suffix$ 作为特殊捕获组：
 * - $prefix$ 捕获源命名空间中的数据库名
 * - $suffix$ 捕获源命名空间中的集合名
 *
 * 不要用 `*` 代替 `$prefix$` —— 虽然 `*` 在某些上下文中是通配符，
 * 但 mongorestore 要求重映射两侧使用匹配的捕获组。
 * 左侧使用 `*.*`、右侧使用 `db.$suffix$` 会导致错误：
 * "Different number of asterisks in from and to"
 */
function addNamespaceRemapArgs(
  args: string[],
  sourceDatabase: string | undefined,
  targetDatabase: string,
): void {
  const nsFromDb = sourceDatabase ?? '$prefix$'
  args.push(
    `--nsFrom=${nsFromDb}.$suffix$`,
    `--nsTo=${targetDatabase}.$suffix$`,
  )
}

// 使用 mongorestore 恢复 MongoDB 备份
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    port,
    database,
    drop = true,
    sourceDatabase,
    containerVersion,
  } = options

  const mongorestore = await getMongorestorePath(containerVersion)
  if (!mongorestore) {
    throw new Error(MONGORESTORE_NOT_FOUND_ERROR)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到的备份格式: ${format.format}`)

  const savedCreds = options.containerName
    ? await loadCredentials(
        options.containerName,
        Engine.MongoDB,
        getDefaultUsername(Engine.MongoDB),
      )
    : null
  const container =
    options.containerName
      ? await containerManager.getConfig(options.containerName)
      : null
  const host = container?.bindAddress ?? '127.0.0.1'

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, database, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }, host),
      ]
    : ['--host', '127.0.0.1', '--port', String(port)]

  if (drop) {
    args.push('--drop')
  }

  // 处理不同格式
  // 目录格式下 --db 可直接生效
  // 归档格式下需要命名空间重映射，因为仅使用 --db 不会进行重映射
  const isArchiveFormat =
    format.format === 'archive-gzip' ||
    format.format === 'archive' ||
    format.format === 'unknown'

  if (!isArchiveFormat) {
    // 目录和 BSON 格式：--db 可直接生效
    args.push('--db', database)
  }

  if (format.format === 'directory') {
    // 目录转储 - 查找数据库子目录
    // 首先尝试目标数据库名
    const targetDbDir = join(backupPath, database)
    if (existsSync(targetDbDir)) {
      args.push(targetDbDir)
    } else {
      // 恢复到不同数据库时，查找任意数据库子目录
      // （mongodump 会创建 backupPath/{sourceDatabase}/ 目录结构）
      const entries = readdirSync(backupPath, { withFileTypes: true })
      const dbDirs = entries.filter((e) => e.isDirectory())

      if (dbDirs.length === 1) {
        // 仅有一个数据库目录 - 直接使用
        const sourceDbDir = join(backupPath, dbDirs[0].name)
        logDebug(`使用源数据库目录: ${sourceDbDir}`)
        args.push(sourceDbDir)
      } else if (dbDirs.length > 1) {
        // 多个目录 - 尝试找到包含 BSON 文件的目录
        const dbWithBson = dbDirs.find((d) => {
          const dirPath = join(backupPath, d.name)
          const files = readdirSync(dirPath)
          return files.some((f) => f.endsWith('.bson'))
        })
        if (dbWithBson) {
          const sourceDbDir = join(backupPath, dbWithBson.name)
          logDebug(
            `使用包含 BSON 文件的源数据库目录: ${sourceDbDir}`,
          )
          args.push(sourceDbDir)
        } else {
          args.push(backupPath)
        }
      } else {
        // 无子目录 - 直接使用路径
        args.push(backupPath)
      }
    }
  } else if (format.format === 'archive-gzip') {
    args.push('--archive=' + backupPath, '--gzip')
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'archive') {
    args.push('--archive=' + backupPath)
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'bson') {
    // BSON 文件直接传入，不需要 --archive 标志
    args.push(backupPath)
  } else {
    // 未知格式默认按归档处理
    args.push('--archive=' + backupPath, '--gzip')
    addNamespaceRemapArgs(args, sourceDatabase, database)
  }

  logDebug(`正在执行 mongorestore，参数: ${args.join(' ')}`)

  // 注意：不要使用 shell 模式 - 当 shell: false（默认值）时，
  // spawn 能正确处理包含空格的路径。
  // Shell 模式会破坏类似 "C:\Program Files\..." 的路径
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongorestore, args, spawnOptions)

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          format: format.format,
          stdout,
          stderr,
          code,
        })
      } else {
        // mongorestore 可能以非零退出码退出，但仍恢复了部分数据
        if (
          stderr.includes('continuing') ||
          stderr.includes('documents restored')
        ) {
          logWarning(`mongorestore 完成但有警告: ${stderr}`)
          resolve({
            format: format.format,
            stdout,
            stderr,
            code: code ?? undefined,
          })
        } else {
          reject(new Error(stderr || `mongorestore 以退出码 ${code} 退出`))
        }
      }
    })
  })
}

/**
 * 解析后的 MongoDB 连接字符串结果
 * 对于 SRV URI，仅设置 `uri` 和 `database`（主机/端口通过 DNS 解析）
 * 对于标准 URI，直接解析 host/port
 */
export type ParsedConnectionString =
  | {
      isSrv: true
      uri: string
      database: string
    }
  | {
      isSrv: false
      host: string
      port: string
      database: string
      user?: string
      password?: string
    }

/**
 * 解析 MongoDB 连接字符串
 *
 * 支持的格式：
 * - mongodb://[user:password@]host[:port]/database
 * - mongodb+srv://[user:password@]host/database
 *
 * SRV URI 使用 DNS 解析主机/端口，必须通过 --uri 传递给 mongodump/mongorestore。
 *
 * 数据库名称处理：
 * - 从 URL 路径中提取（例如 "/mydb" → "mydb"）
 * - 前导斜杠会自动去除
 * - 如果未指定数据库（路径为空或仅为 "/"），默认为 "test"，
 *   遵循 MongoDB 默认数据库名的惯例
 *
 * @param connectionString - MongoDB 连接 URI
 * @returns 包含 `isSrv` 判别属性的解析结果
 * @throws 当出现以下情况时抛出带有描述信息的错误：
 *   - 输入为 null、undefined 或非字符串
 *   - URL 格式错误（错误信息中凭据会被脱敏处理）
 *   - 协议不是 "mongodb://" 或 "mongodb+srv://"
 */
export function parseConnectionString(
  connectionString: string,
): ParsedConnectionString {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '无效的 MongoDB 连接字符串: 期望一个非空字符串',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // 在错误信息中脱敏凭据
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `无效的 MongoDB 连接字符串: "${sanitized}"。` +
        `期望格式: mongodb://[user:password@]host[:port]/database`,
      { cause: error },
    )
  }

  // 验证协议
  if (url.protocol !== 'mongodb:' && url.protocol !== 'mongodb+srv:') {
    throw new Error(
      `无效的 MongoDB 连接字符串: 不支持的协议 "${url.protocol}"。` +
        `期望 "mongodb://" 或 "mongodb+srv://"`,
    )
  }

  const database = url.pathname.replace(/^\//, '') || 'test'

  // SRV URI 必须通过 --uri 原样传递（DNS 解析实际的主机/端口）
  if (url.protocol === 'mongodb+srv:') {
    return {
      isSrv: true,
      uri: connectionString,
      database,
    }
  }

  // 标准 mongodb:// URI 可解析为 host/port
  const host = url.hostname || '127.0.0.1'
  const port = url.port || '27017'
  const user = url.username || undefined
  const password = url.password || undefined

  return { isSrv: false, host, port, database, user, password }
}
