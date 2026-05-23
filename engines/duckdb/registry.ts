/**
 * DuckDB 注册表管理器
 *
 * 与 PostgreSQL/MySQL 将容器存储在 ~/.spindb/containers/ 不同，
 * DuckDB 数据库存储在用户的工程目录中。本注册表负责追踪所有由
 * SpinDB 管理的 DuckDB 数据库文件路径。
 *
 * 注册表数据存储在 ~/.spindb/config.json 的 registry.duckdb 字段下。
 *
 * 注意：数据变更操作使用基于文件的锁机制，以防止多进程并发访问
 * 注册表时出现竞态条件。
 */

import { existsSync } from 'fs'
import { mkdir, writeFile, unlink, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { configManager } from '../../core/config-manager'
import { paths } from '../../config/paths'
import type { DuckDBEngineRegistry, DuckDBRegistryEntry } from '../../types'

// 锁文件配置
const LOCK_STALE_MS = 10000 // 锁超过 10 秒视为过期
const LOCK_RETRY_MS = 50 // 等待锁时的重试间隔
const LOCK_TIMEOUT_MS = 5000 // 等待锁的最大时长

/**
 * 用于注册表变更操作的简单基于文件的锁。
 * 通过原子文件创建保证互斥访问。
 */
class RegistryLock {
  private lockPath: string

  constructor() {
    this.lockPath = join(paths.root, '.duckdb-registry.lock')
  }

  /**
   * 获取锁，必要时等待。
   * 返回释放函数，完成操作后必须调用。
   */
  async acquire(): Promise<() => Promise<void>> {
    const startTime = Date.now()

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        // 检查现有锁是否过期
        if (existsSync(this.lockPath)) {
          try {
            const lockStat = await stat(this.lockPath)
            const lockAge = Date.now() - lockStat.mtimeMs
            if (lockAge > LOCK_STALE_MS) {
              // 锁已过期，移除
              await unlink(this.lockPath).catch(() => {})
            }
          } catch {
            // 锁文件已消失，继续尝试获取
          }
        }

        // 确保父目录存在
        await mkdir(dirname(this.lockPath), { recursive: true })

        // 尝试排他性创建锁文件
        // 使用 'wx' 标志：排他创建，已存在则失败
        await writeFile(this.lockPath, String(process.pid), { flag: 'wx' })

        // 成功获取锁
        return async () => {
          await unlink(this.lockPath).catch(() => {})
        }
      } catch (err) {
        const error = err as NodeJS.ErrnoException
        if (error.code === 'EEXIST') {
          // 锁已存在，等待后重试
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
        } else {
          throw err
        }
      }
    }

    throw new Error(
      `获取 DuckDB 注册表锁超时（超过 ${LOCK_TIMEOUT_MS}ms）`,
    )
  }
}

const registryLock = new RegistryLock()

/**
 * DuckDB 注册表管理器
 * 管理追踪外部 DuckDB 数据库文件的注册表
 * 数据存储在 config.json 的 registry.duckdb 字段下
 */
class DuckDBRegistryManager {
  /**
   * 从 config.json 加载注册表
   * 若不存在则返回空注册表
   */
  async load(): Promise<DuckDBEngineRegistry> {
    return configManager.getDuckDBRegistry()
  }

  // 将注册表保存到 config.json
  async save(registry: DuckDBEngineRegistry): Promise<void> {
    await configManager.saveDuckDBRegistry(registry)
  }

  /**
   * 向注册表中添加新条目
   * @throws 若同名容器或相同文件路径已存在则抛出错误
   */
  async add(entry: DuckDBRegistryEntry): Promise<void> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()

      // 检查名称是否重复
      if (registry.entries.some((e) => e.name === entry.name)) {
        throw new Error(`DuckDB 容器 "${entry.name}" 已存在`)
      }

      // 检查文件路径是否重复
      if (registry.entries.some((e) => e.filePath === entry.filePath)) {
        throw new Error(
          `路径 "${entry.filePath}" 对应的 DuckDB 容器已存在`,
        )
      }

      registry.entries.push(entry)
      await this.save(registry)
    } finally {
      await release()
    }
  }

  /**
   * 按名称获取条目
   * 若未找到则返回 null
   */
  async get(name: string): Promise<DuckDBRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.name === name) || null
  }

  /**
   * 按名称移除条目
   * 若找到并移除则返回 true，否则返回 false
   */
  async remove(name: string): Promise<boolean> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const index = registry.entries.findIndex((e) => e.name === name)

      if (index === -1) {
        return false
      }

      registry.entries.splice(index, 1)
      await this.save(registry)
      return true
    } finally {
      await release()
    }
  }

  /**
   * 更新现有条目
   * 若找到并更新则返回 true，否则返回 false
   */
  async update(
    name: string,
    updates: Partial<Omit<DuckDBRegistryEntry, 'name'>>,
  ): Promise<boolean> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const entry = registry.entries.find((e) => e.name === name)

      if (!entry) {
        return false
      }

      Object.assign(entry, updates)
      await this.save(registry)
      return true
    } finally {
      await release()
    }
  }

  // 列出注册表中的所有条目
  async list(): Promise<DuckDBRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries
  }

  // 检查指定名称的容器是否存在
  async exists(name: string): Promise<boolean> {
    const entry = await this.get(name)
    return entry !== null
  }

  // 查找孤立的条目（对应文件已不存在）
  async findOrphans(): Promise<DuckDBRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries.filter((e) => !existsSync(e.filePath))
  }

  /**
   * 从注册表中移除所有孤立条目
   * 返回被移除的条目数量
   */
  async removeOrphans(): Promise<number> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const originalCount = registry.entries.length

      registry.entries = registry.entries.filter((e) => existsSync(e.filePath))

      const removedCount = originalCount - registry.entries.length
      if (removedCount > 0) {
        await this.save(registry)
      }

      return removedCount
    } finally {
      await release()
    }
  }

  // 更新某个条目的 lastVerified 时间戳
  async updateVerified(name: string): Promise<void> {
    await this.update(name, { lastVerified: new Date().toISOString() })
  }

  // 检查某个文件路径是否已被注册（任意容器）
  async isPathRegistered(filePath: string): Promise<boolean> {
    const registry = await this.load()
    return registry.entries.some((e) => e.filePath === filePath)
  }

  /**
   * 根据文件路径获取对应的容器名称
   * 若未找到则返回 null
   */
  async getByPath(filePath: string): Promise<DuckDBRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.filePath === filePath) || null
  }

  // ============================================================
  // 文件夹忽略相关方法
  // ============================================================

  // 检查某个文件夹是否在忽略列表中
  async isFolderIgnored(folderPath: string): Promise<boolean> {
    const registry = await this.load()
    return folderPath in registry.ignoreFolders
  }

  // 将文件夹加入忽略列表
  async addIgnoreFolder(folderPath: string): Promise<void> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      registry.ignoreFolders[folderPath] = true
      await this.save(registry)
    } finally {
      await release()
    }
  }

  /**
   * 从忽略列表中移除文件夹
   * 若文件夹在列表中且已移除则返回 true，否则返回 false
   */
  async removeIgnoreFolder(folderPath: string): Promise<boolean> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      if (folderPath in registry.ignoreFolders) {
        delete registry.ignoreFolders[folderPath]
        await this.save(registry)
        return true
      }
      return false
    } finally {
      await release()
    }
  }

  // 列出所有被忽略的文件夹
  async listIgnoredFolders(): Promise<string[]> {
    const registry = await this.load()
    return Object.keys(registry.ignoreFolders)
  }
}

// 导出单例实例
export const duckdbRegistry = new DuckDBRegistryManager()