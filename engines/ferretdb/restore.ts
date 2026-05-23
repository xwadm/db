/**
 * FerretDB 恢复模块
 *
 * 使用 pg_restore 或 psql 在嵌入式 PostgreSQL 后端上恢复备份。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { basename, join } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { containerManager } from '../../core/container-manager'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { buildMongoUri, normalizeMongoHost } from '../mongo-uri'
import { ferretdbBinaryManager } from './binary-manager'
import {
  getMongorestorePath,
  MONGORESTORE_NOT_FOUND_ERROR,
} from '../mongodb/cli-utils'
import {
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  isV1,
} from './version-maps'
import {
  Engine,
  type ContainerConfig,
  type BinaryTool,
  type BackupFormat,
  type RestoreResult,
} from '../../types'

// 对 MongoDB URI 中的凭据进行脱敏处理
function redactMongoUri(uri: string): string {
  try {
    const url = new URL(uri)
    if (!url.username && !url.password) {
      return uri
    }

    return `${url.protocol}//<已脱敏>@${url.host}${url.pathname}${url.search}`
  } catch {
    return 'mongodb://<已脱敏>'
  }
}

// 对 MongoDB 命令行参数中的 URI 进行脱敏处理
function sanitizeMongoArgs(args: string[]): string[] {
  const sanitized = [...args]
  const uriIndex = sanitized.indexOf('--uri')
  if (uriIndex >= 0 && uriIndex + 1 < sanitized.length) {
    sanitized[uriIndex + 1] = redactMongoUri(sanitized[uriIndex + 1])
  }
  return sanitized
}

/**
 * 解析 PostgreSQL 客户端二进制文件（pg_restore、psql 等）的路径
 *
 * 按以下顺序搜索并回退：
 * 1. 容器特定的后端二进制文件目录
 * 2. 任何已安装的 PostgreSQL 版本（从新到旧）—— 客户端工具向前兼容
 * 3. postgresql-documentdb 安装
 * 4. 通过 `spindb config set` 注册的系统二进制文件
 */
async function findBackendBinary(
  container: ContainerConfig,
  binaryName: BinaryTool,
): Promise<string> {
  const { version, backendVersion } = container
  const { platform, arch } = platformService.getPlatformInfo()
  const v1 = isV1(version)
  const ext = platformService.getExecutableExtension()

  const effectiveBackendVersion = v1
    ? backendVersion || DEFAULT_V1_POSTGRESQL_VERSION
    : backendVersion || DEFAULT_DOCUMENTDB_VERSION

  // 1. 尝试容器自身的后端路径
  const backendPath = ferretdbBinaryManager.getBackendBinaryPath(
    version,
    effectiveBackendVersion,
    platform,
    arch,
  )
  const primaryPath = join(backendPath, 'bin', `${binaryName}${ext}`)
  if (existsSync(primaryPath)) {
    return primaryPath
  }

  logDebug(
    `${binaryName} 未找到于 ${primaryPath}，正在搜索其他已安装的 PostgreSQL 版本`,
  )

  // 2. 搜索所有已安装的 PostgreSQL 版本（从新到旧）
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  for (const entry of installed) {
    const candidate = join(entry.path, 'bin', `${binaryName}${ext}`)
    if (existsSync(candidate)) {
      logDebug(`在 PostgreSQL ${entry.version} 中找到 ${binaryName}`)
      return candidate
    }
  }

  // 3. 检查 postgresql-documentdb 安装
  const documentdbInstalled = paths.findInstalledBinaries(
    'postgresql-documentdb',
    platform,
    arch,
  )
  for (const entry of documentdbInstalled) {
    const candidate = join(entry.path, 'bin', `${binaryName}${ext}`)
    if (existsSync(candidate)) {
      logDebug(`在 postgresql-documentdb ${entry.version} 中找到 ${binaryName}`)
      return candidate
    }
  }

  // 4. 回退到系统二进制文件
  const systemBinary = await configManager.getBinaryPath(binaryName)
  if (systemBinary) {
    return systemBinary
  }

  const backendName = v1 ? 'PostgreSQL' : 'postgresql-documentdb'
  throw new Error(
    `${binaryName} 未找到。${backendName} 安装于 ${backendPath} 不包含客户端工具。\n` +
      '请下载 PostgreSQL 二进制文件: spindb engines download postgresql',
  )
}

