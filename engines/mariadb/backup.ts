/**
 * MariaDB 备份
 *
 * 使用 mariadb-dump 创建 SQL 格式或压缩格式（.dump = gzip 压缩的 SQL）的数据库备份。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import {
  platformService,
} from '../../core/platform-service'
import { getEngineDefaults } from '../../config/defaults'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'
import {
  Platform,
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { buildMariaDbEnv } from './env'

const engineDef = getEngineDefaults('mariadb')

// 从容器的二进制路径中获取 mariadb-dump 或 mysqldump 的路径
async function getDumpPath(container: ContainerConfig): Promise<string> {
  const { platform, arch } = platformService.getPlatformInfo()
  const ext = platform === Platform.Win32 ? '.exe' : ''

  const fullVersion = normalizeVersion(container.version)
  const binPath = paths.getBinaryPath({
    engine: 'mariadb',
    version: fullVersion,
    platform,
    arch,
  })

  // 优先尝试 mariadb-dump，然后尝试 mysqldump
  const mariadbDump = join(binPath, 'bin', `mariadb-dump${ext}`)
  if (existsSync(mariadbDump)) {
    return mariadbDump
  }

  const mysqldump = join(binPath, 'bin', `mysqldump${ext}`)
  if (existsSync(mysqldump)) {
    return mysqldump
  }

  throw new Error(
    'mariadb-dump 或 mysqldump 未在 MariaDB 二进制目录中找到。\n' +
      '请重新下载 MariaDB 二进制文件：spindb engines download mariadb',
  )
}

/**
 * 创建 MariaDB 数据库备份
 *
 * 命令行等价操作：
 * - SQL 格式：mariadb-dump -h 127.0.0.1 -P {port} -u root --result-file={outputPath} {database}
 * - 压缩格式：mariadb-dump -h 127.0.0.1 -P {port} -u root {database} | gzip > {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port } = container
  const { database, format } = options

  const dumpPath = await getDumpPath(container)
  const savedCreds = await loadCredentials(
    name,
    Engine.MariaDB,
    getDefaultUsername(Engine.MariaDB),
  )
  const user = savedCreds?.username || engineDef.superuser
  const password = savedCreds?.password

  if (format === 'sql') {
    return createSqlBackup(dumpPath, port, database, outputPath, {
      user,
      password,
    })
  } else {
    return createCompressedBackup(dumpPath, port, database, outputPath, {
      user,
      password,
    })
  }
}

// 创建纯 SQL 格式备份
async function createSqlBackup(
  dumpPath: string,
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
      '--result-file',
      outputPath,
      database,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildMariaDbEnv(auth.password),
    }

    const proc = spawn(dumpPath, args, spawnOptions)

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
              `备份已完成但无法读取输出文件：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      } else {
        const errorMessage = stderr || `mariadb-dump 以退出码 ${code} 退出`
        safeReject(new Error(errorMessage))
      }
    })
  })
}

// 创建压缩（gzip）格式备份
async function createCompressedBackup(
  dumpPath: string,
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
    database,
  ]

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildMariaDbEnv(auth.password),
  }

  const proc = spawn(dumpPath, args, spawnOptions)

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
        const errorMessage = stderr || `mariadb-dump 以退出码 ${code} 退出`
        reject(new Error(errorMessage))
      }
    })
  })

  const results = await Promise.allSettled([pipelinePromise, exitPromise])

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
      `备份已完成但无法读取输出文件：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
