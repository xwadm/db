/**
 * MariaDB 备份检测与恢复
 *
 * 负责检测备份文件格式和恢复 MariaDB 数据库转储。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { createGunzip } from 'zlib'
import { validateRestoreCompatibility } from './version-validator'
import { getEngineDefaults } from '../../config/defaults'
import { logDebug, SpinDBError, ErrorCodes } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { platformService } from '../../core/platform-service'
import {
  Engine,
  Platform,
  type BackupFormat,
  type RestoreResult,
} from '../../types'

const engineDef = getEngineDefaults('mariadb')

// =============================================================================
// 备份格式检测
// =============================================================================

/**
 * 检测 MariaDB 备份文件的格式
 *
 * 可检测以下格式：
 * - MariaDB SQL 转储
 * - MySQL SQL 转储（兼容 MariaDB）
 * - PostgreSQL 转储（提供有用的错误提示）
 * - 通用 SQL 文件
 * - 压缩文件（gzip）
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  const buffer = Buffer.alloc(128)
  const file = await open(filePath, 'r')
  await file.read(buffer, 0, 128, 0)
  await file.close()

  const header = buffer.toString('utf8')

  // 检查 PostgreSQL 自定义格式（PGDMP 魔数）
  if (buffer.toString('ascii', 0, 5) === 'PGDMP') {
    return {
      format: 'postgresql_custom',
      description: 'PostgreSQL 自定义格式转储（与 MariaDB 不兼容）',
      restoreCommand: 'pg_restore',
    }
  }

  // 检查 PostgreSQL SQL 转储标记
  if (
    header.includes('-- PostgreSQL database dump') ||
    header.includes('pg_dump') ||
    header.includes('Dumped from database version')
  ) {
    return {
      format: 'postgresql_sql',
      description: 'PostgreSQL SQL 转储（与 MariaDB 不兼容）',
      restoreCommand: 'psql',
    }
  }

  // 检查 gzip 压缩
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip 压缩的 SQL 转储',
      restoreCommand: 'mariadb',
    }
  }

  // 检查 MariaDB 转储标记
  if (header.includes('-- MariaDB dump')) {
    return {
      format: 'sql',
      description: 'MariaDB SQL 转储（mariadb-dump）',
      restoreCommand: 'mariadb',
    }
  }

  // 检查 MySQL 转储标记（兼容 MariaDB）
  if (header.includes('-- MySQL dump')) {
    return {
      format: 'sql',
      description: 'MySQL SQL 转储（兼容 MariaDB）',
      restoreCommand: 'mariadb',
    }
  }

  // 检查是否为 SQL 文件（以常见 SQL 语句开头）
  const textStart = header.toLowerCase()
  if (
    textStart.startsWith('--') ||
    textStart.startsWith('/*') ||
    textStart.startsWith('set ') ||
    textStart.startsWith('create') ||
    textStart.startsWith('drop') ||
    textStart.startsWith('begin') ||
    textStart.startsWith('use ')
  ) {
    return {
      format: 'sql',
      description: 'SQL 文件',
      restoreCommand: 'mariadb',
    }
  }

  // 默认为 SQL 格式
  return {
    format: 'unknown',
    description: '未知格式 - 将尝试作为 SQL 处理',
    restoreCommand: 'mariadb',
  }
}

// 检查备份文件是否来自错误的引擎，如果是则抛出有用的错误信息
export function assertCompatibleFormat(format: BackupFormat): void {
  if (
    format.format === 'postgresql_custom' ||
    format.format === 'postgresql_sql'
  ) {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `这似乎是一个 PostgreSQL 转储文件，但您正尝试将其恢复到 MariaDB。`,
      'fatal',
      `请改为创建 PostgreSQL 容器：\n  spindb create mydb --engine postgresql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'mariadb',
        detectedEngine: 'postgresql',
      },
    )
  }
}

// =============================================================================
// 恢复选项
// =============================================================================

export type RestoreOptions = {
  containerName?: string
  port: number
  database: string
  user?: string
  password?: string
  createDatabase?: boolean
  validateVersion?: boolean
  binPath: string
}

// 从二进制路径中获取 mariadb 或 mysql 客户端路径
function getMysqlClientPath(binPath: string): string {
  const { platform } = platformService.getPlatformInfo()
  const ext = platform === Platform.Win32 ? '.exe' : ''

  // 优先尝试 mariadb，然后尝试 mysql
  const mariadb = join(binPath, 'bin', `mariadb${ext}`)
  if (existsSync(mariadb)) {
    return mariadb
  }

  const mysql = join(binPath, 'bin', `mysql${ext}`)
  if (existsSync(mysql)) {
    return mysql
  }

  throw new Error(
    'mariadb 或 mysql 客户端未在 MariaDB 二进制目录中找到。\n' +
      '请重新下载 MariaDB 二进制文件：spindb engines download mariadb',
  )
}

// =============================================================================
// 恢复函数
// =============================================================================

// 兼容性 SQL，用于处理大行大小和其他边缘情况
// - innodb_default_row_format=DYNAMIC：将长列存储在页外以避免行大小限制
// - innodb_strict_mode=OFF：允许在严格模式下可能超出行大小限制的表
// - foreign_key_checks=0：延迟外键检查直到所有表创建完成
// - unique_checks=0：加速批量插入
const COMPAT_INIT_SQL = [
  "SET GLOBAL innodb_default_row_format='dynamic';",
  'SET SESSION innodb_strict_mode=OFF;',
  "SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION';",
  'SET SESSION foreign_key_checks=0;',
  'SET SESSION unique_checks=0;',
  '',
].join('\n')

/**
 * 内部恢复函数，支持可选的兼容模式
 */