/**
 * 获取 pg_restore 的路径
 */
async function getPgRestorePath(container: ContainerConfig): Promise<string> {
  return findBackendBinary(container, 'pg_restore')
}

/**
 * 获取 psql 的路径
 */
async function getPsqlPath(container: ContainerConfig): Promise<string> {
  return findBackendBinary(container, 'psql')
}

// 添加命名空间重映射参数
function addNamespaceRemapArgs(
  args: string[],
  sourceDatabase: string | undefined,
  targetDatabase: string,
): void {
  if (sourceDatabase) {
    args.push(
      `--nsFrom=${sourceDatabase}.$collection$`,
      `--nsTo=${targetDatabase}.$collection$`,
    )
    return
  }

  args.push(
    '--nsFrom=$db$.$collection$',
    `--nsTo=${targetDatabase}.$collection$`,
  )
}

/**
 * 检测备份文件的格式
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
      format: 'directory',
      description: 'MongoDB 目录转储（BSON 文件）',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
    }
  }

  // 检查文件头以确定格式
  try {
    const buffer = Buffer.alloc(256)
    const fd = await open(filePath, 'r')
    let bytesRead = 0
    try {
      const result = await fd.read(buffer, 0, 256, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close().catch(() => {})
    }

    // PostgreSQL 自定义格式以 "PGDMP" 开头
    const header = buffer.toString('ascii', 0, 5)
    if (header === 'PGDMP') {
      return {
        format: 'custom',
        description: '旧版 PostgreSQL 自定义格式备份',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d ferretdb ${filePath}`,
      }
    }

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return {
        format: 'archive-gzip',
        description: 'MongoDB 归档（gzip 压缩）',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath} --gzip`,
      }
    }

    const mongoHeader = buffer.toString('utf8', 0, 16)
    if (mongoHeader.startsWith('mtools') || mongoHeader.includes('mongo')) {
      return {
        format: 'archive',
        description: 'MongoDB 归档',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
      }
    }

    // 使用更大的缓冲区和词边界检查来检测 SQL 格式
    // 如果存在 BOM（字节顺序标记）则去除，以避免误判
    const textHeader = buffer
      .toString('utf8', 0, bytesRead)
      .replace(/^\uFEFF/, '')
      .toLowerCase()
    const isSqlFormat =
      textHeader.startsWith('--') ||
      textHeader.startsWith('/*') ||
      textHeader.includes('\n--') ||
      textHeader.includes('\n/*') ||
      /(?:^|\s)create\s/.test(textHeader) ||
      /(?:^|\s)insert\s/.test(textHeader) ||
      /(?:^|\s)drop\s/.test(textHeader) ||
      textHeader.includes('pg_dump')
    if (isSqlFormat) {
      return {
        format: 'sql',
        description: '旧版纯 SQL 备份',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d ferretdb -f ${filePath}`,
      }
    }

    // 检查文件扩展名作为回退
    if (filePath.endsWith('.bson')) {
      return {
        format: 'bson',
        description: 'MongoDB BSON 文件',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
      }
    }

    if (filePath.endsWith('.dump')) {
      return {
        format: 'custom',
        description: '旧版 PostgreSQL 自定义格式备份（按扩展名判断）',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d ferretdb ${filePath}`,
      }
    }

    if (filePath.endsWith('.sql')) {
      return {
        format: 'sql',
        description: '旧版纯 SQL 备份（按扩展名判断）',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d ferretdb -f ${filePath}`,
      }
    }

    return {
      format: 'unknown',
      description: '未知格式 - 尝试 MongoDB 归档恢复',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
    }
  } catch {
    return {
      format: 'unknown',
      description: '无法检测格式',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
    }
  }
}

// 恢复选项
export type RestoreOptions = {
  containerName?: string
  port: number
  database: string
  drop?: boolean
  timeoutMs?: number // 超时时间（毫秒，默认 5 分钟）
  sourceDatabase?: string
  containerVersion?: string
}

// 恢复操作的默认超时时间（5 分钟）
const DEFAULT_RESTORE_TIMEOUT_MS = 5 * 60 * 1000

// 通过 MongoDB 协议恢复备份
async function restoreViaMongo(
  backupPath: string,
  options: RestoreOptions,
  format: BackupFormat,
): Promise<RestoreResult> {
  const {
    port,
    database,
    drop = true,
    sourceDatabase,
    containerVersion,
  } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS
  const backupDatabase = sourceDatabase ?? database

  const mongorestore = await getMongorestorePath(containerVersion)
  if (!mongorestore) {
    throw new Error(MONGORESTORE_NOT_FOUND_ERROR)
  }

  const savedCreds = options.containerName
    ? await loadCredentials(
        options.containerName,
        Engine.FerretDB,
        getDefaultUsername(Engine.FerretDB),
      )
    : null
  const container = options.containerName
    ? await containerManager.getConfig(options.containerName)
    : null
  const host = normalizeMongoHost(container?.bindAddress)

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(
          port,
          database,
          {
            username: savedCreds.username,
            password: savedCreds.password,
            authDatabase: savedCreds.database || 'admin',
          },
          host,
        ),
      ]
    : ['--host', host, '--port', String(port)]

  if (drop) {
    args.push('--drop')
  }

  const isArchiveFormat =
    format.format === 'archive-gzip' ||
    format.format === 'archive' ||
    format.format === 'unknown'

  if (!isArchiveFormat) {
    args.push('--db', database)
  }

  if (format.format === 'directory') {
    const backupDbDir = join(backupPath, backupDatabase)
    if (existsSync(backupDbDir)) {
      args.push(backupDbDir)
    } else {
      let restorePath = backupPath

      try {
        const entries = readdirSync(backupPath, { withFileTypes: true })
        const dbDirs = entries.filter((entry) => entry.isDirectory())

        if (dbDirs.length === 1) {
          restorePath = join(backupPath, dbDirs[0].name)
        } else if (dbDirs.length > 1) {
          const dbWithBson = dbDirs.find((entry) => {
            const files = readdirSync(join(backupPath, entry.name))
            return files.some((file) => file.endsWith('.bson'))
          })
          if (dbWithBson) {
            restorePath = join(backupPath, dbWithBson.name)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logWarning(
          `检查 FerretDB 备份目录 "${backupPath}" 失败: ${message}。回退到根目录恢复。`,
        )
      }

      args.push(restorePath)
    }
  } else if (format.format === 'archive-gzip') {
    args.push('--archive=' + backupPath, '--gzip')
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'archive') {
    args.push('--archive=' + backupPath)
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'bson') {
    const collectionName = basename(backupPath).replace(/\.bson$/i, '')
    if (!args.some((arg) => arg === '--db' || arg.startsWith('--db='))) {
      args.push(`--db=${database}`)
    }
    args.push(`--collection=${collectionName}`)
    args.push(backupPath)
  } else {
    args.push('--archive=' + backupPath)
    addNamespaceRemapArgs(args, sourceDatabase, database)
  }

  logDebug(
    `正在运行 mongorestore，参数: ${sanitizeMongoArgs(args).join(' ')}`,
  )

  return new Promise((resolve, reject) => {
    const proc = spawn(mongorestore, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      settled = true
    }

    timeoutId = setTimeout(() => {
      if (settled) return
      cleanup()
      try {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill('SIGTERM')
        }
      } catch {
        // 忽略终止竞争
      }
      reject(
        new Error(
          `恢复在 ${timeoutMs}ms 后超时。mongorestore 进程已被终止。`,
        ),
      )
    }, timeoutMs)

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (settled) return
      cleanup()
      reject(error)
    })
    proc.on('close', (code) => {
      if (settled) return
      cleanup()
      if (code === 0) {
        resolve({ format: format.format, stdout, stderr, code })
      } else {
        reject(new Error(stderr || `mongorestore 以退出码 ${code} 退出`))
      }
    })
  })
}

/**
 * 将备份恢复到 FerretDB 容器
 *
 * 自定义格式备份使用 pg_restore，SQL 格式备份使用 psql
 */
