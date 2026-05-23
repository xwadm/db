import { join } from 'path'
import { readdirSync, existsSync } from 'fs'
import { getEngineDefaults } from './engine-defaults'
import { platformService } from '../core/platform-service'

/**
 * 获取 SpinDB 主目录。
 * 首先检查 SPINDB_HOME 环境变量（方便测试时使用），
 * 若未设置则回退到平台特定的主目录检测。
 */
function getSpinDBHome(): string {
  if (process.env.SPINDB_HOME) {
    return process.env.SPINDB_HOME
  }
  const platformInfo = platformService.getPlatformInfo()
  return join(platformInfo.homeDir, '.spindb')
}

const SPINDB_HOME = getSpinDBHome()

// 容器路径函数的参数选项
type ContainerPathOptions = {
  engine: string
}

// 二进制文件路径函数的参数选项
type BinaryPathOptions = {
  engine: string
  version: string
  platform: string
  arch: string
}

export const paths = {
  // 所有 SpinDB 数据的根目录
  root: SPINDB_HOME,

  // 已下载数据库二进制文件的存放目录
  bin: join(SPINDB_HOME, 'bin'),

  // 容器数据的存放目录
  containers: join(SPINDB_HOME, 'containers'),

  // 全局配置文件
  config: join(SPINDB_HOME, 'config.json'),

  // 重命名备份文件的存放目录
  renameBackups: join(SPINDB_HOME, 'backups', 'rename'),

  // 获取特定二进制版本的路径
  getBinaryPath(options: BinaryPathOptions): string {
    const { engine, version, platform, arch } = options
    return join(this.bin, `${engine}-${version}-${platform}-${arch}`)
  },

  /**
   * 获取特定容器的路径
   * 新结构：~/.spindb/containers/{引擎名称}/{容器名称}/
   */
  getContainerPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    return join(this.containers, engine, name)
  },

  // 获取容器配置文件的路径
  getContainerConfigPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    return join(this.containers, engine, name, 'container.json')
  },

  // 获取容器数据目录的路径
  getContainerDataPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    return join(this.containers, engine, name, engineDef.dataSubdir)
  },

  // 获取容器日志文件的路径
  getContainerLogPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    return join(this.containers, engine, name, engineDef.logFileName)
  },

  /**
   * 获取容器 PID 文件的路径
   * 注意：PostgreSQL 的 PID 文件位于数据目录内。MySQL 等引擎可能不同。
   */
  getContainerPidPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    // PostgreSQL: data/postmaster.pid
    // MySQL: data/mysql.pid（或根据配置仅 mysql.pid）
    if (engine === 'postgresql') {
      return join(
        this.containers,
        engine,
        name,
        engineDef.dataSubdir,
        engineDef.pidFileName,
      )
    }
    // MySQL 等：PID 文件位于容器目录层级
    return join(this.containers, engine, name, engineDef.pidFileName)
  },

  // 获取引擎专属的容器目录路径
  getEngineContainersPath(engine: string): string {
    return join(this.containers, engine)
  },

  /**
   * 查找指定引擎所有已安装的二进制版本。
   * 扫描 bin 目录中匹配模式为 {引擎}-{版本}-{平台}-{架构} 的目录。
   *
   * @returns 按版本降序排列的 { version, path } 对象数组
   */
  findInstalledBinaries(
    engine: string,
    platform: string,
    arch: string,
  ): Array<{ version: string; path: string }> {
    if (!existsSync(this.bin)) {
      return []
    }

    const suffix = `-${platform}-${arch}`
    const prefix = `${engine}-`

    try {
      const entries = readdirSync(this.bin, { withFileTypes: true })
      const results: Array<{ version: string; path: string }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(prefix)) continue
        if (!entry.name.endsWith(suffix)) continue

        // 从目录名中提取版本号
        // 例如："postgresql-17.7.0-darwin-arm64" -> "17.7.0"
        const versionPart = entry.name.slice(prefix.length, -suffix.length)
        if (versionPart) {
          results.push({
            version: versionPart,
            path: join(this.bin, entry.name),
          })
        }
      }

      // 按版本降序排列（最新的排在最前）
      // 处理非数字段（如 "1.0.0-beta"）时，退回到字符串比较
      return results.sort((a, b) => {
        const aParts = a.version.split('.')
        const bParts = b.version.split('.')
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const aRaw = aParts[i] || '0'
          const bRaw = bParts[i] || '0'
          const aNum = Number(aRaw)
          const bNum = Number(bRaw)
          // 如果两者都是有效数字，则按数值比较
          if (!isNaN(aNum) && !isNaN(bNum)) {
            if (bNum !== aNum) return bNum - aNum
          } else {
            // 对于非数字段，退回到字符串比较
            const cmp = bRaw.localeCompare(aRaw)
            if (cmp !== 0) return cmp
          }
        }
        return 0
      })
    } catch {
      return []
    }
  },

  /**
   * 查找指定引擎特定主版本的已安装二进制文件。
   *
   * @returns 匹配该主版本的最新安装版本，未找到则返回 null
   */
  findInstalledBinaryForMajor(
    engine: string,
    majorVersion: string,
    platform: string,
    arch: string,
  ): { version: string; path: string } | null {
    const installed = this.findInstalledBinaries(engine, platform, arch)
    const majorPrefix = `${majorVersion}.`

    // 找到匹配该主版本的第一个（最新的）版本
    for (const entry of installed) {
      if (
        entry.version.startsWith(majorPrefix) ||
        entry.version === majorVersion
      ) {
        return entry
      }
    }

    return null
  },
}
