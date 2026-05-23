import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { logDebug, logWarning } from './error-handler'
import { platformService } from './platform-service'
import {
  Engine,
  type SpinDBConfig,
  type BinaryConfig,
  type BinaryTool,
  type BinarySource,
  type SQLiteEngineRegistry,
  type DuckDBEngineRegistry,
} from '../types'

const execAsync = promisify(exec)

const DEFAULT_CONFIG: SpinDBConfig = {
  binaries: {},
}

// 缓存过期阈值（7 天，单位毫秒）
const CACHE_STALENESS_MS = 7 * 24 * 60 * 60 * 1000

// 按引擎和类别组织的所有工具
const POSTGRESQL_SERVER_TOOLS: BinaryTool[] = ['postgres', 'pg_ctl', 'initdb']
const POSTGRESQL_CLIENT_TOOLS: BinaryTool[] = [
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
]
const POSTGRESQL_TOOLS: BinaryTool[] = [
  ...POSTGRESQL_SERVER_TOOLS,
  ...POSTGRESQL_CLIENT_TOOLS,
]

const MYSQL_SERVER_TOOLS: BinaryTool[] = ['mysqld', 'mysqladmin']
const MYSQL_CLIENT_TOOLS: BinaryTool[] = ['mysql', 'mysqldump']
const MYSQL_TOOLS: BinaryTool[] = [...MYSQL_SERVER_TOOLS, ...MYSQL_CLIENT_TOOLS]

const MARIADB_SERVER_TOOLS: BinaryTool[] = ['mariadbd', 'mariadb-admin']
const MARIADB_CLIENT_TOOLS: BinaryTool[] = ['mariadb', 'mariadb-dump']
const MARIADB_TOOLS: BinaryTool[] = [
  ...MARIADB_SERVER_TOOLS,
  ...MARIADB_CLIENT_TOOLS,
]

const MONGODB_TOOLS: BinaryTool[] = [
  'mongod',
  'mongosh',
  'mongodump',
  'mongorestore',
]

const REDIS_TOOLS: BinaryTool[] = ['redis-server', 'redis-cli']

const VALKEY_TOOLS: BinaryTool[] = ['valkey-server', 'valkey-cli']

const QDRANT_TOOLS: BinaryTool[] = ['qdrant']

const MEILISEARCH_TOOLS: BinaryTool[] = ['meilisearch']

const FERRETDB_TOOLS: BinaryTool[] = ['ferretdb']

const SQLITE_TOOLS: BinaryTool[] = ['sqlite3']

const DUCKDB_TOOLS: BinaryTool[] = ['duckdb']

const COUCHDB_TOOLS: BinaryTool[] = ['couchdb']

const COCKROACHDB_TOOLS: BinaryTool[] = ['cockroach']

const SURREALDB_TOOLS: BinaryTool[] = ['surreal']

const QUESTDB_TOOLS: BinaryTool[] = ['questdb']

const TYPEDB_TOOLS: BinaryTool[] = ['typedb', 'typedb_console_bin']

const INFLUXDB_TOOLS: BinaryTool[] = ['influxdb3']

const WEAVIATE_TOOLS: BinaryTool[] = ['weaviate']

const TIGERBEETLE_TOOLS: BinaryTool[] = ['tigerbeetle']

const LIBSQL_TOOLS: BinaryTool[] = ['sqld']

const PGWEB_TOOLS: BinaryTool[] = ['pgweb']

const DBLAB_TOOLS: BinaryTool[] = ['dblab']

const ENHANCED_SHELLS: BinaryTool[] = [
  'pgcli',
  'mycli',
  'litecli',
  'iredis',
  'usql',
]

const ALL_TOOLS: BinaryTool[] = [
  ...POSTGRESQL_TOOLS,
  ...MYSQL_TOOLS,
  ...MARIADB_TOOLS,
  ...MONGODB_TOOLS,
  ...FERRETDB_TOOLS,
  ...REDIS_TOOLS,
  ...VALKEY_TOOLS,
  ...QDRANT_TOOLS,
  ...MEILISEARCH_TOOLS,
  ...COUCHDB_TOOLS,
  ...COCKROACHDB_TOOLS,
  ...SURREALDB_TOOLS,
  ...QUESTDB_TOOLS,
  ...TYPEDB_TOOLS,
  ...INFLUXDB_TOOLS,
  ...WEAVIATE_TOOLS,
  ...TIGERBEETLE_TOOLS,
  ...LIBSQL_TOOLS,
  ...PGWEB_TOOLS,
  ...DBLAB_TOOLS,
  ...SQLITE_TOOLS,
  ...DUCKDB_TOOLS,
  ...ENHANCED_SHELLS,
]

