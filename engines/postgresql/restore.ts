import { open } from 'fs/promises'
import { existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { findBinary } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { validateRestoreCompatibility } from './version-validator'
import { normalizeVersion } from './version-maps'
import { SpinDBError, ErrorCodes } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

const execAsync = promisify(exec)

/**
 * 检测 PostgreSQL 备份文件的格式
 *
 * 同时检测 MySQL/MariaDB 转储文件以提供有用的错误提示。
 * 仅读取格式检测所需的 263 字节。
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // 仅读取格式检测所需的字节（最多到偏移量 262 用于 tar 魔术字节）
  const HEADER_SIZE = 263
  const buffer = Buffer.alloc(HEADER_SIZE)

  const fd = await open(filePath, 'r')
  let bytesRead: number
  try {
    const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
    bytesRead = result.bytesRead
  } finally {
    await fd.close()
  }

  const header = buffer.toString('utf8', 0, Math.min(128, bytesRead))

  // 检查 MySQL/MariaDB 转储标记（在 PostgreSQL 检查之前）
  if (header.includes('-- MySQL dump') || header.includes('-- MariaDB dump')) {
    return {
      format: 'mysql_sql',
      description: 'MySQL/MariaDB SQL 转储（与 PostgreSQL 不兼容）',
      restoreCommand: 'mysql',
    }
  }

  // 检查 PostgreSQL 自定义格式的魔术字节
  // 自定义格式以 "PGDMP" 开头
  if (buffer.toString('ascii', 0, 5) === 'PGDMP') {
    return {
      format: 'custom',
      description: 'PostgreSQL 自定义格式（pg_dump -Fc）',
      restoreCommand: 'pg_restore',
    }
  }

  // 检查 tar 格式（目录转储通常为 tar 格式）
  // tar 文件在偏移量 257 处有 "ustar"
  if (bytesRead > 262) {
    const tarMagic = buffer.toString('ascii', 257, 262)
    if (tarMagic === 'ustar') {
      return {
        format: 'tar',
        description: 'PostgreSQL tar 格式（pg_dump -Ft）',
        restoreCommand: 'pg_restore',
      }
    }
  }

  // 检查 gzip 压缩
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip 压缩（可能是 SQL 或自定义格式）',
      restoreCommand: 'auto',
    }
  }

  // 检查是否为 SQL 格式（以常见 SQL 语句开头）
  const textStart = buffer.toString('utf8', 0, 16).toLowerCase()
  if (
    textStart.startsWith('--') ||
    textStart.startsWith('/*') ||
    textStart.startsWith('set ') ||
    textStart.startsWith('create') ||
    textStart.startsWith('drop') ||
    textStart.startsWith('begin') ||
    textStart.startsWith('pg_dump')
  ) {
    return {
      format: 'sql',
      description: '纯 SQL 格式（pg_dump -Fp）',
      restoreCommand: 'psql',
    }
  }

  // 默认尝试自定义格式
  return {
    format: 'unknown',
    description: '未知格式 - 将尝试自定义格式恢复',
    restoreCommand: 'pg_restore',
  }
}

// 检查备份文件是否来自错误的引擎，如果是则抛出有用的错误
export function assertCompatibleFormat(format: BackupFormat): void {
  if (format.format === 'mysql_sql') {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `这似乎是一个 MySQL/MariaDB 转储文件，但你正尝试将其恢复到 PostgreSQL。`,
      'fatal',
      `请创建一个 MySQL 容器：\n  spindb create mydb --engine mysql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'postgresql',
        detectedEngine: 'mysql',
      },
    )
  }
}

export type RestoreOptions = {
  port: number
  database: string
  user?: string
  password?: string
  format?: string
  pgRestorePath?: string
  containerVersion?: string
}

/**
 * 获取指定 PostgreSQL 版本的 psql 路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理的二进制文件，
 * 仅在未找到匹配版本时才回退到系统 psql。
 *
 * @param containerVersion - 容器的 PostgreSQL 版本（例如 "18" 或 "18.1.0"）
 * @returns 版本匹配的 psql 二进制文件路径
 */
async function getPsqlPath(containerVersion?: string): Promise<string> {
  if (containerVersion) {
    // 规范化为完整版本（例如 "18" -> "18.1.0"）
    const fullVersion = normalizeVersion(containerVersion)

    // 获取平台信息用于构建二进制文件路径
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // 尝试查找 SpinDB 管理的匹配版本的 psql
    const versionedBinPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedPsql = join(versionedBinPath, 'bin', `psql${ext}`)

    if (existsSync(versionedPsql)) {
      return versionedPsql
    }

    // 尝试查找该主版本下已安装的任意版本
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedPsql = join(installed.path, 'bin', `psql${ext}`)
      if (existsSync(installedPsql)) {
        return installedPsql
      }
    }
  }

  // 回退到全局注册的 psql（系统二进制文件）
  const systemPsql = await configManager.getBinaryPath('psql')
  if (systemPsql) {
    return systemPsql
  }

  throw new Error(
    '未找到 psql。请下载 PostgreSQL 二进制文件：\n' +
      '  spindb engines download postgresql',
  )
}

