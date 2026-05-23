import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
  QueryResult,
  QueryOptions,
  CreateUserOptions,
  UserCredentials,
} from '../types'
import { UnsupportedOperationError } from '../core/error-handler'
import { stopPgweb } from '../core/pgweb-utils'

/**
 * 数据库引擎基类
 * 所有引擎（PostgreSQL、MySQL、SQLite 等）都应继承此类
 */
export abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract defaultPort: number
  abstract supportedVersions: string[]

  // 获取二进制文件的下载地址
  abstract getBinaryUrl(version: string, platform: string, arch: string): string

  // 验证二进制文件是否正常工作
  abstract verifyBinary(binPath: string): Promise<boolean>

  // 初始化一个新的数据目录
  abstract initDataDir(
    containerName: string,
    version: string,
    options?: Record<string, unknown>,
  ): Promise<string>

  // 启动数据库服务器
  abstract start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }>

  // 停止数据库服务器
  abstract stop(container: ContainerConfig): Promise<void>

  // 获取数据库服务器的状态
  abstract status(container: ContainerConfig): Promise<StatusResult>

  // 检测备份文件的格式
  abstract detectBackupFormat(filePath: string): Promise<BackupFormat>

  // 将备份恢复到数据库
  abstract restore(
    container: ContainerConfig,
    backupPath: string,
    options?: Record<string, unknown>,
  ): Promise<RestoreResult>

  // 获取容器的连接字符串
  abstract getConnectionString(
    container: ContainerConfig,
    database?: string,
  ): string

  /**
   * 获取 psql 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 psql 的引擎应重写此方法。
   */
  async getPsqlPath(): Promise<string> {
    throw new Error('未找到 psql')
  }

  /**
   * 获取 mysql 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 mysql 的引擎应重写此方法。
   */
  async getMysqlClientPath(): Promise<string> {
    throw new Error('未找到 mysql 客户端')
  }

  /**
   * 获取 mariadb 客户端路径（如果可用）
   * 默认实现抛出错误；MariaDB 引擎会重写此方法。
   */
  async getMariadbClientPath(): Promise<string> {
    throw new Error('未找到 mariadb 客户端')
  }

  /**
   * 获取 mysqladmin 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 mysqladmin 的引擎应重写此方法。
   */
  async getMysqladminPath(): Promise<string> {
    throw new Error('未找到 mysqladmin')
  }

  /**
   * 获取 mongosh 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 mongosh 的引擎应重写此方法。
   */
  async getMongoshPath(): Promise<string> {
    throw new Error('未找到 mongosh')
  }

  /**
   * 获取 redis-cli 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 redis-cli 的引擎应重写此方法。
   */
  async getRedisCliPath(): Promise<string> {
    throw new Error('未找到 redis-cli')
  }

  /**
   * 获取 valkey-cli 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 valkey-cli 的引擎应重写此方法。
   */
  async getValkeyCliPath(): Promise<string> {
    throw new Error('未找到 valkey-cli')
  }

  /**
   * 获取 clickhouse 客户端路径（如果可用）
   * 默认实现抛出错误；能够提供内置或自定义 clickhouse 的引擎应重写此方法。
   */
  async getClickHouseClientPath(): Promise<string> {
    throw new Error('未找到 clickhouse 客户端')
  }

  /**
   * 获取 cockroach 二进制文件路径（如果可用）
   * 默认实现抛出错误；CockroachDB 引擎会重写此方法。
   */
  async getCockroachPath(_version?: string): Promise<string> {
    throw new Error('未找到 cockroach')
  }

  /**
   * 获取 surreal 二进制文件路径（如果可用）
   * 默认实现抛出错误；SurrealDB 引擎会重写此方法。
   */
  async getSurrealPath(_version?: string): Promise<string> {
    throw new Error('未找到 surreal')
  }

  /**
   * 获取 typedb 控制台二进制文件路径（如果可用）
   * 默认实现抛出错误；TypeDB 引擎会重写此方法。
   */
  async getTypeDBConsolePath(_version?: string): Promise<string> {
    throw new Error('未找到 typedb_console_bin')
  }

  /**
   * 获取 influxdb3 二进制文件路径（如果可用）
   * 默认实现抛出错误；InfluxDB 引擎会重写此方法。
   */
  async getInfluxDBPath(_version?: string): Promise<string> {
    throw new Error('未找到 influxdb3')
  }

  /**
   * 获取 tigerbeetle 二进制文件路径（如果可用）
   * 默认实现抛出错误；TigerBeetle 引擎会重写此方法。
   */
  async getTigerBeetlePath(_version?: string): Promise<string> {
    throw new Error('未找到 tigerbeetle')
  }

  /**
   * 获取 sqlite3 客户端路径（如果可用）
   * 默认返回 null；SQLite 引擎会重写此方法。
   */
  async getSqlite3Path(_version?: string): Promise<string | null> {
    return null
  }

  /**
   * 获取 duckdb 客户端路径（如果可用）
   * 默认返回 null；DuckDB 引擎会重写此方法。
   */
  async getDuckDBPath(_version?: string): Promise<string | null> {
    return null
  }

  // 打开交互式 shell/CLI 连接
  abstract connect(container: ContainerConfig, database?: string): Promise<void>

  // 在容器中创建新数据库
  abstract createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  // 删除容器中的数据库
  abstract dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  /**
   * 重命名容器中的数据库。
   * 只有原生支持重命名的引擎才应重写此方法（PostgreSQL、ClickHouse、CockroachDB、Meilisearch）。
   * 其他引擎使用备份/恢复策略，此逻辑在 CLI 层处理。
   */
  async renameDatabase(
    _container: ContainerConfig,
    _oldName: string,
    _newName: string,
  ): Promise<void> {
    throw new UnsupportedOperationError('renameDatabase', this.displayName)
  }

  // 检查二进制文件是否已安装
  abstract isBinaryInstalled(version: string): Promise<boolean>

  // 确保二进制文件可用，必要时进行下载
  abstract ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string>

  /**
   * 将简写版本号（例如 '17'、'8.4'）解析为引擎实际使用的完整固定版本号
   *（例如 '17.10.0'、'8.4.9'）。容器创建时会持久化解析后的值，
   * 这样后续 spindb 升级时不会默默地将容器漂移到其他补丁版本。
   *
   * 默认实现返回原始输入。带有版本映射模块的引擎应重写此方法，
   * 调用其 `normalizeVersion` 函数。
   */
  resolveFullVersion(version: string): string {
    return version
  }

  /**
   * 从远程源获取所有可用版本（按主版本分组）
   * 返回一个映射：主版本 -> 完整版本数组（按最新优先排序）
   * 如果网络请求失败，则回退到硬编码版本
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // 默认实现将支持的版本作为单项数组返回
    const versions: Record<string, string[]> = {}
    for (const v of this.supportedVersions) {
      versions[v] = [v]
    }
    return versions
  }

  /**
   * 从 hostdb 获取已弃用的版本字符串集合。
   * 已弃用的版本仍然可以下载，但不建议用于新安装。
   */
  async fetchDeprecatedVersions(): Promise<Set<string>> {
    return new Set()
  }

  // 使用连接字符串从远程数据库创建转储文件
  abstract dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult>

  /**
   * 获取数据库的大小（以字节为单位）
   * 如果容器未运行或无法确定大小，则返回 null
   */
  abstract getDatabaseSize(container: ContainerConfig): Promise<number | null>

  /**
   * 创建数据库备份
   * @param container - 容器配置
   * @param outputPath - 备份文件的输出路径
   * @param options - 备份选项，包括数据库名称和格式
   */
  abstract backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult>

  /**
   * 对数据库运行 SQL 文件或内联 SQL 语句
   * @param container - 容器配置
   * @param options - 选项，包括文件路径或 SQL 语句，以及目标数据库
   */
  abstract runScript(
    container: ContainerConfig,
    options: {
      file?: string
      sql?: string
      database?: string
      transactionType?: 'read' | 'write' | 'schema'
    },
  ): Promise<void>

  /**
   * 终止到某个数据库的所有活动连接。
   * 在删除可能存在活动连接的数据库之前需要调用此方法。
   * 默认实现为空操作 - 需要此功能的引擎应重写该方法。
   * @param container - 容器配置
   * @param database - 要终止连接的数据库名称
   */
  async terminateConnections(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    // 默认：空操作。在支持连接终止的引擎中重写。
  }

  /**
   * 停止此容器的 pgweb（如果正在运行）。
   * 在支持 pgweb 的引擎（PostgreSQL、CockroachDB、FerretDB）的 stop() 方法中调用。
   */
  protected async stopPgweb(containerName: string): Promise<void> {
    await stopPgweb(containerName, this.name)
  }

  /**
   * 执行查询并以结构化格式返回结果。
   * @param container - 容器配置
   * @param query - 要执行的查询（SQL、JavaScript、Redis 命令或 REST API 请求）
   * @param options - 查询选项，包括目标数据库
   * @returns 包含列、行和行数的 QueryResult
   */
  abstract executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult>

  /**
   * 列出服务器上的所有用户数据库，排除系统数据库。
   * 用于将注册表与服务器上的实际数据库同步。
   *
   * 默认排除的系统数据库：
   * - PostgreSQL: template0, template1, postgres
   * - MySQL/MariaDB: information_schema, mysql, performance_schema, sys
   * - CockroachDB: defaultdb, postgres, system
   *
   * @param container - 容器配置
   * @returns 数据库名称数组（不含系统数据库）
   * @throws 如果引擎不支持多数据库或列出操作，则抛出错误
   */
  async listDatabases(_container: ContainerConfig): Promise<string[]> {
    throw new UnsupportedOperationError('listDatabases', this.displayName)
  }

  /**
   * 使用给定的凭据创建一个数据库用户。
   * 返回包括连接字符串在内的用户凭据。
   *
   * @param container - 容器配置
   * @param options - 用户名、密码和可选的目标数据库
   * @returns 包含连接信息的 UserCredentials
   * @throws 对于不支持用户的引擎（SQLite、DuckDB、QuestDB），抛出 UnsupportedOperationError
   */
  async createUser(
    _container: ContainerConfig,
    _options: CreateUserOptions,
  ): Promise<UserCredentials> {
    throw new UnsupportedOperationError('createUser', this.displayName)
  }
}
