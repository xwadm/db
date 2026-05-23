import { existsSync } from 'fs'
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  cp,
  unlink,
  rename as fsRename,
} from 'fs/promises'
import { paths } from '../config/paths'
import { processManager } from './process-manager'
import { portManager } from './port-manager'
import { isWindows } from './platform-service'
import { logDebug, UnsupportedOperationError } from './error-handler'
import { getEngineDefaults, getSupportedEngines } from '../config/defaults'
import { getEngine } from '../engines'
import { sqliteRegistry } from '../engines/sqlite/registry'
import { duckdbRegistry } from '../engines/duckdb/registry'

// 基于文件的引擎（SQLite、DuckDB）不会为每个容器固定特定的二进制版本 ——
// 文件格式由库管理，任何匹配主版本的都可以读取任何文件。
// 但 ContainerConfig 类型要求一个 `version` 字符串，
// 因此我们报告引擎推荐主版本对应的 hostdb 解析的完整版本。
// 这使显示的版本与 spindb 当前实际使用的二进制文件保持一致，
// 而不是硬编码的简写 '3'/'1'，后者会与实际二进制文件脱节。
function fileBasedEngineVersion(engine: 'sqlite' | 'duckdb'): string {
  const major = getEngineDefaults(engine).defaultVersion
  const dbEngine = getEngine(engine)
  return dbEngine.resolveFullVersion(major)
}
import type { ContainerConfig } from '../types'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../types'

export type CreateOptions = {
  engine: Engine
  version: string
  port: number
  database: string
  /** 引擎二进制文件路径（用于系统安装的引擎，如 MySQL、MongoDB、Redis） */
  binaryPath?: string
}

export type DeleteOptions = {
  force?: boolean
}

export class ContainerManager {
  async create(name: string, options: CreateOptions): Promise<ContainerConfig> {
    const { engine, version, port, database, binaryPath } = options

    // 验证容器名称
    if (!this.isValidName(name)) {
      throw new Error(
        '容器名称必须为字母数字，仅允许连字符和下划线',
      )
    }

    // 检查容器是否已存在（针对此引擎）
    if (await this.exists(name, { engine })) {
      throw new Error(`引擎 ${engine} 的容器 "${name}" 已存在`)
    }

    // 创建容器目录（按引擎作用域）
    const containerPath = paths.getContainerPath(name, { engine })
    const dataPath = paths.getContainerDataPath(name, { engine })

    await mkdir(containerPath, { recursive: true })
    await mkdir(dataPath, { recursive: true })

    // 创建容器配置
    const config: ContainerConfig = {
      name,
      engine,
      version,
      port,
      database,
      databases: [database],
      created: new Date().toISOString(),
      status: 'created',
      // 存储系统安装引擎的二进制文件路径（MySQL、MongoDB、Redis）
      // 确保启动容器时的版本一致性
      ...(binaryPath && { binaryPath }),
    }

    await this.saveConfig(name, { engine }, config)

    return config
  }

  // 如果未提供引擎，则搜索所有引擎目录。
  // 自动迁移旧架构以包含 databases 数组。
  async getConfig(
    name: string,
    options?: { engine?: string },
  ): Promise<ContainerConfig | null> {
    const { engine } = options || {}

    if (engine) {
      // SQLite 使用注册表而非文件系统
      if (engine === Engine.SQLite) {
        return this.getSqliteConfig(name)
      }

      // 在特定引擎目录中查找
      const configPath = paths.getContainerConfigPath(name, { engine })
      if (!existsSync(configPath)) {
        return null
      }
      const content = await readFile(configPath, 'utf8')
      const config = JSON.parse(content) as ContainerConfig
      return this.migrateConfig(config)
    }

    // 首先搜索 SQLite 注册表
    const sqliteConfig = await this.getSqliteConfig(name)
    if (sqliteConfig) {
      return sqliteConfig
    }

    // 搜索 DuckDB 注册表
    const duckdbConfig = await this.getDuckDBConfig(name)
    if (duckdbConfig) {
      return duckdbConfig
    }

    // 搜索所有引擎目录（排除使用注册表的基于文件的引擎）
    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )
    for (const eng of engines) {
      const configPath = paths.getContainerConfigPath(name, { engine: eng })
      if (existsSync(configPath)) {
        const content = await readFile(configPath, 'utf8')
        const config = JSON.parse(content) as ContainerConfig
        return this.migrateConfig(config)
      }
    }