// 引擎名称到其二进制工具的映射（用于扫描 ~/.spindb/bin/）
// SQLite 被排除，因为它使用系统二进制文件，而非 hostdb 下载
const ENGINE_BINARY_MAP: Partial<Record<Engine, BinaryTool[]>> = {
  [Engine.PostgreSQL]: POSTGRESQL_TOOLS,
  [Engine.MySQL]: MYSQL_TOOLS,
  [Engine.MariaDB]: MARIADB_TOOLS,
  [Engine.MongoDB]: MONGODB_TOOLS,
  [Engine.FerretDB]: FERRETDB_TOOLS,
  [Engine.Redis]: REDIS_TOOLS,
  [Engine.Valkey]: VALKEY_TOOLS,
  [Engine.Qdrant]: QDRANT_TOOLS,
  [Engine.Meilisearch]: MEILISEARCH_TOOLS,
  [Engine.CouchDB]: COUCHDB_TOOLS,
  [Engine.CockroachDB]: COCKROACHDB_TOOLS,
  [Engine.SurrealDB]: SURREALDB_TOOLS,
  [Engine.QuestDB]: QUESTDB_TOOLS,
  [Engine.TypeDB]: TYPEDB_TOOLS,
  [Engine.InfluxDB]: INFLUXDB_TOOLS,
  [Engine.Weaviate]: WEAVIATE_TOOLS,
  [Engine.TigerBeetle]: TIGERBEETLE_TOOLS,
  [Engine.LibSQL]: LIBSQL_TOOLS,
}

export class ConfigManager {
  private config: SpinDBConfig | null = null