/**
 * 获取指定 PostgreSQL 版本的 pg_restore 路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理的二进制文件，
 * 仅在未找到匹配版本时才回退到系统 pg_restore。
 *
 * @param containerVersion - 容器的 PostgreSQL 版本（例如 "18" 或 "18.1.0"）
 * @returns 版本匹配的 pg_restore 二进制文件路径
 */
async function getPgRestorePath(containerVersion?: string): Promise<string> {
  if (containerVersion) {
    // 规范化为完整版本（例如 "18" -> "18.1.0"）
    const fullVersion = normalizeVersion(containerVersion)

    // 获取平台信息用于构建二进制文件路径
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // 尝试查找 SpinDB 管理的匹配版本的 pg_restore
    const versionedBinPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedPgRestore = join(versionedBinPath, 'bin', `pg_restore${ext}`)

    if (existsSync(versionedPgRestore)) {
      return versionedPgRestore
    }

    // 尝试查找该主版本下已安装的任意版本
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedPgRestore = join(installed.path, 'bin', `pg_restore${ext}`)
      if (existsSync(installedPgRestore)) {
        return installedPgRestore
      }
    }
  }

  // 回退到全局注册的 pg_restore（系统二进制文件）
  const configPath = await configManager.getBinaryPath('pg_restore')
  if (configPath) {
    return configPath
  }

  // 回退到在系统 PATH 中查找
  const result = await findBinary('pg_restore')
  if (!result) {
    throw new Error(
      '未找到 pg_restore。请下载 PostgreSQL 二进制文件：\n' +
        '  spindb engines download postgresql\n\n' +
        '或手动配置：spindb config set pg_restore /path/to/pg_restore',
    )
  }
  return result.path
}

// 将备份恢复到 PostgreSQL 数据库
export async function restoreBackup(
  _binPath: string, // 未使用 - 使用配置管理器代替
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    port,
    database,
    user = 'postgres',
    password,
    format,
    pgRestorePath,
    containerVersion,
  } = options
  const execOptions = {
    maxBuffer: 50 * 1024 * 1024,
    env: password ? { ...process.env, PGPASSWORD: password } : process.env,
  }

  // 检测格式并检查是否为错误的引擎
  const detectedBackupFormat = await detectBackupFormat(backupPath)
  assertCompatibleFormat(detectedBackupFormat)

  const detectedFormat = format || detectedBackupFormat.format

  // 对于 pg_restore 格式，验证版本兼容性
  if (detectedFormat !== 'sql') {
    const restorePath =
      pgRestorePath || (await getPgRestorePath(containerVersion))

    // 如果版本不兼容将抛出 SpinDBError
    await validateRestoreCompatibility({
      dumpPath: backupPath,
      format: detectedFormat,
      pgRestorePath: restorePath,
    })
  }

  if (detectedFormat === 'sql') {
    const psqlPath = await getPsqlPath(containerVersion)

    const result = await execAsync(
      `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${database} -f "${backupPath}"`,
      execOptions,
    )

    return {
      format: 'sql',
      ...result,
    }
  } else {
    // 如果提供了自定义路径则使用，否则查找版本匹配的二进制文件
    const restorePath =
      pgRestorePath || (await getPgRestorePath(containerVersion))

    try {
      const formatFlag =
        detectedFormat === 'custom'
          ? '-Fc'
          : detectedFormat === 'tar'
            ? '-Ft'
            : ''
      const result = await execAsync(
        `"${restorePath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${database} --no-owner --no-privileges ${formatFlag} "${backupPath}"`,
        execOptions,
      )

      return {
        format: detectedFormat,
        ...result,
      }
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string }
      // pg_restore 即使在部分成功时也经常返回非零退出码
      return {
        format: detectedFormat,
        stdout: e.stdout || '',
        stderr: e.stderr || e.message,
        code: 1,
      }
    }
  }
}
