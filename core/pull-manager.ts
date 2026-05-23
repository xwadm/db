/**
 * 拉取管理器
 *
 * 处理将远程数据库数据拉取到本地容器。
 * 支持两种模式：
 * - 替换模式（默认）：备份原始数据，然后替换为远程数据
 * - 克隆模式（--as 标志）：使用远程数据创建新数据库
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { unlink, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { withTransaction } from './transaction-manager'
import { containerManager } from './container-manager'
import { getEngine } from '../engines'
import { logDebug } from './error-handler'
import type { ContainerConfig, PullOptions, PullResult, Engine } from '../types'
import type { BaseEngine } from '../engines/base-engine'
import { getDefaultFormat } from '../config/backup-formats'

/**
 * 通过 SPINDB_CONTEXT 环境变量传递给拉取后脚本的上下文。
 * 脚本可以读取此 JSON 文件以获取连接字符串和元数据。
 */
export type PullContext = {
  container: string
  engine: Engine
  mode: 'replace' | 'clone'
  port: number
  /** 包含新（远程）数据的数据库 */
  newDatabase: string
  /** 新数据库的连接字符串 */
  newUrl: string
  /** 包含原始数据的备份数据库（仅替换模式） */
  originalDatabase?: string
  /** 原始/备份数据库的连接字符串（仅替换模式） */
  originalUrl?: string
}

export class PullManager {
  /**
   * 将远程数据库数据拉取到本地容器
   */
  async pull(containerName: string, options: PullOptions): Promise<PullResult> {
    // 1. 获取并验证容器
    const config = await containerManager.getConfig(containerName)
    if (!config) {
      throw new Error(`容器 "${containerName}" 未找到`)
    }
    if (config.status !== 'running') {
      throw new Error(
        `容器 "${containerName}" 未运行。请执行: spindb start ${containerName}`,
      )
    }

    const engine = getEngine(config.engine)
    const timestamp = this.generateTimestamp()

    // 2. 确定模式和目标数据库
    const isCloneMode = !!options.asDatabase
    const targetDatabase = isCloneMode
      ? options.asDatabase!
      : options.database || config.database

    // 3. 验证
    if (!isCloneMode) {
      // 替换模式：目标必须存在
      const exists = await this.databaseExists(config, targetDatabase)
      if (!exists) {
        throw new Error(`数据库 "${targetDatabase}" 不存在`)
      }
    } else {
      // 克隆模式：目标必须不存在（除非使用 --force）
      const exists = await this.databaseExists(config, targetDatabase)
      if (exists && !options.force) {
        throw new Error(
          `数据库 "${targetDatabase}" 已存在。使用 --force 覆盖。`,
        )
      }
    }

    // 4. 试运行
    if (options.dryRun) {
      return this.dryRunResult(
        config,
        engine,
        targetDatabase,
        timestamp,
        options,
        isCloneMode,
      )
    }

    // 5. 使用事务执行
    if (isCloneMode) {
      return this.executeCloneMode(config, engine, targetDatabase, options)
    } else {
      return this.executeReplaceMode(
        config,
        engine,
        targetDatabase,
        timestamp,
        options,
      )
    }
  }

