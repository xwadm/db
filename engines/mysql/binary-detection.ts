/**
 * MySQL 二进制检测（针对系统安装的 MySQL）
 * 检测通过 Homebrew、apt 或其他包管理器安装的 MySQL
 */

import { exec } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { promisify } from 'util'
import { platformService } from '../../core/platform-service'
import { Platform } from '../../types'

const execAsync = promisify(exec)

// 使用平台服务通过名称查找 MySQL 二进制文件
export async function findMysqlBinary(name: string): Promise<string | null> {
  return platformService.findToolPath(name)
}

// 获取 mysqld（MySQL 服务器）的路径
export async function getMysqldPath(): Promise<string | null> {
  return findMysqlBinary('mysqld')
}

// 获取 mysql 客户端的路径
export async function getMysqlClientPath(): Promise<string | null> {
  return findMysqlBinary('mysql')
}

// 获取 mysqladmin 的路径
export async function getMysqladminPath(): Promise<string | null> {
  return findMysqlBinary('mysqladmin')
}

// 获取 mysqldump 的路径
export async function getMysqldumpPath(): Promise<string | null> {
  return findMysqlBinary('mysqldump')
}

// 获取 mysql_install_db（MariaDB 初始化脚本）的路径
export async function getMysqlInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mysql_install_db')
}

// 获取 mariadb-install-db（替代 MariaDB 初始化脚本）的路径
export async function getMariadbInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mariadb-install-db')
}

// 检测已安装的 MySQL 是否实际为 MariaDB
export async function isMariaDB(): Promise<boolean> {
  const mysqld = await getMysqldPath()
  if (!mysqld) return false

  try {
    const { stdout } = await execAsync(`"${mysqld}" --version`)
    return stdout.toLowerCase().includes('mariadb')
  } catch {
    return false
  }
}