export async function restoreBackup(
  container: ContainerConfig,
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { backendPort } = container
  const {
    database,
    drop = true,
    timeoutMs = DEFAULT_RESTORE_TIMEOUT_MS,
  } = options

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到的备份格式: ${format.format}`)

  if (
    format.format === 'archive-gzip' ||
    format.format === 'archive' ||
    format.format === 'directory' ||
    format.format === 'bson' ||
    format.format === 'unknown'
  ) {
    return restoreViaMongo(backupPath, options, format)
  }

  if (!backendPort) {
    throw new Error(
      '后端端口未设置。请确保容器正在运行后再恢复。',
    )
  }

  // 根据格式选择恢复工具
  const isSqlFormat = format.format === 'sql'
  const targetDb =
    format.format === 'custom' || format.format === 'sql'
      ? 'ferretdb'
      : database
  const toolPath = isSqlFormat
    ? await getPsqlPath(container)
    : await getPgRestorePath(container)

  const args: string[] = [
    '-h',
    '127.0.0.1',
    '-p',
    String(backendPort),
    '-U',
    'postgres',
    '-d',
    targetDb,
  ]

  if (isSqlFormat) {
    // psql：使用 -f 标志进行文件输入
    args.push('-f', backupPath)
    if (drop) {
      logWarning(
        'SQL 格式恢复：不支持 --clean。' +
          '如果需要删除已有对象，请确保 SQL 转储是使用 pg_dump --clean 创建的。',
      )
    }
  } else {
    // pg_restore：为自定义/目录格式添加选项
    if (drop) {
      args.push('--clean', '--if-exists')
    }
    args.push(backupPath)
  }

  logDebug(
    `正在运行 ${isSqlFormat ? 'psql' : 'pg_restore'}，参数: ${args.join(' ')}`,
  )

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(toolPath, args, spawnOptions)

    let stdout = ''
    let stderr = ''
    let finished = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    // 清理并标记完成的辅助函数
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      finished = true
    }

    // 启动超时计时器
    timeoutId = setTimeout(() => {
      if (finished) return
      cleanup()
      // 防御性地终止进程 —— 进程可能在 finished 检查和此调用之间已退出，
      // 因此用 try-catch 包裹
      try {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill('SIGTERM')
        }
      } catch {
        // 进程已退出或不可终止 —— 忽略
      }
      reject(
        new Error(
          `恢复在 ${timeoutMs}ms 后超时。${isSqlFormat ? 'psql' : 'pg_restore'} 进程已被终止。`,
        ),
      )
    }, timeoutMs)

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      // 立即拒绝并标记完成，防止与 close 处理程序的竞争
      if (finished) return
      cleanup()
      reject(err)
    })

    proc.on('close', (code) => {
      if (finished) return
      cleanup()

      if (code === 0) {
        resolve({
          format: format.format,
          stdout,
          stderr,
          code,
        })
      } else {
        // pg_restore 可能以非零退出码退出但仍然恢复了一些数据
        // 仅当所有非空行都匹配警告模式时才视为仅警告
        // 这可以防止真正的错误与警告混合时被抑制
        const stderrLines = stderr
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)

        const warningPatterns = [
          /\balready exists\b/,
          /^WARNING:/i,
          /^pg_restore: warning:/i,
        ]

        const allLinesAreWarnings =
          stderrLines.length > 0 &&
          stderrLines.every((line) =>
            warningPatterns.some((pattern) => pattern.test(line)),
          )

        // pg_restore 在遇到错误但仍然完成恢复时输出
        // "errors ignored on restore: N" —— 这意味着恢复已完成
        const pgRestoreCompletedWithIgnoredErrors =
          /pg_restore: warning: errors ignored on restore: \d+/i.test(stderr)

        const isWarningOnly =
          allLinesAreWarnings || pgRestoreCompletedWithIgnoredErrors

        if (isWarningOnly) {
          logWarning(`恢复已完成，但有警告: ${stderr}`)
          resolve({
            format: format.format,
            stdout,
            stderr,
            code: code ?? undefined,
          })
        } else {
          reject(
            new Error(
              stderr ||
                `${isSqlFormat ? 'psql' : 'pg_restore'} 以退出码 ${code} 退出`,
            ),
          )
        }
      }
    })
  })
}
