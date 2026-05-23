/**
 * SQLite 注册表管理器
 *
 * 与 PostgreSQL/MySQL 将容器存储在 ~/.spindb/containers/ 中不同，
 * SQLite 数据库存储在用户项目目录中。此注册表负责追踪 SpinDB 管理的
 * 所有 SQLite 数据库的文件路径。
 *
 * 注册表现在存储在 ~/.spindb/config.json 的 registry.sqlite 字段下。
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import type { SQLiteEngineRegistry, SQLiteRegistryEntry } from '../../types'

/**
 * SQLite 注册表管理器
 * 管理追踪外部 SQLite 数据库文件的注册表。
 * 数据存储在 config.json 的 registry.sqlite 字段下。
 */
class SQLiteRegistryManager {
  /**
   * 从 config.json 加载注册表。
   * 如果不存在则返回空注册表。
   */
  async load(): Promise<SQLiteEngineRegistry> {
    return configManager.getSqliteRegistry()
  }

  // 将注册表保存到 config.json
  async save(registry: SQLiteEngineRegistry): Promise<void> {
    await configManager.saveSqliteRegistry(registry)
  }

  /**
   * 向注册表添加新条目。
   * @throws 如果已存在同名容器或相同文件路径，则抛出错误。
   */
  async add(entry: SQLiteRegistryEntry): Promise<void> {
    const registry = await this.load()

    // 检查重复名称
    if (registry.entries.some((e) => e.name === entry.name)) {
      throw new Error(`SQLite 容器 "${entry.name}" 已存在`)
    }

    // 检查重复文件路径
    if (registry.entries.some((e) => e.filePath === entry.filePath)) {
      throw new Error(
        `路径 "${entry.filePath}" 对应的 SQLite 容器已存在`,
      )
    }

    registry.entries.push(entry)
    await this.save(registry)
  }

  /**
   * 按名称获取条目。
   * 如果未找到则返回 null。
   */
  async get(name: string): Promise<SQLiteRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.name === name) || null
  }

  /**
   * 按名称移除条目。
   * 如果找到并移除则返回 true，否则返回 false。
   */
  async remove(name: string): Promise<boolean> {
    const registry = await this.load()
    const index = registry.entries.findIndex((e) => e.name === name)

    if (index === -1) {
      return false
    }

    registry.entries.splice(index, 1)
    await this.save(registry)
    return true
  }

  /**
   * 更新现有条目。
   * 如果找到并更新则返回 true，否则返回 false。
   */
  async update(
    name: string,
    updates: Partial<Omit<SQLiteRegistryEntry, 'name'>>,
  ): Promise<boolean> {
    const registry = await this.load()
    const entry = registry.entries.find((e) => e.name === name)

    if (!entry) {
      return false
    }

    Object.assign(entry, updates)
    await this.save(registry)
    return true
  }

  // 列出注册表中的所有条目
  async list(): Promise<SQLiteRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries
  }

  // 检查是否存在指定名称的容器
  async exists(name: string): Promise<boolean> {
    const entry = await this.get(name)
    return entry !== null
  }

  // 查找孤立条目（文件已不存在的条目）
  async findOrphans(): Promise<SQLiteRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries.filter((e) => !existsSync(e.filePath))
  }

  /**
   * 从注册表中移除所有孤立条目。
   * 返回移除的条目数量。
   */
  async removeOrphans(): Promise<number> {
    const registry = await this.load()
    const originalCount = registry.entries.length

    registry.entries = registry.entries.filter((e) => existsSync(e.filePath))

    const removedCount = originalCount - registry.entries.length
    if (removedCount > 0) {
      await this.save(registry)
    }

    return removedCount
  }

  // 更新条目的最后验证时间戳
  async updateVerified(name: string): Promise<void> {
    await this.update(name, { lastVerified: new Date().toISOString() })
  }

  // 检查某个文件路径是否已被任何容器注册
  async isPathRegistered(filePath: string): Promise<boolean> {
    const registry = await this.load()
    return registry.entries.some((e) => e.filePath === filePath)
  }

  /**
   * 根据文件路径获取对应的容器名称。
   * 如果未找到则返回 null。
   */
  async getByPath(filePath: string): Promise<SQLiteRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.filePath === filePath) || null
  }

  // ============================================================
  // 文件夹忽略方法
  // ============================================================

  // 检查某个文件夹是否在忽略列表中
  async isFolderIgnored(folderPath: string): Promise<boolean> {
    const registry = await this.load()
    return folderPath in registry.ignoreFolders
  }

  // 将文件夹添加到忽略列表
  async addIgnoreFolder(folderPath: string): Promise<void> {
    const registry = await this.load()
    registry.ignoreFolders[folderPath] = true
    await this.save(registry)
  }

  /**
   * 从忽略列表中移除文件夹。
   * 如果文件夹在列表中并被移除则返回 true，否则返回 false。
   */
  async removeIgnoreFolder(folderPath: string): Promise<boolean> {
    const registry = await this.load()
    if (folderPath in registry.ignoreFolders) {
      delete registry.ignoreFolders[folderPath]
      await this.save(registry)
      return true
    }
    return false
  }

  // 列出所有被忽略的文件夹
  async listIgnoredFolders(): Promise<string[]> {
    const registry = await this.load()
    return Object.keys(registry.ignoreFolders)
  }
}

// 导出单例实例
export const sqliteRegistry = new SQLiteRegistryManager()