function doRestore(
  backupPath: string,
  mysql: string,
  port: number,
  database: string,
  user: string,
  password: string | undefined,
  format: BackupFormat,
  withCompatSettings: boolean,
): Promise<RestoreResult & { rawStderr?: string }> {
  const env = { ...process.env }
  if (password) {
    env.MYSQL_PWD = password
  } else {
    delete env.MYSQL_PWD
  }

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }

  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-P', String(port), '-u', user, database]

    logDebug('正在使用 mariadb 客户端恢复备份', {
      mysql,
      args,
      withCompatSettings,
    })

    const proc = spawn(mysql, args, spawnOptions)

    // 跟踪 Promise 是否已解决，避免重复拒绝
    let settled = false
    const fileStream = createReadStream(backupPath)

    const rejectOnce = (err: Error) => {
      if (settled) return
      settled = true
      fileStream.destroy()
      proc.stdin?.end()
      reject(err)
    }

    // 处理文件读取错误
    fileStream.on('error', (err) => {
      rejectOnce(new Error(`读取备份文件失败：${err.message}`))
    })

    if (!proc.stdin) {
      rejectOnce(
        new Error(
          'MariaDB 进程的 stdin 不可用，无法恢复备份',
        ),
      )
      return
    }

    // 处理 stdin 上的 EPIPE 错误 - 当我们仍在传输数据时 mariadb 因 SQL 错误退出时会发生
    // 实际错误会在 stderr 中
    proc.stdin.on('error', (err) => {
      // EPIPE 在进程提前退出时是预期的 - 不在此处拒绝，
      // 让 'close' 事件处理 stderr 中的实际错误
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        rejectOnce(
          new Error(`写入 MariaDB 进程失败：${err.message}`),
        )
      }
    })

    // 如果请求，在前面添加兼容性设置
    if (withCompatSettings) {
      proc.stdin.write(COMPAT_INIT_SQL)
      logDebug('已在恢复前添加兼容性设置')
    }

    if (format.format === 'compressed') {
      // 在传输到 mariadb 之前解压 gzip 文件
      const gunzip = createGunzip()
      fileStream.pipe(gunzip).pipe(proc.stdin)

      // 处理 gunzip 错误
      gunzip.on('error', (err) => {
        fileStream.unpipe(gunzip)
        gunzip.unpipe(proc.stdin!)
        rejectOnce(
          new Error(`解压备份文件失败：${err.message}`),
        )
      })
    } else {
      fileStream.pipe(proc.stdin)
    }

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true

      resolve({
        format: format.format,
        stdout,
        stderr,
        rawStderr: stderr,
        code: code ?? undefined,
      })
    })

    proc.on('error', (err) => {
      rejectOnce(err)
    })
  })
}

