/**
 * PostgreSQL 备份
 *
 * 使用 pg_dump 创建 SQL 格式或自定义格式（.dump）的数据库备份。
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import {
  getWindowsSpawnOptions,
  platformService,
} from '../../core/platform-service'
import { defaults } from '../../config/defaults'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

/**
 * 获取指定 PostgreSQL 版本的 pg_dump 路径。
 *
 * 优先使用与容器版本匹配的 SpinDB 管理的二进制文件，
 * 仅在未找到匹配版本时才回退到系统 pg_dump。
 *
 * @param containerVersion - 容器的 PostgreSQL 版本（例如 "18" 或 "18.1.0"）
 * @returns 版本匹配的 pg_dump 二进制文件路径
 */
async function getPgDumpPath(containerVersion: string): Promise<string> {
  // 规范化为完整版本（例如 "18" -> "18.1.0"）
  const fullVersion = normalizeVersion(containerVersion)

  // 获取平台信息用于构建二进制文件路径
  const platformInfo = platformService.getPlatformInfo()
  const ext = platformInfo.platform === 'win32' ? '.exe' : ''

  // 尝试查找 SpinDB 管理的匹配版本的 pg_dump
  const versionedBinPath = paths.getBinaryPath({
    engine: 'postgresql',
    version: fullVersion,
    platform: platformInfo.platform,
    arch: platformInfo.arch,
  })

  const versionedPgDump = join(versionedBinPath, 'bin', `pg_dump${ext}`)

  if (existsSync(versionedPgDump)) {
    return versionedPgDump
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
    const installedPgDump = join(installed.path, 'bin', `pg_dump${ext}`)
    if (existsSync(installedPgDump)) {
      return installedPgDump
    }
  }

  // 回退到全局注册的 pg_dump（系统二进制文件）
  const systemPgDump = await configManager.getBinaryPath('pg_dump')
  if (systemPgDump) {
    return systemPgDump
  }

  throw new Error(
    `未找到 PostgreSQL ${containerVersion} 对应的 pg_dump。` +
      `请下载匹配的二进制文件：spindb engines download postgresql ${majorVersion}`,
  )
}

/**
 * 创建 PostgreSQL 数据库备份
 *
 * 等效 CLI 命令：
 * - SQL 格式：pg_dump -Fp -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 * - 自定义格式：pg_dump -Fc -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, version } = container
  const { database, format } = options

  const pgDumpPath = await getPgDumpPath(version)
  const savedCreds = await loadCredentials(
    name,
    Engine.PostgreSQL,
    getDefaultUsername(Engine.PostgreSQL),
  )
  const user = savedCreds?.username || defaults.superuser

  // -Fp = 纯 SQL 格式，-Fc = 自定义格式
  const formatFlag = format === 'sql' ? '-Fp' : '-Fc'

  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      database,
      formatFlag,
      '-f',
      outputPath,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: savedCreds?.password
        ? { ...process.env, PGPASSWORD: savedCreds.password }
        : process.env,
      ...getWindowsSpawnOptions(),
    }

    const proc = spawn(pgDumpPath, args, spawnOptions)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        // 获取文件大小
        const stats = await stat(outputPath)
        resolve({
          path: outputPath,
          format: format === 'sql' ? 'sql' : 'custom',
          size: stats.size,
        })
      } else {
        const errorMessage = stderr || `pg_dump 以退出码 ${code} 退出`
        reject(new Error(errorMessage))
      }
    })
  })
}