  private async executeReplaceMode(
    config: ContainerConfig,
    engine: BaseEngine,
    targetDatabase: string,
    timestamp: string,
    options: PullOptions,
  ): Promise<PullResult> {
    const backupDatabase = `${targetDatabase}_${timestamp}`
    const tempOriginalDump = join(tmpdir(), `spindb-orig-${timestamp}.dump`)
    const tempRemoteDump = join(tmpdir(), `spindb-remote-${timestamp}.dump`)

    // 如果有拉取后脚本则始终创建备份（以便脚本可以访问原始数据）
    // 否则，仅在未指定 --no-backup 时创建备份
    const needsBackup = !options.noBackup || !!options.postScript
    // 跟踪是否在最终结果中保留备份（用户未指定 --no-backup）
    const keepBackup = !options.noBackup

    const result = await withTransaction(async (tx) => {
      // --- 备份原始数据（如果有拉取后脚本则始终备份，否则仅在未指定 --no-backup 时备份） ---
      if (needsBackup) {
        // 步骤 1：创建备份数据库
        logDebug(`创建备份数据库: ${backupDatabase}`)
        await engine.createDatabase(config, backupDatabase)
        tx.addRollback({
          description: `删除备份数据库 "${backupDatabase}"`,
          execute: async () => {
            try {
              await engine.dropDatabase(config, backupDatabase)
            } catch {
              // 忽略错误
            }
          },
        })

        // 步骤 2：将原始数据导出到临时文件（使用现有备份方法）
        logDebug(`导出原始数据库到: ${tempOriginalDump}`)
        await engine.backup(config, tempOriginalDump, {
          database: targetDatabase,
          format: getDefaultFormat(config.engine),
        })
        tx.addRollback({
          description: '删除原始导出临时文件',
          execute: async () => {
            try {
              await unlink(tempOriginalDump)
            } catch {
              // 忽略错误
            }
          },
        })

        // 步骤 3：将原始数据恢复到备份中
        logDebug(`将原始数据恢复到备份数据库: ${backupDatabase}`)
        await engine.restore(config, tempOriginalDump, {
          database: backupDatabase,
          createDatabase: false,
        })
      }

      // --- 拉取远程数据 ---

      // 步骤 4：将远程数据导出到临时文件
      logDebug(`导出远程数据库到: ${tempRemoteDump}`)
      await engine.dumpFromConnectionString(options.fromUrl, tempRemoteDump)
      tx.addRollback({
        description: '删除远程导出临时文件',
        execute: async () => {
          try {
            await unlink(tempRemoteDump)
          } catch {
            // 忽略错误
          }
        },
      })

      // 步骤 5：终止到原始数据库的连接
      logDebug(`终止到以下数据库的连接: ${targetDatabase}`)
      await engine.terminateConnections(config, targetDatabase)

      // 步骤 6：删除原始数据库
      logDebug(`删除原始数据库: ${targetDatabase}`)
      await engine.dropDatabase(config, targetDatabase)
      tx.addRollback({
        description: `从备份恢复原始数据库 "${targetDatabase}"`,
        execute: async () => {
          if (needsBackup) {
            // 从备份恢复
            try {
              await engine.createDatabase(config, targetDatabase)
              await engine.restore(config, tempOriginalDump, {
                database: targetDatabase,
                createDatabase: false,
              })
            } catch {
              // 忽略错误
            }
          }
        },
      })

      // 步骤 7：创建全新的原始数据库
      logDebug(`创建全新数据库: ${targetDatabase}`)
      await engine.createDatabase(config, targetDatabase)

      // 步骤 8：将远程数据恢复到原始数据库
      logDebug(`将远程数据恢复到: ${targetDatabase}`)
      await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
      })

      // 步骤 9：清理临时文件
      try {
        await unlink(tempOriginalDump)
      } catch {
        // 忽略错误
      }
      try {
        await unlink(tempRemoteDump)
      } catch {
        // 忽略错误
      }

      // 步骤 10：如果提供了拉取后脚本则执行
      if (options.postScript) {
        const context: PullContext = {
          container: config.name,
          engine: config.engine,
          mode: 'replace',
          port: config.port,
          newDatabase: targetDatabase,
          newUrl: engine.getConnectionString(config, targetDatabase),
          originalDatabase: backupDatabase,
          originalUrl: engine.getConnectionString(config, backupDatabase),
        }

        await this.runPostScript(options.postScript, context)

        // 如果指定了 --no-backup，在脚本成功后删除临时备份
        if (!keepBackup) {
          logDebug(`删除临时备份数据库: ${backupDatabase}`)
          try {
            await engine.terminateConnections(config, backupDatabase)
            await engine.dropDatabase(config, backupDatabase)
          } catch {
            // 忽略错误 - 备份清理为尽力而为
          }
        }
      }

      return {
        success: true,
        mode: 'replace' as const,
        container: config.name,
        port: config.port,
        database: targetDatabase,
        databaseUrl: engine.getConnectionString(config, targetDatabase),
        backupDatabase: keepBackup ? backupDatabase : undefined,
        backupUrl: keepBackup
          ? engine.getConnectionString(config, backupDatabase)
          : undefined,
        source: this.redactUrl(options.fromUrl),
        message: keepBackup
          ? `已将远程数据拉取到 "${targetDatabase}"，备份位于 "${backupDatabase}"`
          : `已将远程数据拉取到 "${targetDatabase}"`,
      }
    })

    // 事务提交后，将注册表与服务器上的实际数据库同步
    // 这会捕获备份数据库（如果保留）和其他数据库
    // 用 try/catch 包裹以避免临时故障影响主拉取结果
    try {
      await containerManager.syncDatabases(config.name)
    } catch (error) {
      logDebug(
        `同步 "${config.name}" 的数据库失败: ${error instanceof Error ? error.message : error}`,
      )
    }

    return result
  }

  private async executeCloneMode(
    config: ContainerConfig,
    engine: BaseEngine,
    targetDatabase: string,
    options: PullOptions,
  ): Promise<PullResult> {
    const timestamp = this.generateTimestamp()
    const tempRemoteDump = join(tmpdir(), `spindb-remote-${timestamp}.dump`)

    return withTransaction(async (tx) => {
      // 步骤 1：如果目标存在则删除（需要 --force）
      if (options.force) {
        try {
          await engine.terminateConnections(config, targetDatabase)
          await engine.dropDatabase(config, targetDatabase)
        } catch {
          // 忽略错误
        }
      }

      // 步骤 2：创建目标数据库
      logDebug(`创建目标数据库: ${targetDatabase}`)
      await engine.createDatabase(config, targetDatabase)
      tx.addRollback({
        description: `删除目标数据库 "${targetDatabase}"`,
        execute: async () => {
          try {
            await engine.dropDatabase(config, targetDatabase)
          } catch {
            // 忽略错误
          }
        },
      })

      // 步骤 3：将远程数据导出到临时文件
      logDebug(`导出远程数据库到: ${tempRemoteDump}`)
      await engine.dumpFromConnectionString(options.fromUrl, tempRemoteDump)
      tx.addRollback({
        description: '删除远程导出临时文件',
        execute: async () => {
          try {
            await unlink(tempRemoteDump)
          } catch {
            // 忽略错误
          }
        },
      })

      // 步骤 4：将远程数据恢复到目标数据库
      logDebug(`将远程数据恢复到: ${targetDatabase}`)
      await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
      })

      // 步骤 5：清理
      try {
        await unlink(tempRemoteDump)
      } catch {
        // 忽略错误
      }

      // 步骤 6：如果提供了拉取后脚本则执行
      if (options.postScript) {
        const context: PullContext = {
          container: config.name,
          engine: config.engine,
          mode: 'clone',
          port: config.port,
          newDatabase: targetDatabase,
          newUrl: engine.getConnectionString(config, targetDatabase),
          // 克隆模式没有原始数据库（我们正在创建新数据库）
        }

        await this.runPostScript(options.postScript, context)
      }

      // 步骤 7：将注册表与服务器上的实际数据库同步
      // 用 try/catch 包裹以避免临时故障导致成功的克隆回滚
      try {
        await containerManager.syncDatabases(config.name)
      } catch (error) {
        logDebug(
          `同步 "${config.name}" 的数据库失败: ${error instanceof Error ? error.message : error}`,
        )
      }

      return {
        success: true,
        mode: 'clone' as const,
        container: config.name,
        port: config.port,
        database: targetDatabase,
        databaseUrl: engine.getConnectionString(config, targetDatabase),
        source: this.redactUrl(options.fromUrl),
        message: `已将远程数据克隆到新数据库 "${targetDatabase}"`,
      }
    })
  }

  private async runPostScript(
    scriptPath: string,
    context: PullContext,
  ): Promise<void> {
    logDebug(`执行拉取后脚本: ${scriptPath}`)

    // 将上下文写入临时 JSON 文件，以便脚本可以读取
    const contextFile = join(
      tmpdir(),
      `spindb-context-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    )
    await writeFile(contextFile, JSON.stringify(context, null, 2), 'utf-8')

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(scriptPath, [], {
          env: {
            ...process.env,
            // 新增：包含连接字符串的 JSON 上下文文件
            SPINDB_CONTEXT: contextFile,
            // 向后兼容的旧环境变量
            SPINDB_CONTAINER: context.container,
            SPINDB_DATABASE: context.newDatabase,
            SPINDB_BACKUP_DATABASE: context.originalDatabase || '',
            SPINDB_PORT: String(context.port),
            SPINDB_ENGINE: context.engine,
          },
          stdio: 'inherit',
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`拉取后脚本以退出码 ${code} 结束`))
          }
        })

        proc.on('error', reject)
      })
    } finally {
      // 清理上下文文件
      try {
        await unlink(contextFile)
      } catch {
        // 忽略错误
      }
    }
  }

  private generateTimestamp(): string {
    const now = new Date()
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
  }

  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    } catch {
      return '[无效的 URL]'
    }
  }

  /**
   * 检查数据库是否在 SpinDB 的跟踪中存在。
   *
   * 注意：此方法仅检查 SpinDB 跟踪的数据库，而非实际的数据库服务器。
   * 在 SpinDB 外部创建的数据库（例如通过 psql）不会被检测到。
   * 使用 `spindb databases add` 来跟踪外部创建的数据库。
   */
  private async databaseExists(
    config: ContainerConfig,
    database: string,
  ): Promise<boolean> {
    const tracked = config.databases || [config.database]
    if (tracked.includes(database)) return true

    // 同时检查是否为主数据库
    if (database === config.database) return true

    return false
  }

  private dryRunResult(
    config: ContainerConfig,
    engine: BaseEngine,
    database: string,
    timestamp: string,
    options: PullOptions,
    isCloneMode: boolean,
  ): PullResult {
    const backupDatabase = isCloneMode ? undefined : `${database}_${timestamp}`
    const keepBackup = !options.noBackup && !isCloneMode
    return {
      success: true,
      mode: isCloneMode ? 'clone' : 'replace',
      container: config.name,
      port: config.port,
      database,
      databaseUrl: engine.getConnectionString(config, database),
      backupDatabase: keepBackup ? backupDatabase : undefined,
      backupUrl: keepBackup
        ? engine.getConnectionString(config, backupDatabase!)
        : undefined,
      source: this.redactUrl(options.fromUrl),
      message: '[试运行] 未做任何更改',
    }
  }
}

export const pullManager = new PullManager()