// 从 mysqld 二进制文件获取 MySQL 服务器版本
export async function getMysqlVersion(
  mysqldPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${mysqldPath}" --version`)
    // 输出示例：mysqld  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)
    const match = stdout.match(/Ver\s+(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * 从完整版本字符串中提取主版本号
 * 例如 "8.0.35" → "8.0"、"v8.0.35" → "8.0"、"8" → "8"
 */
export function getMajorVersion(fullVersion: string): string {
  if (!fullVersion) return ''

  // 去除空白并去掉前导的 "v" 前缀
  const normalized = fullVersion.trim().replace(/^v/i, '')
  if (!normalized) return ''

  const parts = normalized.split('.')

  // 若仅有一段（例如 "8"），直接返回
  if (parts.length < 2) {
    return parts[0] || ''
  }

  return `${parts[0]}.${parts[1]}`
}

/**
 * 检测所有已安装的 MySQL 版本
 * 返回主版本 → 完整版本字符串的映射
 */
export async function detectInstalledVersions(): Promise<
  Record<string, string>
> {
  const versions: Record<string, string> = {}
  const { platform } = platformService.getPlatformInfo()

  // 检查默认 mysqld
  const defaultMysqld = await getMysqldPath()
  if (defaultMysqld) {
    const version = await getMysqlVersion(defaultMysqld)
    if (version) {
      const major = getMajorVersion(version)
      versions[major] = version
    }
  }

  // 检查版本化的 Homebrew 安装（仅 macOS）
  if (platform === Platform.Darwin) {
    const homebrewPaths = [
      '/opt/homebrew/opt/mysql@5.7/bin/mysqld',
      '/opt/homebrew/opt/mysql@8.0/bin/mysqld',
      '/opt/homebrew/opt/mysql@8.4/bin/mysqld',
      '/usr/local/opt/mysql@5.7/bin/mysqld',
      '/usr/local/opt/mysql@8.0/bin/mysqld',
      '/usr/local/opt/mysql@8.4/bin/mysqld',
    ]

    for (const path of homebrewPaths) {
      if (existsSync(path)) {
        const version = await getMysqlVersion(path)
        if (version) {
          const major = getMajorVersion(version)
          if (!versions[major]) {
            versions[major] = version
          }
        }
      }
    }
  }

  return versions
}

/**
 * 按特定版本划分的 Homebrew MySQL 路径
 * 用于查找特定主版本的二进制文件
 */
const HOMEBREW_MYSQL_VERSION_PATHS: Record<string, string[]> = {
  '9': [
    '/opt/homebrew/opt/mysql@9.0/bin',
    '/opt/homebrew/opt/mysql/bin', // 无版本号的 formula 可能是 v9
    '/usr/local/opt/mysql@9.0/bin',
    '/usr/local/opt/mysql/bin',
  ],
  '8': [
    '/opt/homebrew/opt/mysql@8.0/bin',
    '/opt/homebrew/opt/mysql@8.4/bin',
    '/opt/homebrew/opt/mysql/bin', // 无版本号的 formula 可能是 v8
    '/usr/local/opt/mysql@8.0/bin',
    '/usr/local/opt/mysql@8.4/bin',
    '/usr/local/opt/mysql/bin',
  ],
  '5': ['/opt/homebrew/opt/mysql@5.7/bin', '/usr/local/opt/mysql@5.7/bin'],
}

// 获取特定主版本的 mysqld 路径
export async function getMysqldPathForVersion(
  majorVersion: string,
): Promise<string | null> {
  const { platform } = platformService.getPlatformInfo()

  // macOS 上检查版本特定的 Homebrew 路径
  if (platform === Platform.Darwin) {
    const paths = HOMEBREW_MYSQL_VERSION_PATHS[majorVersion] || []
    for (const dir of paths) {
      const mysqldPath = `${dir}/mysqld`
      if (existsSync(mysqldPath)) {
        // 验证是否是正确的版本
        const version = await getMysqlVersion(mysqldPath)
        if (version) {
          const detectedMajor = getMajorVersion(version).split('.')[0]
          if (detectedMajor === majorVersion) {
            return mysqldPath
          }
        }
      }
    }
  }

  // 回退到通用检测并验证版本
  const genericPath = await getMysqldPath()
  if (genericPath) {
    const version = await getMysqlVersion(genericPath)
    if (version) {
      const detectedMajor = getMajorVersion(version).split('.')[0]
      if (detectedMajor === majorVersion) {
        return genericPath
      }
    }
  }

  return null
}

// 获取 MySQL 安装指南
export function getInstallInstructions(): string {
  const { platform } = platformService.getPlatformInfo()

  if (platform === Platform.Darwin) {
    return (
      '未找到 MySQL 服务器。请安装 MySQL：\n' +
      '  brew install mysql\n' +
      '  # 或安装特定版本：\n' +
      '  brew install mysql@8.0'
    )
  }

  if (platform === Platform.Linux) {
    return (
      '未找到 MySQL 服务器。请安装 MySQL：\n' +
      '  Ubuntu/Debian：sudo apt install mysql-server\n' +
      '  RHEL/CentOS：sudo yum install mysql-server'
    )
  }

  return (
    '未找到 MySQL 服务器。请从以下地址安装 MySQL：\n' +
    '  https://dev.mysql.com/downloads/mysql/'
  )
}

export type MysqlPackageManager =
  | 'homebrew'
  | 'apt'
  | 'yum'
  | 'dnf'
  | 'pacman'
  | 'unknown'

export type MysqlInstallInfo = {
  packageManager: MysqlPackageManager
  packageName: string
  path: string
  uninstallCommand: string
  isMariaDB: boolean
}

// 检测 MySQL 是通过哪个包管理器安装的，并获取卸载信息
export async function getMysqlInstallInfo(
  mysqldPath: string,
): Promise<MysqlInstallInfo> {
  const { platform } = platformService.getPlatformInfo()
  const mariadb = await isMariaDB()

  // 解析符号链接以获取实际路径
  // 例如 /opt/homebrew/bin/mysqld → /opt/homebrew/Cellar/mysql/9.5.0/bin/mysqld
  let resolvedPath = mysqldPath
  try {
    resolvedPath = realpathSync(mysqldPath)
  } catch {
    // 符号链接解析失败则使用原始路径
  }

  // macOS：检查路径是否在 Homebrew 目录中
  if (platform === Platform.Darwin) {
    if (
      mysqldPath.includes('/opt/homebrew/') ||
      mysqldPath.includes('/usr/local/Cellar/') ||
      resolvedPath.includes('/opt/homebrew/') ||
      resolvedPath.includes('/usr/local/Cellar/')
    ) {
      // 从解析后的路径中提取包名
      // 例如 /opt/homebrew/Cellar/mysql/9.5.0/bin/mysqld → mysql
      // 例如 /opt/homebrew/Cellar/mysql@8.0/8.0.35/bin/mysqld → mysql@8.0
      // 例如 /opt/homebrew/opt/mysql@8.0/bin/mysqld → mysql@8.0
      let packageName = mariadb ? 'mariadb' : 'mysql'

      // 优先尝试从 Cellar 路径提取（符号链接解析后最可靠）
      // 格式：/opt/homebrew/Cellar/<formula>/<version>/bin/mysqld
      const cellarMatch = resolvedPath.match(
        /\/(?:opt\/homebrew|usr\/local)\/Cellar\/([^/]+)\//,
      )
      if (cellarMatch) {
        packageName = cellarMatch[1]
      } else {
        // 回退到 opt 路径模式
        // 格式：/opt/homebrew/opt/<formula>/bin/mysqld
        const optMatch = resolvedPath.match(
          /\/(?:opt\/homebrew|usr\/local)\/opt\/([^/]+)\//,
        )
        if (optMatch) {
          packageName = optMatch[1]
        }
      }

      return {
        packageManager: 'homebrew',
        packageName,
        path: mysqldPath,
        uninstallCommand: `brew uninstall ${packageName}`,
        isMariaDB: mariadb,
      }
    }
  }

  // Linux：使用缓存的辅助函数检测包管理器
  if (platform === Platform.Linux) {
    const pm = await getLinuxPackageManager()
    if (pm) {
      const packageName = mariadb ? pm.mariadbPackage : pm.mysqlPackage
      return {
        packageManager: pm.name,
        packageName,
        path: mysqldPath,
        uninstallCommand: pm.uninstallCmd(packageName),
        isMariaDB: mariadb,
      }
    }
  }

  // 未知包管理器
  return {
    packageManager: 'unknown',
    packageName: mariadb ? 'mariadb' : 'mysql',
    path: mysqldPath,
    uninstallCommand: '请使用系统包管理器卸载',
    isMariaDB: mariadb,
  }
}

/**
 * Linux 包管理器配置
 * 按优先级排序：最常用的排在最前，以便更快检测
 */
type LinuxPackageManagerConfig = {
  name: MysqlPackageManager
  command: string
  mysqlPackage: string
  mariadbPackage: string
  uninstallCmd: (pkg: string) => string
}

const LINUX_PACKAGE_MANAGERS: LinuxPackageManagerConfig[] = [
  {
    name: 'apt',
    command: 'apt',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo apt remove ${pkg}`,
  },
  {
    name: 'dnf',
    command: 'dnf',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo dnf remove ${pkg}`,
  },
  {
    name: 'yum',
    command: 'yum',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo yum remove ${pkg}`,
  },
  {
    name: 'pacman',
    command: 'pacman',
    mysqlPackage: 'mysql',
    mariadbPackage: 'mariadb',
    uninstallCmd: (pkg) => `sudo pacman -Rs ${pkg}`,
  },
]

// 缓存的 Linux 包管理器检测结果
let cachedLinuxPackageManager: LinuxPackageManagerConfig | null | undefined

/**
 * 检测 Linux 包管理器（带缓存）
 * 从优先级列表中返回第一个可用的包管理器
 */
async function getLinuxPackageManager(): Promise<LinuxPackageManagerConfig | null> {
  // 返回缓存结果（undefined 表示尚未检查）
  if (cachedLinuxPackageManager !== undefined) {
    return cachedLinuxPackageManager
  }

  for (const pm of LINUX_PACKAGE_MANAGERS) {
    try {
      const { stdout } = await execAsync(`which ${pm.command} 2>/dev/null`)
      if (stdout.trim()) {
        cachedLinuxPackageManager = pm
        return pm
      }
    } catch {
      // 未找到该包管理器，尝试下一个
    }
  }

  cachedLinuxPackageManager = null
  return null
}

/**
 * 清除缓存的包管理器检测结果（用于测试）
 */
export function clearPackageManagerCache(): void {
  cachedLinuxPackageManager = undefined
}