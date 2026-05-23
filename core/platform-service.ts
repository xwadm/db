/**
 * 平台服务
 *
 * 集中管理所有操作系统特定的检测和行为，类似于引擎抽象层处理数据库特定行为的方式。
 *
 * 此设计支持：
 * - 在整个代码库中统一平台检测
 * - 方便单元测试中的模拟
 * - 简单添加新平台（例如 Windows）
 */

import { homedir, platform as osPlatform, arch as osArch } from 'os'
import { execSync, execFileSync, exec, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { Platform, Arch } from '../types'

const execAsync = promisify(exec)

export { Platform, Arch }

/**
 * 验证并将系统架构规范化为支持的 Arch 枚举值。
 * 对于不支持的架构抛出错误，而不是进行不安全的类型转换。
 */
function validateArch(arch: string): Arch {
  switch (arch) {
    case 'arm64':
      return Arch.ARM64
    case 'x64':
      return Arch.X64
    default:
      throw new Error(
        `不支持的架构: ${arch}。SpinDB 仅支持 arm64 和 x64 架构。`,
      )
  }
}

// sudo 环境下解析主目录的选项
export type ResolveHomeDirOptions = {
  sudoUser: string | null
  getentResult: string | null
  platform: Platform.Darwin | Platform.Linux
  defaultHome: string
}

/**
 * 解析正确的主目录，处理 sudo 场景。
 * 提取为纯函数以便于测试。
 *
 * 在 sudo 下运行时，需要使用原始用户的主目录，
 * 而不是 root 的主目录。这可以防止 ~/.spindb 被创建在 /root/ 下。
 */
export function resolveHomeDir(options: ResolveHomeDirOptions): string {
  const { sudoUser, getentResult, platform, defaultHome } = options

  // 未在 sudo 下运行 - 使用默认值
  if (!sudoUser) {
    return defaultHome
  }

  // 尝试从 getent passwd 输出中解析主目录
  // 格式: username:password:uid:gid:gecos:home:shell
  if (getentResult) {
    const parts = getentResult.trim().split(':')
    if (parts.length >= 6 && parts[5]) {
      return parts[5]
    }
  }

  // 回退到平台特定的默认路径
  return platform === Platform.Darwin
    ? `/Users/${sudoUser}`
    : `/home/${sudoUser}`
}

export type PlatformInfo = {
  platform: Platform
  arch: Arch
  homeDir: string
  isWSL: boolean
  isSudo: boolean
  sudoUser: string | null
}

export type ClipboardConfig = {
  copyCommand: string
  copyArgs: string[]
  pasteCommand: string
  pasteArgs: string[]
  available: boolean
}

export type WhichCommandConfig = {
  command: string
  args: string[]
}

export type PackageManagerInfo = {
  id: string
  name: string
  checkCommand: string
  installTemplate: string
  updateCommand: string
}

export abstract class BasePlatformService {
  protected cachedPlatformInfo: PlatformInfo | null = null

  // 获取平台信息
  abstract getPlatformInfo(): PlatformInfo

  // 获取当前平台的剪贴板配置
  abstract getClipboardConfig(): ClipboardConfig

  // 获取当前平台的 "which" 命令等效配置
  abstract getWhichCommand(): WhichCommandConfig

  // 获取当前平台下工具的常见搜索路径
  abstract getSearchPaths(tool: string): string[]

  // 检测可用的包管理器
  abstract detectPackageManager(): Promise<PackageManagerInfo | null>

  // 获取当前平台的空设备路径（Unix 上为 '/dev/null'，Windows 上为 'NUL'）
  abstract getNullDevice(): string

  // 获取当前平台的可执行文件扩展名（Unix 上为 ''，Windows 上为 '.exe'）
  abstract getExecutableExtension(): string

  /**
   * 通过 PID 终止进程
   * @param pid - 要终止的进程 ID
   * @param force - 如果为 true，则强制终止（Unix 上为 SIGKILL，Windows 上为 /F）
   */
  abstract terminateProcess(pid: number, force: boolean): Promise<void>

  // 通过 PID 检查进程是否正在运行
  abstract isProcessRunning(pid: number): boolean

  /**
   * 查找监听特定端口的进程 PID
   * @param port - 要检查的端口号
   * @returns 监听该端口的 PID 数组（未找到则为空数组）
   */
  abstract findProcessByPort(port: number): Promise<number[]>

  // 复制文本到剪贴板
  async copyToClipboard(text: string): Promise<boolean> {
    const config = this.getClipboardConfig()
    if (!config.available) return false

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(config.copyCommand, config.copyArgs, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })
        proc.stdin?.write(text)
        proc.stdin?.end()
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`剪贴板命令以退出码 ${code} 结束`))
        })
        proc.on('error', reject)
      })
      return true
    } catch {
      return false
    }
  }

  // 检查工具是否已安装并返回其路径
  async findToolPath(toolName: string): Promise<string | null> {
    const whichConfig = this.getWhichCommand()

    // 首先尝试 which/where 命令（设置超时以防止挂起）
    try {
      const cmd = [whichConfig.command, ...whichConfig.args, toolName]
        .filter(Boolean)
        .join(' ')
      const { stdout } = await execAsync(cmd, { timeout: 5000 })
      const path = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (path && existsSync(path)) return path
    } catch {
      // 通过 which 未找到，继续搜索路径
    }

    // 搜索常见安装路径
    const searchPaths = this.getSearchPaths(toolName)
    for (const dir of searchPaths) {
      const fullPath = this.buildToolPath(dir, toolName)
      if (existsSync(fullPath)) {
        return fullPath
      }
    }

    return null
  }

  // 构建工具在目录中的完整路径
  protected abstract buildToolPath(dir: string, toolName: string): string

  // 通过运行 --version 获取工具版本
  async getToolVersion(toolPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${toolPath}" --version`, {
        timeout: 5000,
      })
      const match = stdout.match(/(\d+\.\d+(\.\d+)?)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }
}

class DarwinPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null

    // 尝试通过 getent passwd 获取主目录（在 macOS 上可能失败）
    let getentResult: string | null = null
    if (sudoUser) {
      try {
        getentResult = execFileSync('getent', ['passwd', sudoUser], {
          encoding: 'utf-8',
        })
      } catch {
        // macOS 上可能没有 getent
      }
    }

    const homeDir = resolveHomeDir({
      sudoUser,
      getentResult,
      platform: Platform.Darwin,
      defaultHome: homedir(),
    })

    this.cachedPlatformInfo = {
      platform: Platform.Darwin,
      arch: validateArch(osArch()),
      homeDir,
      isWSL: false,
      isSudo: !!sudoUser,
      sudoUser,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    return {
      copyCommand: 'pbcopy',
      copyArgs: [],
      pasteCommand: 'pbpaste',
      pasteArgs: [],
      available: true, // pbcopy 在 macOS 上始终可用
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'which',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL 特定路径
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
        // Homebrew (Apple Silicon)
        '/opt/homebrew/bin',
        '/opt/homebrew/opt/mysql/bin',
        '/opt/homebrew/opt/mysql@8.0/bin',
        '/opt/homebrew/opt/mysql@8.4/bin',
        '/opt/homebrew/opt/mysql@5.7/bin',
        // Homebrew (Intel)
        '/usr/local/bin',
        '/usr/local/opt/mysql/bin',
        '/usr/local/opt/mysql@8.0/bin',
        '/usr/local/opt/mysql@8.4/bin',
        '/usr/local/opt/mysql@5.7/bin',
        // MySQL 官方安装程序
        '/usr/local/mysql/bin',
      )
    }

    // PostgreSQL 特定路径
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        // Homebrew (Apple Silicon)
        '/opt/homebrew/bin',
        '/opt/homebrew/opt/postgresql/bin',
        '/opt/homebrew/opt/postgresql@17/bin',
        '/opt/homebrew/opt/postgresql@16/bin',
        '/opt/homebrew/opt/postgresql@15/bin',
        '/opt/homebrew/opt/postgresql@14/bin',
        // Homebrew (Intel)
        '/usr/local/bin',
        '/usr/local/opt/postgresql/bin',
        '/usr/local/opt/postgresql@17/bin',
        '/usr/local/opt/postgresql@16/bin',
        '/usr/local/opt/postgresql@15/bin',
        '/usr/local/opt/postgresql@14/bin',
        // Postgres.app
        '/Applications/Postgres.app/Contents/Versions/latest/bin',
      )
    }

    // 通用路径
    paths.push('/usr/local/bin', '/usr/bin')

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    try {
      await execAsync('brew --version')
      return {
        id: 'brew',
        name: 'Homebrew',
        checkCommand: 'brew --version',
        installTemplate: 'brew install {package}',
        updateCommand: 'brew update',
      }
    } catch {
      return null
    }
  }

  getNullDevice(): string {
    return '/dev/null'
  }

  getExecutableExtension(): string {
    return ''
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    const signal = force ? 'SIGKILL' : 'SIGTERM'
    process.kill(pid, signal)
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      const { stdout } = await execAsync(
        `lsof -ti tcp:${port} 2>/dev/null || true`,
      )
      const pids = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((pid) => parseInt(pid, 10))
        .filter((pid) => !isNaN(pid))
      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

class LinuxPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null

    // 尝试通过 getent passwd 获取主目录
    let getentResult: string | null = null
    if (sudoUser) {
      try {
        getentResult = execFileSync('getent', ['passwd', sudoUser], {
          encoding: 'utf-8',
        })
      } catch {
        // getent 执行失败
      }
    }

    const homeDir = resolveHomeDir({
      sudoUser,
      getentResult,
      platform: Platform.Linux,
      defaultHome: homedir(),
    })

    // 检查是否运行在 WSL 中
    let isWSL = false
    try {
      const uname = execSync('uname -r', { encoding: 'utf-8' })
      isWSL = uname.toLowerCase().includes('microsoft')
    } catch {
      // 非 WSL 环境
    }

    this.cachedPlatformInfo = {
      platform: Platform.Linux,
      arch: validateArch(osArch()),
      homeDir,
      isWSL,
      isSudo: !!sudoUser,
      sudoUser,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    // 检查 xclip 是否可用
    let available = false
    try {
      execSync('which xclip', { encoding: 'utf-8' })
      available = true
    } catch {
      // xclip 未安装
    }

    return {
      copyCommand: 'xclip',
      copyArgs: ['-selection', 'clipboard'],
      pasteCommand: 'xclip',
      pasteArgs: ['-selection', 'clipboard', '-o'],
      available,
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'which',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL 特定路径
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
        '/usr/bin',
        '/usr/sbin',
        '/usr/local/bin',
        '/usr/local/mysql/bin',
      )
    }

    // PostgreSQL 特定路径
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        '/usr/bin',
        '/usr/local/bin',
        '/usr/lib/postgresql/17/bin',
        '/usr/lib/postgresql/16/bin',
        '/usr/lib/postgresql/15/bin',
        '/usr/lib/postgresql/14/bin',
      )
    }

    // 通用路径
    paths.push('/usr/bin', '/usr/local/bin')

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    // 首先尝试 apt (Debian/Ubuntu)
    try {
      await execAsync('apt --version')
      return {
        id: 'apt',
        name: 'APT',
        checkCommand: 'apt --version',
        installTemplate: 'sudo apt install -y {package}',
        updateCommand: 'sudo apt update',
      }
    } catch {
      // 非 apt
    }

    // 尝试 dnf (Fedora/RHEL 8+)
    try {
      await execAsync('dnf --version')
      return {
        id: 'dnf',
        name: 'DNF',
        checkCommand: 'dnf --version',
        installTemplate: 'sudo dnf install -y {package}',
        updateCommand: 'sudo dnf check-update',
      }
    } catch {
      // 非 dnf
    }

    // 尝试 yum (RHEL/CentOS 7)
    try {
      await execAsync('yum --version')
      return {
        id: 'yum',
        name: 'YUM',
        checkCommand: 'yum --version',
        installTemplate: 'sudo yum install -y {package}',
        updateCommand: 'sudo yum check-update',
      }
    } catch {
      // 非 yum
    }

    // 尝试 pacman (Arch)
    try {
      await execAsync('pacman --version')
      return {
        id: 'pacman',
        name: 'Pacman',
        checkCommand: 'pacman --version',
        installTemplate: 'sudo pacman -S --noconfirm {package}',
        updateCommand: 'sudo pacman -Sy',
      }
    } catch {
      // 非 pacman
    }

    return null
  }

  getNullDevice(): string {
    return '/dev/null'
  }

  getExecutableExtension(): string {
    return ''
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    const signal = force ? 'SIGKILL' : 'SIGTERM'
    process.kill(pid, signal)
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      const { stdout } = await execAsync(
        `lsof -ti tcp:${port} 2>/dev/null || true`,
      )
      const pids = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((pid) => parseInt(pid, 10))
        .filter((pid) => !isNaN(pid))
      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

class Win32PlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    this.cachedPlatformInfo = {
      platform: Platform.Win32,
      arch: validateArch(osArch()),
      homeDir: homedir(),
      isWSL: false,
      isSudo: false,
      sudoUser: null,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    return {
      copyCommand: 'clip',
      copyArgs: [],
      pasteCommand: 'powershell',
      pasteArgs: ['-command', 'Get-Clipboard'],
      available: true,
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'where',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL 特定路径
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
        'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin',
        'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin',
        'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin',
      )
    }

    // PostgreSQL 特定路径
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        'C:\\Program Files\\PostgreSQL\\17\\bin',
        'C:\\Program Files\\PostgreSQL\\16\\bin',
        'C:\\Program Files\\PostgreSQL\\15\\bin',
        'C:\\Program Files\\PostgreSQL\\14\\bin',
      )
    }

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    // 包管理器检测超时时间（5 秒）
    const timeout = 5000

    // 尝试 chocolatey
    try {
      await execAsync('choco --version', { timeout })
      return {
        id: 'choco',
        name: 'Chocolatey',
        checkCommand: 'choco --version',
        installTemplate: 'choco install -y {package}',
        updateCommand: 'choco upgrade all',
      }
    } catch {
      // 非 chocolatey 或超时
    }

    // 尝试 winget
    try {
      await execAsync('winget --version', { timeout })
      return {
        id: 'winget',
        name: 'Windows Package Manager',
        checkCommand: 'winget --version',
        installTemplate: 'winget install {package}',
        updateCommand: 'winget upgrade --all',
      }
    } catch {
      // 非 winget 或超时
    }

    // 尝试 scoop
    try {
      await execAsync('scoop --version', { timeout })
      return {
        id: 'scoop',
        name: 'Scoop',
        checkCommand: 'scoop --version',
        installTemplate: 'scoop install {package}',
        updateCommand: 'scoop update *',
      }
    } catch {
      // 非 scoop 或超时
    }

    return null
  }

  getNullDevice(): string {
    return 'NUL'
  }

  getExecutableExtension(): string {
    return '.exe'
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    // 在 Windows 上，使用 taskkill 命令
    // /T = 终止子进程，/F = 强制终止
    const args = force ? `/F /PID ${pid} /T` : `/PID ${pid}`
    try {
      await execAsync(`taskkill ${args}`)
    } catch (error) {
      // taskkill 在进程不存在时以错误退出，这是正常的
      const e = error as { code?: number }
      // 错误码 128 表示"进程未找到"，这是可接受的
      if (e.code !== 128) {
        throw error
      }
    }
  }

  isProcessRunning(pid: number): boolean {
    try {
      // process.kill 信号 0 在 Windows 上可用于检查进程是否存在
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      // 使用 netstat 查找监听该端口的 PID
      // -a = 所有连接，-n = 数字格式，-o = 拥有者 PID
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`)
      const pids: number[] = []

      // 解析 netstat 输出，查找在此确切端口上 LISTENING 的进程
      // 格式: TCP    0.0.0.0:PORT    0.0.0.0:0    LISTENING    PID
      const lines = stdout.trim().split('\n')
      for (const line of lines) {
        // 匹配特定端口上 LISTENING 状态的行
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5 && parts[3] === 'LISTENING') {
          const localAddress = parts[1]
          // 检查是否为确切端口（而不仅仅是包含端口号）
          if (localAddress.endsWith(`:${port}`)) {
            const pid = parseInt(parts[4], 10)
            if (!isNaN(pid) && !pids.includes(pid)) {
              pids.push(pid)
            }
          }
        }
      }

      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}\\${toolName}.exe`
  }
}

// 为当前操作系统创建适当的平台服务实例
export function createPlatformService(): BasePlatformService {
  const platform = osPlatform()

  switch (platform) {
    case 'darwin':
      return new DarwinPlatformService()
    case 'linux':
      return new LinuxPlatformService()
    case 'win32':
      return new Win32PlatformService()
    default:
      throw new Error(`不支持的平台: ${platform}`)
  }
}

// 导出单例实例以便使用
export const platformService = createPlatformService()

// 检查是否运行在 Windows 上
export function isWindows(): boolean {
  return process.platform === Platform.Win32
}

/**
 * 获取 Windows shell 要求的 spawn 选项。
 * Windows 需要 shell:true 以便正确执行带引号路径的命令。
 */
export function getWindowsSpawnOptions(): { shell?: true } {
  return isWindows() ? { shell: true } : {}
}
