/**
 * MySQL 备份
 *
 * 使用 mysqldump 创建 SQL 格式或压缩格式（.dump = gzip 压缩的 SQL）的数据库备份。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import { configManager } from '../../core/config-manager'
import {
  getWindowsSpawnOptions,
  isWindows,
  platformService,
} from '../../core/platform-service'
import { getEngineDefaults } from '../../config/defaults'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

const engineDef = getEngineDefaults('mysql')

/**
 * 获取特定 MySQL 版本的 mysqldump 路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理二进制文件，
 * 仅在找不到匹配版本时回退到系统 mysqldump。
 *
 * @param containerVersion - 容器的 MySQL 版本（例如 "8" 或 "8.4.3"）
 * @returns 版本匹配的 mysqldump 二进制文件路径
 */
async function getMysqldumpPath(containerVersion: string): Promise<string> {
  // 规范化为完整版本（例如 "8" → "8.4.3"）
  const fullVersion = normalizeVersion(containerVersion)

  // 获取平台信息以构建二进制文件路径
  const platformInfo = platformService.getPlatformInfo()
  const ext = platformInfo.platform === 'win32' ? '.exe' : ''

  // 尝试查找与版本匹配的 SpinDB 管理的 mysqldump
  const versionedBinPath = paths.getBinaryPath({
    engine: 'mysql',
    version: fullVersion,
    platform: platformInfo.platform,
    arch: platformInfo.arch,
  })

  const versionedMysqldump = join(versionedBinPath, 'bin', `mysqldump${ext}`)

  if (existsSync(versionedMysqldump)) {
    return versionedMysqldump
  }

  // 尝试查找该主版本的任何已安装版本
  const majorVersion = containerVersion.split('.')[0]
  const installed = paths.findInstalledBinaryForMajor(
    'mysql',
    majorVersion,
    platformInfo.platform,
    platformInfo.arch,
  )

  if (installed) {
    const installedMysqldump = join(installed.path, 'bin', `mysqldump${ext}`)
    if (existsSync(installedMysqldump)) {
      return installedMysqldump
    }
  }

  // 回退到全局注册的 mysqldump（系统二进制文件）
  const systemMysqldump = await configManager.getBinaryPath('mysqldump')
  if (systemMysqldump) {
    return systemMysqldump
  }

  throw new Error(
    `找不到 MySQL ${containerVersion} 的 mysqldump。` +
      `请使用 'spindb create --engine mysql --version ${majorVersion}' 下载 MySQL 二进制文件，` +
      '或确保已下载 MySQL 二进制文件：\n' +
      '  spindb engines download mysql',
  )
}

/**
 * 创建 MySQL 数据库的备份
 *
 * CLI 等价命令：
 * - SQL 格式：mysqldump -h 127.0.0.1 -P {port} -u root --result-file={outputPath} {database}
 * - 压缩格式：mysqldump -h 127.0.0.1 -P {port} -u root {database} | gzip > {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, version } = container
  const { database, format } = options

  const mysqldump = await getMysqldumpPath(version)
  const savedCreds = await loadCredentials(
    name,
    Engine.MySQL,
    getDefaultUsername(Engine.MySQL),
  )
  const user = savedCreds?.username || engineDef.superuser
  const password = savedCreds?.password

  if (format === 'sql') {
    return createSqlBackup(mysqldump, port, database, outputPath, {
      user,
      password,
    })
  } else {
    return createCompressedBackup(mysqldump, port, database, outputPath, {
      user,
      password,
    })
  }
}

// 创建纯文本 SQL 备份
async function createSqlBackup(
  mysqldump: string,
  port: number,
  database: string,
  outputPath: string,
  auth: { user: string; password?: string },
): Promise<BackupResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const safeResolve = (value: BackupResult) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const safeReject = (err: Error) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    }

    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      auth.user,
      '--set-gtid-purged=OFF', // 允许恢复到不同的 MySQL 实例
      '--result-file',
      outputPath,
      database,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: auth.password
        ? { ...process.env, MYSQL_PWD: auth.password }
        : process.env,
      ...getWindowsSpawnOptions(),
    }

    // Windows 上 shell: true 时，含空格的路径必须用引号括起来
    const command = isWindows() ? `"${mysqldump}"` : mysqldump
    const proc = spawn(command, args, spawnOptions)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      safeReject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          const stats = await stat(outputPath)
          safeResolve({
            path: outputPath,
            format: 'sql',
            size: stats.size,
          })
        } catch (error) {
          safeReject(
            new Error(
              `备份已完成，但读取输出文件失败：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      } else {
        const errorMessage = stderr || `mysqldump 退出，返回码 ${code}`
        safeReject(new Error(errorMessage))
      }
    })
  })
}

/**
 * 创建压缩（gzip）备份
 * 使用 Node.js 的 zlib 进行压缩，而非依赖系统 gzip
 */
async function createCompressedBackup(
  mysqldump: string,
  port: number,
  database: string,
  outputPath: string,
  auth: { user: string; password?: string },
): Promise<BackupResult> {
  const args = [
    '-h',
    '127.0.0.1',
    '-P',
    String(port),
    '-u',
    auth.user,
    '--set-gtid-purged=OFF', // 允许恢复到不同的 MySQL 实例
    database,
  ]

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: auth.password
      ? { ...process.env, MYSQL_PWD: auth.password }
      : process.env,
    ...getWindowsSpawnOptions(),
  }

  // Windows 上 shell: true 时，含空格的路径必须用引号括起来
  const command = isWindows() ? `"${mysqldump}"` : mysqldump
  const proc = spawn(command, args, spawnOptions)

  const gzip = createGzip()
  const output = createWriteStream(outputPath)

  let stderr = ''

  proc.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })

  const pipelinePromise = pipeline(proc.stdout!, gzip, output)

  const exitPromise = new Promise<void>((resolve, reject) => {
    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(err)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const errorMessage = stderr || `mysqldump 退出，返回码 ${code}`
        reject(new Error(errorMessage))
      }
    })
  })

  // 同时等待 pipeline 和进程退出完成
  // 使用 allSettled 处理两者都 reject 的情况（避免未处理的 rejection）
  const results = await Promise.allSettled([pipelinePromise, exitPromise])

  // 检查是否有 reject——优先使用 exitPromise 的错误（信息更丰富）
  const [pipelineResult, exitResult] = results
  if (exitResult.status === 'rejected') {
    throw exitResult.reason
  }
  if (pipelineResult.status === 'rejected') {
    throw pipelineResult.reason
  }

  try {
    const stats = await stat(outputPath)
    return {
      path: outputPath,
      format: 'compressed',
      size: stats.size,
    }
  } catch (error) {
    throw new Error(
      `备份已完成，但读取输出文件失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}