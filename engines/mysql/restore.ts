/**
 * MySQL/MariaDB 备份检测与恢复
 *
 * 处理备份格式检测和 MySQL 转储恢复。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { createGunzip } from 'zlib'
import { validateRestoreCompatibility } from './version-validator'
import { getEngineDefaults } from '../../config/defaults'
import { configManager } from '../../core/config-manager'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'
import { logDebug, SpinDBError, ErrorCodes } from '../../core/error-handler'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

const engineDef = getEngineDefaults('mysql')

// =============================================================================
// 备份格式检测
// =============================================================================

/**
 * 检测 MySQL 备份文件的格式
 *
 * MySQL 主要使用 SQL 转储（与 PostgreSQL 多种格式不同）。
 * 我们检测：
 * - MySQL SQL 转储（mysqldump 输出）
 * - MariaDB SQL 转储
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

  // 检查 PostgreSQL 自定义格式（PGDMP 魔术字节）
  if (buffer.toString('ascii', 0, 5) === 'PGDMP') {
    return {
      format: 'postgresql_custom',
      description: 'PostgreSQL 自定义格式转储（与 MySQL 不兼容）',
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
      description: 'PostgreSQL SQL 转储（与 MySQL 不兼容）',
      restoreCommand: 'psql',
    }
  }

  // 检查 gzip 压缩
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip 压缩的 SQL 转储',
      restoreCommand: 'mysql',
    }
  }

  // 检查 MySQL 转储标记
  if (header.includes('-- MySQL dump')) {
    return {
      format: 'sql',
      description: 'MySQL SQL 转储（mysqldump）',
      restoreCommand: 'mysql',
    }
  }

  // 检查 MariaDB 转储标记
  if (header.includes('-- MariaDB dump')) {
    return {
      format: 'sql',
      description: 'MariaDB SQL 转储（mysqldump）',
      restoreCommand: 'mysql',
    }
  }

  // 检查是否像 SQL（以常见 SQL 语句开头）
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
      restoreCommand: 'mysql',
    }
  }

  // 默认作为 SQL 格式处理
  return {
    format: 'unknown',
    description: '未知格式 - 将尝试按 SQL 处理',
    restoreCommand: 'mysql',
  }
}

// 检查备份文件是否来自错误的引擎，并抛出有用的错误提示
export function assertCompatibleFormat(format: BackupFormat): void {
  if (
    format.format === 'postgresql_custom' ||
    format.format === 'postgresql_sql'
  ) {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `这似乎是 PostgreSQL 转储文件，但您正尝试将其恢复到 MySQL。`,
      'fatal',
      `请创建 PostgreSQL 容器：\n  spindb create mydb --engine postgresql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'mysql',
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
  binPath?: string // MySQL 二进制文件目录的可选路径
  containerVersion?: string // 容器的 MySQL 版本，用于版本匹配查找
}

// =============================================================================
// 恢复函数
// =============================================================================

/**
 * 获取特定 MySQL 版本的 mysql 客户端路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理二进制文件，
 * 仅在找不到匹配版本时回退到系统 mysql。
 *
 * 查找顺序：
 * 1. binPath/bin/mysql（若显式提供）
 * 2. 与容器版本匹配的 SpinDB 管理的 mysql
 * 3. 与主版本匹配的 SpinDB 管理的 mysql
 * 4. 配置管理器缓存的路径
 * 5. 系统 PATH
 *
 * @param binPath - 可选的显式 MySQL 二进制目录路径
 * @param containerVersion - 容器的 MySQL 版本，用于版本匹配查找
 */
async function getMysqlClientPath(
  binPath?: string,
  containerVersion?: string,
): Promise<string> {
  const ext = platformService.getExecutableExtension()

  // 首先检查 binPath 是否提供且包含 mysql 客户端
  // hostdb 将 MySQL 二进制文件打包在 bin/ 子目录中
  if (binPath) {
    const mysqlPath = join(binPath, 'bin', `mysql${ext}`)
    if (existsSync(mysqlPath)) {
      return mysqlPath
    }
  }

  // 若提供了 containerVersion，尝试版本匹配的 SpinDB 二进制文件
  if (containerVersion) {
    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()

    // 尝试精确版本匹配
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mysql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMysql = join(versionedBinPath, 'bin', `mysql${ext}`)
    if (existsSync(versionedMysql)) {
      return versionedMysql
    }

    // 尝试主版本匹配
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mysql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMysql = join(installed.path, 'bin', `mysql${ext}`)
      if (existsSync(installedMysql)) {
        return installedMysql
      }
    }
  }

  // 回退到配置管理器（验证文件存在）
  const configPath = await configManager.getBinaryPath('mysql')
  if (configPath && existsSync(configPath)) {
    return configPath
  }

  // 回退到系统 PATH
  const systemPath = await platformService.findToolPath('mysql')
  if (systemPath) {
    return systemPath
  }

  throw new Error(
    '未找到 mysql 客户端。请确保已下载 MySQL 二进制文件：\n' +
      '  spindb engines download mysql',
  )
}