/**
 * 将 MariaDB 备份恢复到数据库
 *
 * 命令行等价操作：mariadb -h 127.0.0.1 -P {port} -u root {db} < {file}
 *
 * 使用重试逻辑：如果恢复因 ERROR 1118（行大小过大）失败，
 * 会自动使用启用 DYNAMIC 行格式的兼容性设置重试。
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    containerName,
    port,
    database,
    user: requestedUser = engineDef.superuser,
    password: requestedPassword,
    validateVersion = true,
    binPath,
  } = options

  // 如果请求，验证版本兼容性
  if (validateVersion) {
    try {
      await validateRestoreCompatibility({ dumpPath: backupPath })
    } catch (error) {
      // 重新抛出 SpinDBError，其他错误则记录并继续
      if (error instanceof Error && error.name === 'SpinDBError') {
        throw error
      }
      logDebug('版本验证失败，仍然继续执行', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const mysql = getMysqlClientPath(binPath)
  let savedCreds = null
  if (
    containerName &&
    requestedPassword === undefined &&
    requestedUser === engineDef.superuser
  ) {
    try {
      savedCreds = await loadCredentials(
        containerName,
        Engine.MariaDB,
        getDefaultUsername(Engine.MariaDB),
      )
    } catch (error) {
      logDebug(
        `加载 MariaDB 恢复的已保存凭据失败（${containerName}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      savedCreds = null
    }
  }
  const user = savedCreds?.username || requestedUser
  const password = requestedPassword ?? savedCreds?.password

  // 检测格式并检查是否为错误的引擎
  const format = await detectBackupFormat(backupPath)
  logDebug('检测到的备份格式', { format: format.format })
  assertCompatibleFormat(format)

  // 第一次尝试：不使用兼容性设置
  const result = await doRestore(
    backupPath,
    mysql,
    port,
    database,
    user,
    password,
    format,
    false,
  )

  // 检查恢复是否成功
  if (result.code === 0) {
    return result
  }

  // 检查是否因行大小错误失败（ERROR 1118）
  // 当表的 VARCHAR 列过多导致超出默认行格式限制时会发生
  const isRowSizeError =
    result.rawStderr?.includes('ERROR 1118') ||
    result.rawStderr?.includes('Row size too large')

  if (isRowSizeError) {
    logDebug('检测到行大小错误，正在使用兼容性设置重试')

    // 使用兼容性设置重试
    const retryResult = await doRestore(
      backupPath,
      mysql,
      port,
      database,
      user,
      password,
      format,
      true,
    )

    if (retryResult.code === 0) {
      return {
        ...retryResult,
        stdout:
          retryResult.stdout ||
          '恢复成功（使用了兼容模式，DYNAMIC 行格式）',
      }
    }

    // 仍然失败 - 报告重试错误
    const errorMatch = retryResult.rawStderr?.match(/^ERROR\s+\d+.*$/m)
    const errorMessage = errorMatch
      ? errorMatch[0]
      : retryResult.rawStderr?.trim() || '未知错误'
    throw new Error(`MariaDB 恢复失败：${errorMessage}`)
  }

  // 因其他错误失败 - 报告错误
  const errorMatch = result.rawStderr?.match(/^ERROR\s+\d+.*$/m)
  const errorMessage = errorMatch
    ? errorMatch[0]
    : result.rawStderr?.trim() || '未知错误'
  throw new Error(`MariaDB 恢复失败：${errorMessage}`)
}

/**
 * 解析 MariaDB/MySQL 连接字符串
 *
 * 格式：mysql://user:pass@host:port/database
 *       mariadb://user:pass@host:port/database
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: string
  user: string
  password: string
  database: string
} {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`无效的 MariaDB 连接字符串：${message}`)
  }

  const database = url.pathname.slice(1) // 移除开头的 /
  if (!database) {
    throw new Error(
      '无效的 MariaDB 连接字符串：需要数据库名称（例如 mysql://user:pass@host:port/database）',
    )
  }

  return {
    host: url.hostname,
    port: url.port || '3306',
    user: url.username || 'root',
    password: url.password || '',
    database,
  }
}