  async load(): Promise<SpinDBConfig> {
    if (this.config) {
      return this.config
    }

    const configPath = paths.config

    if (!existsSync(configPath)) {
      // 创建默认配置
      this.config = { ...DEFAULT_CONFIG }
      await this.save()
      return this.config
    }

    try {
      const content = await readFile(configPath, 'utf8')
      this.config = JSON.parse(content) as SpinDBConfig
      return this.config
    } catch (error) {
      // 如果配置文件损坏，重置为默认值
      logWarning('配置文件已损坏，正在重置为默认值', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      })
      this.config = { ...DEFAULT_CONFIG }
      await this.save()
      return this.config
    }
  }

  async save(): Promise<void> {
    const configPath = paths.config
    await mkdir(dirname(configPath), { recursive: true })

    if (this.config) {
      this.config.updatedAt = new Date().toISOString()
      await writeFile(configPath, JSON.stringify(this.config, null, 2))
    }
  }

  async getBinaryPath(tool: BinaryTool): Promise<string | null> {
    const config = await this.load()

    const binaryConfig = config.binaries[tool]
    if (binaryConfig?.path) {
      if (existsSync(binaryConfig.path)) {
        return binaryConfig.path
      }
      // 路径已失效，清除它
      delete config.binaries[tool]
      await this.save()
    }

    // 尝试从系统中检测
    const systemPath = await this.detectSystemBinary(tool)
    if (systemPath) {
      await this.setBinaryPath(tool, systemPath, 'system')
      return systemPath
    }

    return null
  }

  /**
   * 获取带版本验证的二进制文件路径
   *
   * 与 getBinaryPath() 不同，此方法还会验证缓存的版本是否与
   * 实际二进制文件版本匹配。用于对版本敏感的操作，
   * 如备份/恢复，使用错误版本可能导致失败。
   */
  async getBinaryPathWithVersionCheck(tool: BinaryTool): Promise<{
    path: string | null
    versionMismatch: boolean
    cachedVersion?: string
    actualVersion?: string
  }> {
    const config = await this.load()
    const binaryConfig = config.binaries[tool]

    if (!binaryConfig?.path) {
      // 没有缓存路径，尝试检测
      const systemPath = await this.detectSystemBinary(tool)
      if (systemPath) {
        await this.setBinaryPath(tool, systemPath, 'system')
        return { path: systemPath, versionMismatch: false }
      }
      return { path: null, versionMismatch: false }
    }

    // 检查文件是否存在
    if (!existsSync(binaryConfig.path)) {
      delete config.binaries[tool]
      await this.save()
      return { path: null, versionMismatch: false }
    }

    // 验证版本是否与缓存版本匹配
    if (binaryConfig.version) {
      try {
        const { stdout } = await execAsync(`"${binaryConfig.path}" --version`)
        const match = stdout.match(/(\d+\.\d+)/)
        const actualVersion = match ? match[1] : undefined

        if (actualVersion && actualVersion !== binaryConfig.version) {
          logWarning('检测到二进制文件版本不匹配', {
            tool,
            path: binaryConfig.path,
            cachedVersion: binaryConfig.version,
            actualVersion,
          })

          const cachedVersion = binaryConfig.version

          // 用实际版本更新缓存
          binaryConfig.version = actualVersion
          await this.save()

          return {
            path: binaryConfig.path,
            versionMismatch: true,
            cachedVersion,
            actualVersion,
          }
        }
      } catch (error) {
        logDebug('版本检查失败', {
          tool,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { path: binaryConfig.path, versionMismatch: false }
  }

  /**
   * 强制刷新特定二进制文件的路径和版本
   *
   * 清除现有缓存条目并从系统重新检测。
   * 在可能已更改二进制文件版本的包管理器操作后使用。
   */
  async refreshBinaryWithVersion(
    tool: BinaryTool,
  ): Promise<BinaryConfig | null> {
    // 清除此工具的现有缓存
    await this.clearBinaryPath(tool)

    // 从系统重新检测
    const systemPath = await this.detectSystemBinary(tool)
    if (systemPath) {
      await this.setBinaryPath(tool, systemPath, 'system')
      const config = await this.load()
      return config.binaries[tool] || null
    }

    return null
  }

  async setBinaryPath(
    tool: BinaryTool,
    path: string,
    source: BinarySource,
  ): Promise<void> {
    const config = await this.load()

    // 尽可能获取版本号
    let version: string | undefined
    try {
      const { stdout } = await execAsync(`"${path}" --version`)
      const match = stdout.match(/\d+\.\d+/)
      if (match) {
        version = match[0]
      }
    } catch (error) {
      logDebug('版本检测失败', {
        tool,
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    config.binaries[tool] = {
      tool,
      path,
      source,
      version,
    }

    await this.save()
  }

  async getBinaryConfig(tool: BinaryTool): Promise<BinaryConfig | null> {
    const config = await this.load()
    return config.binaries[tool] || null
  }

  async detectSystemBinary(tool: BinaryTool): Promise<string | null> {
    // 使用 platformService 处理跨平台差异
    // （which vs where、.exe 扩展名、平台特定的搜索路径）
    return platformService.findToolPath(tool)
  }

  async detectAllTools(): Promise<Map<BinaryTool, string>> {
    const found = new Map<BinaryTool, string>()

    for (const tool of ALL_TOOLS) {
      const path = await this.detectSystemBinary(tool)
      if (path) {
        found.set(tool, path)
      }
    }

    return found
  }

  async initialize(): Promise<{
    found: BinaryTool[]
    missing: BinaryTool[]
    postgresql: { found: BinaryTool[]; missing: BinaryTool[] }
    mysql: { found: BinaryTool[]; missing: BinaryTool[] }
    mariadb: { found: BinaryTool[]; missing: BinaryTool[] }
    mongodb: { found: BinaryTool[]; missing: BinaryTool[] }
    ferretdb: { found: BinaryTool[]; missing: BinaryTool[] }
    redis: { found: BinaryTool[]; missing: BinaryTool[] }
    valkey: { found: BinaryTool[]; missing: BinaryTool[] }
    meilisearch: { found: BinaryTool[]; missing: BinaryTool[] }
    typedb: { found: BinaryTool[]; missing: BinaryTool[] }
    influxdb: { found: BinaryTool[]; missing: BinaryTool[] }
    weaviate: { found: BinaryTool[]; missing: BinaryTool[] }
    enhanced: { found: BinaryTool[]; missing: BinaryTool[] }
  }> {
    // 首先，扫描 ~/.spindb/bin/ 中已下载的（捆绑的）二进制文件
    // 确保捆绑的二进制文件在系统检测之前被注册
    await this.scanInstalledBinaries()

    const found: BinaryTool[] = []
    const missing: BinaryTool[] = []

    for (const tool of ALL_TOOLS) {
      const path = await this.getBinaryPath(tool)
      if (path) {
        found.push(tool)
      } else {
        missing.push(tool)
      }
    }

    return {
      found,
      missing,
      postgresql: {
        found: found.filter((t) => POSTGRESQL_TOOLS.includes(t)),
        missing: missing.filter((t) => POSTGRESQL_TOOLS.includes(t)),
      },
      mysql: {
        found: found.filter((t) => MYSQL_TOOLS.includes(t)),
        missing: missing.filter((t) => MYSQL_TOOLS.includes(t)),
      },
      mariadb: {
        found: found.filter((t) => MARIADB_TOOLS.includes(t)),
        missing: missing.filter((t) => MARIADB_TOOLS.includes(t)),
      },
      mongodb: {
        found: found.filter((t) => MONGODB_TOOLS.includes(t)),
        missing: missing.filter((t) => MONGODB_TOOLS.includes(t)),
      },
      ferretdb: {
        found: found.filter((t) => FERRETDB_TOOLS.includes(t)),
        missing: missing.filter((t) => FERRETDB_TOOLS.includes(t)),
      },
      redis: {
        found: found.filter((t) => REDIS_TOOLS.includes(t)),
        missing: missing.filter((t) => REDIS_TOOLS.includes(t)),
      },
      valkey: {
        found: found.filter((t) => VALKEY_TOOLS.includes(t)),
        missing: missing.filter((t) => VALKEY_TOOLS.includes(t)),
      },
      meilisearch: {
        found: found.filter((t) => MEILISEARCH_TOOLS.includes(t)),
        missing: missing.filter((t) => MEILISEARCH_TOOLS.includes(t)),
      },
      typedb: {
        found: found.filter((t) => TYPEDB_TOOLS.includes(t)),
        missing: missing.filter((t) => TYPEDB_TOOLS.includes(t)),
      },
      influxdb: {
        found: found.filter((t) => INFLUXDB_TOOLS.includes(t)),
        missing: missing.filter((t) => INFLUXDB_TOOLS.includes(t)),
      },
      weaviate: {
        found: found.filter((t) => WEAVIATE_TOOLS.includes(t)),
        missing: missing.filter((t) => WEAVIATE_TOOLS.includes(t)),
      },
      enhanced: {
        found: found.filter((t) => ENHANCED_SHELLS.includes(t)),
        missing: missing.filter((t) => ENHANCED_SHELLS.includes(t)),
      },
    }
  }

  async isStale(): Promise<boolean> {
    const config = await this.load()
    if (!config.updatedAt) {
      return true
    }

    const updatedAt = new Date(config.updatedAt).getTime()
    const now = Date.now()
    return now - updatedAt > CACHE_STALENESS_MS
  }

  async refreshIfStale(): Promise<boolean> {
    if (await this.isStale()) {
      await this.refreshAllBinaries()
      return true
    }
    return false
  }

  async refreshAllBinaries(): Promise<void> {
    await this.clearAllBinaries()
    await this.initialize()
  }

  async getConfig(): Promise<SpinDBConfig> {
    return this.load()
  }

  async clearBinaryPath(tool: BinaryTool): Promise<void> {
    const config = await this.load()
    delete config.binaries[tool]
    await this.save()
  }

  async clearAllBinaries(): Promise<void> {
    const config = await this.load()
    config.binaries = {}
    await this.save()
  }

  // SQLite 注册表方法
  async getSqliteRegistry(): Promise<SQLiteEngineRegistry> {
    const config = await this.load()
    return (
      config.registry?.sqlite ?? {
        version: 1,
        entries: [],
        ignoreFolders: {},
      }
    )
  }

  async saveSqliteRegistry(registry: SQLiteEngineRegistry): Promise<void> {
    const config = await this.load()
    if (!config.registry) {
      config.registry = {}
    }
    config.registry.sqlite = registry
    await this.save()
  }

  // DuckDB 注册表方法
  async getDuckDBRegistry(): Promise<DuckDBEngineRegistry> {
    const config = await this.load()
    return (
      config.registry?.duckdb ?? {
        version: 1,
        entries: [],
        ignoreFolders: {},
      }
    )
  }

  async saveDuckDBRegistry(registry: DuckDBEngineRegistry): Promise<void> {
    const config = await this.load()
    if (!config.registry) {
      config.registry = {}
    }
    config.registry.duckdb = registry
    await this.save()
  }

  /**
   * 扫描 ~/.spindb/bin/ 中已安装的引擎二进制文件并注册缺失的条目。
   * 确保之前下载的二进制文件在配置中可用，
   * 即使配置已被清除或在具有相同主目录的新机器上。
   *
   * 目录格式：{引擎}-{版本}-{平台}-{架构}
   * 例如：postgresql-18.1.0-darwin-arm64
   */
  async scanInstalledBinaries(): Promise<{
    scanned: number
    registered: number
    engines: string[]
  }> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return { scanned: 0, registered: 0, engines: [] }
    }

    const config = await this.load()
    let scanned = 0
    let registered = 0
    const enginesFound: string[] = []

    try {
      const entries = await readdir(binDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        // 解析目录名：{引擎}-{版本}-{平台}-{架构}
        // 例如：postgresql-18.1.0-darwin-arm64, mysql-9.5.0-darwin-arm64
        // 同时处理预发布版本号，如 18.1.0-beta1 或 8.0.0-rc1
        const match = entry.name.match(
          /^(\w+)-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(\w+)-(\w+)$/,
        )
        if (!match) continue

        const [, engineName] = match

        // 在转换前验证 engineName 是否为已知引擎
        if (
          !Object.prototype.hasOwnProperty.call(ENGINE_BINARY_MAP, engineName)
        ) {
          continue
        }
        const engine = engineName as Engine
        const engineTools = ENGINE_BINARY_MAP[engine]!

        scanned++
        if (!enginesFound.includes(engine)) {
          enginesFound.push(engine)
        }

        const engineBinPath = join(binDir, entry.name, 'bin')
        if (!existsSync(engineBinPath)) continue

        const ext = platformService.getExecutableExtension()

        for (const tool of engineTools) {
          // 如果已注册为捆绑类型则跳过
          const existing = config.binaries[tool]
          if (existing?.source === 'bundled' && existsSync(existing.path)) {
            continue
          }

          const toolPath = join(engineBinPath, `${tool}${ext}`)
          if (existsSync(toolPath)) {
            await this.setBinaryPath(tool, toolPath, 'bundled')
            registered++
            logDebug(`从扫描中注册二进制文件：${tool}`, { path: toolPath })
          }
        }
      }
    } catch (error) {
      logWarning('扫描已安装的二进制文件失败', {
        binDir,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return { scanned, registered, engines: enginesFound }
  }
}

export const configManager = new ConfigManager()

// 导出工具类别供命令使用
export {
  POSTGRESQL_TOOLS,
  POSTGRESQL_SERVER_TOOLS,
  POSTGRESQL_CLIENT_TOOLS,
  MYSQL_TOOLS,
  MYSQL_SERVER_TOOLS,
  MYSQL_CLIENT_TOOLS,
  MARIADB_TOOLS,
  MARIADB_SERVER_TOOLS,
  MARIADB_CLIENT_TOOLS,
  MONGODB_TOOLS,
  FERRETDB_TOOLS,
  REDIS_TOOLS,
  VALKEY_TOOLS,
  QDRANT_TOOLS,
  MEILISEARCH_TOOLS,
  COUCHDB_TOOLS,
  COCKROACHDB_TOOLS,
  SURREALDB_TOOLS,
  QUESTDB_TOOLS,
  TYPEDB_TOOLS,
  INFLUXDB_TOOLS,
  WEAVIATE_TOOLS,
  TIGERBEETLE_TOOLS,
  LIBSQL_TOOLS,
  PGWEB_TOOLS,
  DBLAB_TOOLS,
  SQLITE_TOOLS,
  DUCKDB_TOOLS,
  ENHANCED_SHELLS,
  ALL_TOOLS,
  ENGINE_BINARY_MAP,
}