// 兼容性 SQL——处理大行大小和其他边缘情况
// - innodb_default_row_format=DYNAMIC：将长列存储在页外，避免行大小限制
// - innodb_strict_mode=OFF：允许在严格模式下可能超过行大小限制的表
// - foreign_key_checks=0：在所有表创建完成前推迟外键检查
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
 * 内部恢复函数，可选兼容模式
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
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: password ? { ...process.env, MYSQL_PWD: password } : process.env,
  }

  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-P', String(port), '-u', user, database]

    logDebug('正在使用 mysql 恢复备份', {
      mysql,
      args,
      withCompatSettings,
    })

    const proc = spawn(mysql, args, spawnOptions)

    // 跟踪 promise 是否已确定，避免重复 reject
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
          'MySQL 进程 stdin 不可用，无法恢复备份',
        ),
      )
      return
    }

    // 处理 stdin 上的 EPIPE 错误——当 mysql 因 SQL 错误提前退出
    // 而我们仍在传输数据时发生。实际错误将在 stderr 中体现。
    proc.stdin.on('error', (err) => {
      // EPIPE 在进程提前退出时是预期行为——不要在此 reject，
      // 让 'close' 事件用 stderr 中的实际错误处理
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        rejectOnce(
          new Error(`写入 MySQL 进程失败：${err.message}`),
        )
      }
    })

    // 若需要，在数据前添加兼容性设置
    if (withCompatSettings) {
      proc.stdin.write(COMPAT_INIT_SQL)
      logDebug('已在恢复数据前添加兼容性设置')
    }

    if (format.format === 'compressed') {
      // 先解压 gzip 文件再传输到 mysql
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
 * 将 MySQL 备份恢复到数据库
 *
 * CLI 等价命令：mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
 *
 * 使用重试逻辑：若恢复失败并报 ERROR 1118（行大小过大），
 * 自动以启用 DYNAMIC 行格式的兼容设置重试。
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
    containerVersion,
  } = options

  // 若需要则验证版本兼容性
  if (validateVersion) {
    try {
      await validateRestoreCompatibility({ dumpPath: backupPath })
    } catch (error) {
      // 重新抛出 SpinDBError，其他错误记录后继续
      if (error instanceof Error && error.name === 'SpinDBError') {
        throw error
      }
      logDebug('版本验证失败，仍将继续', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const mysql = await getMysqlClientPath(binPath, containerVersion)
  const savedCreds =
    containerName &&
    requestedPassword === undefined &&
    requestedUser === engineDef.superuser
      ? await loadCredentials(
          containerName,
          Engine.MySQL,
          getDefaultUsername(Engine.MySQL),
        )
      : null
  const user = savedCreds?.username || requestedUser
  const password = requestedPassword ?? savedCreds?.password

  // 检测格式并检查是否来自错误的引擎
  const format = await detectBackupFormat(backupPath)
  logDebug('检测到备份格式', { format: format.format })
  assertCompatibleFormat(format)

  // 第一次尝试：不使用兼容设置
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

  // 检查是否因行大小错误（ERROR 1118）失败
  // 当表的 VARCHAR 列过多超出默认行格式限制时发生
  const isRowSizeError =
    result.rawStderr?.includes('ERROR 1118') ||
    result.rawStderr?.includes('Row size too large')

  if (isRowSizeError) {
    logDebug('检测到行大小错误，正在以兼容设置重试')

    // 以兼容设置重试
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
          '已使用兼容模式（DYNAMIC 行格式）成功恢复',
      }
    }

    // 仍然失败——报告重试错误
    const errorMatch = retryResult.rawStderr?.match(/^ERROR\s+\d+.*$/m)
    const errorMessage = errorMatch
      ? errorMatch[0]
      : retryResult.rawStderr?.trim() || '未知错误'
    throw new Error(`MySQL 恢复失败：${errorMessage}`)
  }

  // 因其他错误失败——报告
  const errorMatch = result.rawStderr?.match(/^ERROR\s+\d+.*$/m)
  const errorMessage = errorMatch
    ? errorMatch[0]
    : result.rawStderr?.trim() || '未知错误'
  throw new Error(`MySQL 恢复失败：${errorMessage}`)
}

/**
 * 解析 MySQL 连接字符串
 *
 * 格式：mysql://user:pass@host:port/database
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: string
  user: string
  password: string
  database: string
} {
  const url = new URL(connectionString)
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: url.username || 'root',
    password: url.password || '',
    database: url.pathname.slice(1), // 去掉前导 /
  }
}