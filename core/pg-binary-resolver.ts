/**
 * PostgreSQL 二进制解析器
 *
 * 为请求的主版本解析正确的 pg_dump / pg_restore / psql / pg_basebackup 二进制文件。
 * SpinDB 拥有所有自己的数据库二进制文件：它们由 hostdb 下载并存储在
 * ~/.spindb/bin/postgresql-<version>-<platform>-<arch>/bin/ 下。
 *
 * 我们不查看系统安装的 PostgreSQL（Homebrew、APT、YUM 等）。
 * 如果没有匹配的捆绑二进制文件，正确的修复方法是
 * 运行 `spindb engines download postgresql <major>`，而不是通过
 * 系统包管理器安装单独的副本。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../config/paths'
import { platformService } from './platform-service'

export type PostgresClientTool =
  | 'pg_dump'
  | 'pg_restore'
  | 'psql'
  | 'pg_basebackup'

export type InstalledPostgresVersion = {
  majorVersion: string // 例如 "14"、"17"
  fullVersion: string // 例如 "17.7.0"、"18.1.0"
  binPath: string // 例如 ~/.spindb/bin/postgresql-18.1.0-darwin-arm64/bin
}

/**
 * 解析 SpinDB 捆绑二进制缓存中 PostgreSQL 工具的路径。
 *
 * 返回请求主版本的最新已安装补丁版本，
 * 如果没有匹配的捆绑二进制文件则返回 null。
 */
export function getBundledBinaryPath(
  tool: PostgresClientTool,
  majorVersion: string,
): string | null {
  const { platform, arch } = platformService.getPlatformInfo()
  const ext = platformService.getExecutableExtension()
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  const majorPrefix = `${majorVersion}.`

  for (const entry of installed) {
    // 匹配相同主版本的安装（version === "18" 或以 "18." 开头）
    if (entry.version !== majorVersion && !entry.version.startsWith(majorPrefix)) {
      continue
    }

    const toolPath = join(entry.path, 'bin', `${tool}${ext}`)
    if (existsSync(toolPath)) return toolPath
  }

  return null
}

/**
 * 扫描 SpinDB 的捆绑二进制缓存中所有已安装的 PostgreSQL 版本。
 * 返回的条目按最新版本排在最前排序（通过 paths.findInstalledBinaries）。
 */
export function detectInstalledPostgres(): InstalledPostgresVersion[] {
  const { platform, arch } = platformService.getPlatformInfo()
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  const ext = platformService.getExecutableExtension()
  const bundled: InstalledPostgresVersion[] = []

  for (const entry of installed) {
    const binDir = join(entry.path, 'bin')
    if (!existsSync(join(binDir, `pg_dump${ext}`))) continue

    const majorVersion = entry.version.split('.')[0]
    if (!majorVersion) continue

    bundled.push({
      majorVersion,
      fullVersion: entry.version,
      binPath: binDir,
    })
  }

  return bundled
}

/**
 * 查找已安装的最低兼容捆绑版本，该版本可以读取来自
 * 目标主版本的服务器数据（即 version >= targetMajor）。
 *
 * 如果没有兼容的捆绑二进制文件可用则返回 null。
 */
export function findCompatibleVersion(
  targetMajor: number,
): InstalledPostgresVersion | null {
  const installed = detectInstalledPostgres()
  const compatible = installed.filter(
    (v) => parseInt(v.majorVersion, 10) >= targetMajor,
  )

  if (compatible.length === 0) {
    return null
  }

  // 优先选择最低的兼容主版本（最接近远程服务器版本）
  compatible.sort(
    (a, b) => parseInt(a.majorVersion, 10) - parseInt(b.majorVersion, 10),
  )
  return compatible[0]
}

/**
 * 获取特定 PostgreSQL 主版本的版本化工具路径。
 * 对于捆绑安装中不存在的工具返回 null。
 */
export function getVersionedToolPaths(majorVersion: string): {
  pgDump: string | null
  pgRestore: string | null
  psql: string | null
  pgBasebackup: string | null
} {
  return {
    pgDump: getBundledBinaryPath('pg_dump', majorVersion),
    pgRestore: getBundledBinaryPath('pg_restore', majorVersion),
    psql: getBundledBinaryPath('psql', majorVersion),
    pgBasebackup: getBundledBinaryPath('pg_basebackup', majorVersion),
  }
}