    return null
  }

  private async getSqliteConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await sqliteRegistry.get(name)
    if (!entry) {
      return null
    }

    // 将注册表条目转换为 ContainerConfig 格式
    const fileExists = existsSync(entry.filePath)
    return {
      name: entry.name,
      engine: Engine.SQLite,
      version: fileBasedEngineVersion('sqlite'),
      port: 0,
      database: entry.filePath, // 对于 SQLite，database 字段存储文件路径
      databases: [entry.filePath],
      created: entry.created,
      status: fileExists ? 'running' : 'stopped', // "running" = 文件存在
    }
  }

  private async getDuckDBConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await duckdbRegistry.get(name)
    if (!entry) {
      return null
    }

    // 将注册表条目转换为 ContainerConfig 格式
    const fileExists = existsSync(entry.filePath)
    return {
      name: entry.name,
      engine: Engine.DuckDB,
      version: fileBasedEngineVersion('duckdb'),
      port: 0,
      database: entry.filePath, // 对于 DuckDB，database 字段存储文件路径
      databases: [entry.filePath],
      created: entry.created,
      status: fileExists ? 'running' : 'stopped', // "running" = 文件存在
    }
  }

  // 将旧的容器配置迁移以包含 databases 数组。
  private async migrateConfig(
    config: ContainerConfig,
  ): Promise<ContainerConfig> {
    let needsSave = false

    // 如果 databases 数组缺失，使用主数据库创建它
    if (!config.databases) {
      config.databases = [config.database]
      needsSave = true
    }

    // 确保主数据库在数组中
    if (!config.databases.includes(config.database)) {
      config.databases = [config.database, ...config.databases]
      needsSave = true
    }

    // 如果做了更改则保存
    if (needsSave) {
      await this.saveConfig(config.name, { engine: config.engine }, config)
    }

    return config
  }

  async saveConfig(
    name: string,
    options: { engine: string },
    config: ContainerConfig,
  ): Promise<void> {
    const { engine } = options
    const configPath = paths.getContainerConfigPath(name, { engine })
    await writeFile(configPath, JSON.stringify(config, null, 2))
  }

  async updateConfig(
    name: string,
    updates: Partial<ContainerConfig>,
  ): Promise<ContainerConfig> {
    const config = await this.getConfig(name)
    if (!config) {
      throw new Error(`未找到容器 "${name}"`)
    }

    const updatedConfig = { ...config, ...updates }
    await this.saveConfig(name, { engine: config.engine }, updatedConfig)
    return updatedConfig
  }

  async exists(name: string, options?: { engine?: string }): Promise<boolean> {
    const { engine } = options || {}

    if (engine) {
      // SQLite 使用注册表
      if (engine === Engine.SQLite) {
        return sqliteRegistry.exists(name)
      }
      const configPath = paths.getContainerConfigPath(name, { engine })
      return existsSync(configPath)
    }

    // 首先检查 SQLite 注册表
    if (await sqliteRegistry.exists(name)) {
      return true
    }

    // 检查 DuckDB 注册表
    if (await duckdbRegistry.exists(name)) {
      return true
    }

    // 检查所有引擎目录（排除基于文件的引擎）
    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )
    for (const eng of engines) {
      const configPath = paths.getContainerConfigPath(name, { engine: eng })
      if (existsSync(configPath)) {
        return true
      }
    }

    return false
  }

  async list(): Promise<ContainerConfig[]> {
    const containers: ContainerConfig[] = []

    // 从注册表列出 SQLite 容器
    const sqliteEntries = await sqliteRegistry.list()
    const sqliteVersion = fileBasedEngineVersion('sqlite')
    for (const entry of sqliteEntries) {
      const fileExists = existsSync(entry.filePath)
      containers.push({
        name: entry.name,
        engine: Engine.SQLite,
        version: sqliteVersion,
        port: 0,
        database: entry.filePath,
        databases: [entry.filePath],
        created: entry.created,
        status: fileExists ? 'running' : 'stopped', // "running" = 文件存在
      })
    }

    // 从注册表列出 DuckDB 容器
    const duckdbEntries = await duckdbRegistry.list()
    const duckdbVersion = fileBasedEngineVersion('duckdb')
    for (const entry of duckdbEntries) {
      const fileExists = existsSync(entry.filePath)
      containers.push({
        name: entry.name,
        engine: Engine.DuckDB,
        version: duckdbVersion,
        port: 0,
        database: entry.filePath,
        databases: [entry.filePath],
        created: entry.created,
        status: fileExists ? 'running' : 'stopped', // "running" = 文件存在
      })
    }

    // 列出基于服务器的容器（PostgreSQL、MySQL 等）
    const containersDir = paths.containers
    if (!existsSync(containersDir)) {
      return containers
    }

    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )

    // 收集所有容器检查的 Promise 以便并行执行
    const containerChecks: Promise<ContainerConfig | null>[] = []

    for (const engine of engines) {
      const engineDir = paths.getEngineContainersPath(engine)
      if (!existsSync(engineDir)) {
        continue
      }

      const entries = await readdir(engineDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // 将异步检查作为 Promise 推入（暂不 await）
          containerChecks.push(
            (async () => {
              const config = await this.getConfig(entry.name, { engine })
              if (!config) return null
              // 远程容器保持其 'linked' 状态 —— 不检查进程
              if (isRemoteContainer(config)) {
                return { ...config, status: 'linked' as const }
              }
              const running = await processManager.isRunning(entry.name, {
                engine,
              })
              return { ...config, status: running ? 'running' : 'stopped' }
            })(),
          )
        }
      }
    }

    // 并行执行所有容器检查
    const results = await Promise.all(containerChecks)
    containers.push(...results.filter((c): c is ContainerConfig => c !== null))

    return containers
  }

  async delete(name: string, options: DeleteOptions = {}): Promise<void> {
    const { force = false } = options

    // 获取容器配置以查找引擎
    const config = await this.getConfig(name)
    if (!config) {
      throw new Error(`未找到容器 "${name}"`)
    }

    const { engine } = config

    // SQLite：删除文件，从注册表中移除，并清理容器目录
    if (engine === Engine.SQLite) {
      const entry = await sqliteRegistry.get(name)
      if (entry && existsSync(entry.filePath)) {
        await unlink(entry.filePath)
      }
      await sqliteRegistry.remove(name)

      // 同时移除容器目录（由 containerManager.create 创建）
      const containerPath = paths.getContainerPath(name, { engine })
      if (existsSync(containerPath)) {
        await rm(containerPath, { recursive: true, force: true })
      }
      return
    }

    // DuckDB：删除文件，从注册表中移除，并清理容器目录
    if (engine === Engine.DuckDB) {
      const entry = await duckdbRegistry.get(name)
      if (entry && existsSync(entry.filePath)) {
        await unlink(entry.filePath)
      }
      await duckdbRegistry.remove(name)

      // 同时移除容器目录（由 containerManager.create 创建）
      const containerPath = paths.getContainerPath(name, { engine })
      if (existsSync(containerPath)) {
        await rm(containerPath, { recursive: true, force: true })
      }
      return
    }

    // 远程容器：仅移除本地元数据（没有进程需要停止）
    if (isRemoteContainer(config)) {
      const containerPath = paths.getContainerPath(name, { engine })
      await this.safeRemoveDirectory(containerPath)
      return
    }

    // 服务器数据库：先检查是否在运行
    const running = await processManager.isRunning(name, { engine })
    if (running && !force) {
      throw new Error(
        `容器 "${name}" 正在运行。请先停止它或使用 --force`,
      )
    }

    const containerPath = paths.getContainerPath(name, { engine })
    await this.safeRemoveDirectory(containerPath)
  }

  // 带重试逻辑的目录删除，用于处理 Windows EBUSY 错误。
  // Windows 在进程终止后可能持有文件句柄。
  // Windows 可能因以下原因持有文件锁 120 秒以上：
  // - 杀毒软件扫描
  // - Windows Search 索引器
  // - 内存映射文件（SurrealDB 的 SurrealKV、QuestDB 的列式存储）
  // - Java JVM 文件句柄清理（QuestDB）
  private async safeRemoveDirectory(dirPath: string): Promise<void> {
    const maxRetries = isWindows() ? 90 : 1 // 90 次重试 x 2 秒 = 最多 180 秒
    const retryDelay = 2000 // 每次重试间隔 2 秒

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await rm(dirPath, { recursive: true, force: true })
        return // 成功
      } catch (error) {
        const e = error as NodeJS.ErrnoException
        if (e.code === 'EBUSY' && attempt < maxRetries) {
          logDebug(
            `rmdir 尝试 ${attempt}/${maxRetries} 时遇到 EBUSY，${retryDelay}ms 后重试...`,
          )
          await new Promise((resolve) => setTimeout(resolve, retryDelay))
        } else {
          throw error
        }
      }
    }
  }

  async clone(
    sourceName: string,
    targetName: string,
  ): Promise<ContainerConfig> {
    // 验证目标名称
    if (!this.isValidName(targetName)) {
      throw new Error(
        '容器名称必须为字母数字，仅允许连字符和下划线',
      )
    }

    // 获取源配置
    const sourceConfig = await this.getConfig(sourceName)
    if (!sourceConfig) {
      throw new Error(`未找到源容器 "${sourceName}"`)
    }

    const { engine } = sourceConfig

    // 检查目标是否已存在（针对此引擎）
    if (await this.exists(targetName, { engine })) {
      throw new Error(`目标容器 "${targetName}" 已存在`)
    }

    // 检查源是否未在运行
    const running = await processManager.isRunning(sourceName, { engine })
    if (running) {
      throw new Error(
        `源容器 "${sourceName}" 正在运行。请先停止它`,
      )
    }

    // 复制容器目录
    const sourcePath = paths.getContainerPath(sourceName, { engine })
    const targetPath = paths.getContainerPath(targetName, { engine })

    await cp(sourcePath, targetPath, { recursive: true })

    // 如果复制后发生任何失败，清理目标目录
    try {
      // 更新目标配置
      const config = await this.getConfig(targetName, { engine })
      if (!config) {
        throw new Error('读取克隆的容器配置失败')
      }

      config.name = targetName
      config.created = new Date().toISOString()
      config.clonedFrom = sourceName

      // 分配新端口（排除已被其他容器使用的端口）
      const engineDefaults = getEngineDefaults(engine)
      const { port } = await portManager.findAvailablePortExcludingContainers({
        portRange: engineDefaults.portRange,
      })
      config.port = port

      await this.saveConfig(targetName, { engine }, config)

      // ClickHouse 在 config.xml 中存储绝对路径 —— 用新路径重新生成
      if (engine === Engine.ClickHouse) {
        const clickhouseEngine = getEngine(Engine.ClickHouse)
        if ('regenerateConfig' in clickhouseEngine) {
          await (
            clickhouseEngine as {
              regenerateConfig: (name: string, port: number) => Promise<void>
            }
          ).regenerateConfig(targetName, config.port)
        }
      }

      return config
    } catch (error) {
      // 失败时清理已复制的目录
      await rm(targetPath, { recursive: true, force: true }).catch(() => {
        // 忽略清理错误
      })
      throw error
    }
  }

  async rename(oldName: string, newName: string): Promise<ContainerConfig> {
    // 验证新名称
    if (!this.isValidName(newName)) {
      throw new Error(
        '容器名称必须为字母数字，仅允许连字符和下划线',
      )
    }

    // 获取源配置
    const sourceConfig = await this.getConfig(oldName)
    if (!sourceConfig) {
      throw new Error(`未找到容器 "${oldName}"`)
    }

    const { engine } = sourceConfig

    // 检查目标是否已存在
    if (await this.exists(newName, { engine })) {
      throw new Error(`容器 "${newName}" 已存在`)
    }

    // SQLite：在注册表中重命名并处理容器目录
    if (engine === Engine.SQLite) {
      const entry = await sqliteRegistry.get(oldName)
      if (!entry) {
        throw new Error(`在注册表中未找到 SQLite 容器 "${oldName}"`)
      }

      // 先移动容器目录（如果存在）—— 先做文件系统操作再更新注册表
      // 这样如果移动失败，注册表保持不变
      const oldContainerPath = paths.getContainerPath(oldName, { engine })
      const newContainerPath = paths.getContainerPath(newName, { engine })
      if (existsSync(oldContainerPath)) {
        await this.atomicMoveDirectory(oldContainerPath, newContainerPath)
      }

      // 现在更新注册表 —— 移除旧条目并添加更新名称的新条目
      await sqliteRegistry.remove(oldName)
      await sqliteRegistry.add({
        name: newName,
        filePath: entry.filePath,
        created: entry.created,
        lastVerified: entry.lastVerified,
      })

      // 返回更新后的配置
      return {
        ...sourceConfig,
        name: newName,
      }
    }

    // DuckDB：在注册表中重命名并处理容器目录
    if (engine === Engine.DuckDB) {
      const entry = await duckdbRegistry.get(oldName)
      if (!entry) {
        throw new Error(`在注册表中未找到 DuckDB 容器 "${oldName}"`)
      }

      // 先移动容器目录（如果存在）—— 先做文件系统操作再更新注册表
      // 这样如果移动失败，注册表保持不变
      const oldContainerPath = paths.getContainerPath(oldName, { engine })
      const newContainerPath = paths.getContainerPath(newName, { engine })
      if (existsSync(oldContainerPath)) {
        await this.atomicMoveDirectory(oldContainerPath, newContainerPath)
      }

      // 现在更新注册表 —— 移除旧条目并添加更新名称的新条目
      await duckdbRegistry.remove(oldName)
      await duckdbRegistry.add({
        name: newName,
        filePath: entry.filePath,
        created: entry.created,
        lastVerified: entry.lastVerified,
      })

      // 返回更新后的配置
      return {
        ...sourceConfig,
        name: newName,
      }
    }

    // 服务器数据库：检查容器是否未在运行
    const running = await processManager.isRunning(oldName, { engine })
    if (running) {
      throw new Error(`容器 "${oldName}" 正在运行。请先停止它`)
    }

    // 重命名目录
    const oldPath = paths.getContainerPath(oldName, { engine })
    const newPath = paths.getContainerPath(newName, { engine })

    await this.atomicMoveDirectory(oldPath, newPath)

    // 用新名称更新配置
    const config = await this.getConfig(newName, { engine })
    if (!config) {
      throw new Error('读取重命名后的容器配置失败')
    }

    config.name = newName
    await this.saveConfig(newName, { engine }, config)

    // ClickHouse 在 config.xml 中存储绝对路径 —— 用新路径重新生成
    if (engine === Engine.ClickHouse) {
      const clickhouseEngine = getEngine(Engine.ClickHouse)
      if ('regenerateConfig' in clickhouseEngine) {
        await (
          clickhouseEngine as {
            regenerateConfig: (name: string, port: number) => Promise<void>
          }
        ).regenerateConfig(newName, config.port)
      }
    }

    return config
  }

  // 在可能的情况下原子性地移动目录（同一文件系统）。
  // 对于跨文件系统的移动，回退到复制+删除。
  // 在 Windows 上，遇到 EBUSY 错误时重试（进程终止后持有的文件句柄）。
  // Windows 可能因以下原因持有文件锁 120 秒以上：
  // - 杀毒软件扫描
  // - Windows Search 索引器
  // - 内存映射文件（SurrealDB 的 SurrealKV、QuestDB 的列式存储）
  // - Java JVM 文件句柄清理（QuestDB）
  private async atomicMoveDirectory(
    sourcePath: string,
    targetPath: string,
  ): Promise<void> {
    const maxRetries = isWindows() ? 90 : 1 // 90 次重试 x 2 秒 = 最多 180 秒
    const retryDelay = 2000 // 每次重试间隔 2 秒

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 先尝试原子重命名（仅在相同文件系统上有效）
        await fsRename(sourcePath, targetPath)
        return // 成功
      } catch (error) {
        const e = error as NodeJS.ErrnoException
        if (e.code === 'EXDEV') {
          // 跨文件系统移动 —— 回退到复制+删除
          await cp(sourcePath, targetPath, { recursive: true })
          try {
            await rm(sourcePath, { recursive: true, force: true })
          } catch {
            // 如果复制后删除失败，我们会有重复项
            // 尝试清理目标以避免不一致
            await rm(targetPath, { recursive: true, force: true }).catch(
              () => {},
            )
            throw new Error(
              `移动未完成：源和目标可能同时存在。` +
                `请手动移除以下之一：${sourcePath} 或 ${targetPath}`,
            )
          }
          return // 成功
        } else if (e.code === 'EBUSY' && attempt < maxRetries) {
          // Windows：文件句柄可能仍被持有 —— 延迟后重试
          logDebug(
            `rename 尝试 ${attempt}/${maxRetries} 时遇到 EBUSY，${retryDelay}ms 后重试...`,
          )
          await new Promise((resolve) => setTimeout(resolve, retryDelay))
        } else {
          throw error
        }
      }
    }
  }

  isValidName(name: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
  }

  async addDatabase(containerName: string, database: string): Promise<void> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`未找到容器 "${containerName}"`)
    }

    // 确保 databases 数组存在
    if (!config.databases) {
      config.databases = [config.database]
    }

    // 如果不存在则添加
    if (!config.databases.includes(database)) {
      config.databases.push(database)
      await this.saveConfig(containerName, { engine: config.engine }, config)
    }
  }

  async removeDatabase(containerName: string, database: string): Promise<void> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`未找到容器 "${containerName}"`)
    }

    // 不要从数组中移除主数据库
    if (database === config.database) {
      throw new Error(
        `无法从跟踪列表中移除主数据库 "${database}"`,
      )
    }

    if (config.databases) {
      config.databases = config.databases.filter((db) => db !== database)
      await this.saveConfig(containerName, { engine: config.engine }, config)
    }
  }

  /**
   * 将 databases 数组与服务器上的实际数据库同步。
   * 查询数据库服务器获取所有用户数据库并更新注册表。
   *
   * @param containerName - 要同步的容器
   * @returns 更新后的数据库列表
   * @throws 如果容器未运行或不支持列出数据库，则抛出错误
   */
  async syncDatabases(containerName: string): Promise<string[]> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`未找到容器 "${containerName}"`)
    }

    // 基于文件的引擎没有多个数据库可以同步
    if (isFileBasedEngine(config.engine)) {
      return config.databases || [config.database]
    }

    // 远程容器：返回当前注册表（没有本地进程可以查询）
    if (isRemoteContainer(config)) {
      return config.databases || [config.database]
    }

    // 容器必须正在运行才能查询数据库
    const running = await processManager.isRunning(containerName, {
      engine: config.engine,
    })
    if (!running) {
      throw new Error(
        `容器 "${containerName}" 未运行。请先启动容器以同步数据库。`,
      )
    }

    const engine = getEngine(config.engine)

    // 查询实际的数据库服务器获取所有数据库
    let actualDatabases: string[]
    try {
      actualDatabases = await engine.listDatabases(config)
    } catch (error) {
      // 如果引擎不支持 listDatabases，返回当前注册表
      if (error instanceof UnsupportedOperationError) {
        logDebug(
          `${config.engine} 不支持 listDatabases，跳过同步`,
        )
        return config.databases || [config.database]
      }
      throw error
    }

    // 确保主数据库始终包含在内
    if (!actualDatabases.includes(config.database)) {
      actualDatabases = [config.database, ...actualDatabases]
    }

    // 排序以保持一致的顺序（主数据库在前，其余按字母排序）
    const sortedDatabases = [
      config.database,
      ...actualDatabases
        .filter((db) => db !== config.database)
        .sort((a, b) => a.localeCompare(b)),
    ]

    // 更新注册表
    config.databases = sortedDatabases
    await this.saveConfig(containerName, { engine: config.engine }, config)

    return sortedDatabases
  }

  getConnectionString(config: ContainerConfig, database?: string): string {
    const engine = getEngine(config.engine)
    return engine.getConnectionString(config, database)
  }
}

export const containerManager = new ContainerManager()

/**
 * 数据库重命名后更新跟踪记录。
 * 由 CLI 命令和交互式菜单处理程序共享。
 */
export async function updateRenameTracking(
  containerName: string,
  oldName: string,
  newName: string,
  options: { shouldDrop: boolean; isPrimaryRename: boolean },
): Promise<void> {
  const { shouldDrop, isPrimaryRename } = options

  await containerManager.addDatabase(containerName, newName)

  if (
    shouldDrop &&
    oldName !== (await containerManager.getConfig(containerName))?.database
  ) {
    await containerManager.removeDatabase(containerName, oldName)
  }

  if (isPrimaryRename) {
    await containerManager.updateConfig(containerName, { database: newName })
    if (shouldDrop) {
      const updatedConfig = await containerManager.getConfig(containerName)
      if (updatedConfig?.databases?.includes(oldName)) {
        await containerManager.removeDatabase(containerName, oldName)
      }
    }
  }
}
