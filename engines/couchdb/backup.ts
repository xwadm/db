/**
 * CouchDB 备份模块
 * 支持通过 CouchDB 的 REST API 进行基于 JSON 的备份
 *
 * CouchDB 备份策略：
 * - 使用 _all_docs?include_docs=true 导出每个数据库的所有文档
 * - 存储为包含数据库及文档元数据的 JSON 文件
 */

import { mkdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { couchdbApiRequest } from './api-client'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

// 备份操作可能比默认超时时间更长
const BACKUP_TIMEOUT_MS = 600000 // 10 分钟

type CouchDBBackup = {
  version: string
  created: string
  databases: Array<{
    name: string
    docs: unknown[]
  }>
}

/**
 * 使用 CouchDB 的 REST API 创建所有数据库的 JSON 备份
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port } = container
  const targetDatabase = options.database
  const savedCreds = await loadCredentials(
    name,
    Engine.CouchDB,
    getDefaultUsername(Engine.CouchDB),
  )
  const auth = savedCreds
    ? {
        username: savedCreds.username,
        password: savedCreds.password,
      }
    : undefined

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 获取 CouchDB 版本信息
  const infoResponse = await couchdbApiRequest(
    port,
    'GET',
    '/',
    undefined,
    undefined,
    auth,
  )
  const serverInfo = infoResponse.data as { version?: string }
  const serverVersion = serverInfo?.version || 'unknown'

  // 获取要备份的数据库列表
  let databasesToBackup: string[]

  if (targetDatabase) {
    // 备份指定数据库
    databasesToBackup = [targetDatabase]
  } else {
    // 备份所有用户数据库（排除系统数据库）
    const dbsResponse = await couchdbApiRequest(
      port,
      'GET',
      '/_all_dbs',
      undefined,
      undefined,
      auth,
    )
    if (dbsResponse.status !== 200) {
      throw new Error(`列出数据库失败：${JSON.stringify(dbsResponse.data)}`)
    }
    const allDbs = dbsResponse.data as string[]
    // 过滤掉系统数据库（以下划线开头的）
    databasesToBackup = allDbs.filter((db) => !db.startsWith('_'))
  }

  logDebug(`正在备份 ${databasesToBackup.length} 个数据库`)

  // 从每个数据库中导出文档
  const backup: CouchDBBackup = {
    version: serverVersion,
    created: new Date().toISOString(),
    databases: [],
  }

  for (const dbName of databasesToBackup) {
    logDebug(`正在导出数据库：${dbName}`)

    const docsResponse = await couchdbApiRequest(
      port,
      'GET',
      `/${encodeURIComponent(dbName)}/_all_docs?include_docs=true`,
      undefined,
      BACKUP_TIMEOUT_MS,
      auth,
    )

    if (docsResponse.status !== 200) {
      throw new Error(
        `导出数据库 ${dbName} 失败：${JSON.stringify(docsResponse.data)}`,
      )
    }

    const docsData = docsResponse.data as {
      rows?: Array<{ doc?: unknown }>
    }
    const docs =
      docsData.rows
        ?.map((row) => row.doc)
        .filter((doc): doc is unknown => doc !== undefined) || []

    // 过滤掉设计文档以获得更干净的备份（以 _design/ 开头的）
    const userDocs = docs.filter((doc) => {
      const d = doc as { _id?: string }
      return d._id && !d._id.startsWith('_design/')
    })

    backup.databases.push({
      name: dbName,
      docs: userDocs,
    })
  }

  // 将备份写入文件
  await writeFile(outputPath, JSON.stringify(backup, null, 2))

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'json',
    size: stats.size,
  }
}

/**
 * 为克隆操作创建备份
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  // 备份所有数据库以用于克隆
  return createBackup(container, outputPath, { database: '' })
}
