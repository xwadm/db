/**
 * CouchDB 恢复模块
 * 支持使用 CouchDB 的 REST API 进行基于 JSON 的恢复
 */

import { readFile, open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { couchdbApiRequest } from './api-client'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

// 恢复操作可能需要比默认超时更长的时间
const RESTORE_TIMEOUT_MS = 600000 // 10 分钟

type CouchDBBackup = {
  version: string
  created: string
  databases: Array<{
    name: string
    docs: unknown[]
  }>
}

/**
 * 从文件检测备份格式
 * CouchDB 备份是 JSON 文件
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`备份文件未找到：${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: '检测到目录 - CouchDB 使用单个 JSON 文件',
      restoreCommand: 'CouchDB 恢复需要单个 .json 文件',
    }
  }

  // 检查文件扩展名
  if (filePath.endsWith('.json') || filePath.endsWith('.couchdb')) {
    return {
      format: 'json',
      description: 'CouchDB JSON 备份',
      restoreCommand: 'spindb restore 会自动处理此格式',
    }
  }

  // 检查文件内容是否为 JSON 结构
  try {
    const buffer = Buffer.alloc(100)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 100, 0)
      const content = buffer.toString('utf-8').trim()

      // 检查内容是否看起来像我们的备份格式
      if (content.startsWith('{') && content.includes('"version"')) {
        return {
          format: 'json',
          description: 'CouchDB JSON 备份（通过内容检测）',
          restoreCommand: 'spindb restore 会自动处理此格式',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`读取备份文件头时出错：${error}`)
  }

  return {
    format: 'unknown',
    description: '未知备份格式',
    restoreCommand: '请使用 .json 或 .couchdb 文件进行恢复',
  }
}

// CouchDB 恢复选项
export type RestoreOptions = {
  containerName?: string
  port: number
  database?: string
  flush?: boolean
}

/**
 * 从 JSON 备份恢复
 *
 * @param backupPath - 备份文件路径
 * @param options - 恢复选项，包括端口和可选的目标数据库
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database: targetDatabase, flush } = options
  const savedCreds = options.containerName
    ? await loadCredentials(
        options.containerName,
        Engine.CouchDB,
        getDefaultUsername(Engine.CouchDB),
      )
    : null
  const auth = savedCreds
    ? {
        username: savedCreds.username,
        password: savedCreds.password,
      }
    : undefined

  if (!existsSync(backupPath)) {
    throw new Error(`备份文件未找到：${backupPath}`)
  }

  // 检测备份格式
  const format = await detectBackupFormat(backupPath)
  logDebug(`检测到备份格式：${format.format}`)

  if (format.format !== 'json') {
    throw new Error(
      `无效的备份格式：${format.format}。请使用 .json 或 .couchdb 文件进行恢复。`,
    )
  }

  // 读取并解析备份文件
  const content = await readFile(backupPath, 'utf-8')
  let backup: CouchDBBackup

  try {
    backup = JSON.parse(content) as CouchDBBackup
  } catch (error) {
    throw new Error(`无效的备份文件：JSON 解析失败 - ${error}`)
  }

  if (!backup.databases || !Array.isArray(backup.databases)) {
    throw new Error('无效的备份文件：缺少 databases 数组')
  }

  logDebug(`正在从备份中恢复 ${backup.databases.length} 个数据库`)

  // CouchDB 的 chttpd HTTP 监听器在集群机制（mem3/fabric）完成引导之前
  // 就会响应 `GET /`。如果调用方传给我们一个刚启动的节点，首次数据库查询或 PUT
  // 可能会与初始化过程竞争，并返回 5xx（例如 `{"error":"no_majority"}`）。
  // 在接触任何真实数据之前，阻塞等待节点能够确定性地响应数据库查询。
  await waitForCouchDBReady(port, auth)

  let restoredCount = 0
  const errors: string[] = []

  for (const dbBackup of backup.databases) {
    // 如果指定了目标数据库且不是当前数据库，则跳过
    if (targetDatabase && dbBackup.name !== targetDatabase) {
      continue
    }

    const dbName = dbBackup.name
    logDebug(`正在恢复数据库：${dbName}（${dbBackup.docs.length} 个文档）`)

    // 检查数据库是否存在。对瞬态的集群初始化错误进行简短重试，
    // 以便区分“不存在”和“节点尚未就绪”。
    const checkResponse = await getDatabaseStatusWithRetry(port, dbName, auth)

    if (checkResponse.status === 200) {
      if (flush) {
        // 删除现有数据库
        const deleteResponse = await couchdbApiRequest(
          port,
          'DELETE',
          `/${encodeURIComponent(dbName)}`,
          undefined,
          undefined,
          auth,
        )
        // 接受 200（OK）或 202（已接受）用于异步删除
        if (deleteResponse.status !== 200 && deleteResponse.status !== 202) {
          errors.push(
            `删除现有数据库 ${dbName} 失败：${JSON.stringify(deleteResponse.data)}`,
          )
          continue
        }
      } else {
        logDebug(`数据库 ${dbName} 已存在，正在合并文档`)
      }
    } else if (checkResponse.status !== 404) {
      // 任何既不是 200（存在）也不是 404（干净）的状态都是硬故障 —
      // 绝不能静默地落入对不存在的数据库执行 bulk_docs 的逻辑分支。
      // 这正是原始 BUG-9 的陷阱：来自半初始化集群的 5xx 导致下面的 PUT 分支被跳过，
      // 恢复操作“成功”返回 code:1 stderr，而调用方测试看到的是空的数据库列表。
      errors.push(
        `检查数据库 ${dbName} 时出现意外状态码 ${checkResponse.status}：${JSON.stringify(checkResponse.data)}`,
      )
      continue
    }

    // 如果数据库不存在（或刚刚被删除），则创建它
    if (checkResponse.status === 404 || flush) {
      const createResponse = await couchdbApiRequest(
        port,
        'PUT',
        `/${encodeURIComponent(dbName)}`,
        undefined,
        undefined,
        auth,
      )
      if (createResponse.status !== 201 && createResponse.status !== 412) {
        // 412 表示数据库已存在，这是允许的
        errors.push(
          `创建数据库 ${dbName} 失败：${JSON.stringify(createResponse.data)}`,
        )
        continue
      }
    }

    // 准备文档以进行批量插入
    // 移除 _rev 以允许作为新文档插入
    const docsToInsert = dbBackup.docs.map((doc) => {
      const d = doc as Record<string, unknown>
      const { _rev: _, ...rest } = d
      return rest
    })

    if (docsToInsert.length === 0) {
      logDebug(`数据库 ${dbName} 没有需要恢复的文档`)
      restoredCount++
      continue
    }

    // 批量插入文档
    const bulkResponse = await couchdbApiRequest(
      port,
      'POST',
      `/${encodeURIComponent(dbName)}/_bulk_docs`,
      { docs: docsToInsert },
      RESTORE_TIMEOUT_MS,
      auth,
    )

    if (bulkResponse.status !== 201) {
      errors.push(
        `向数据库 ${dbName} 恢复文档失败：${JSON.stringify(bulkResponse.data)}`,
      )
      continue
    }

    restoredCount++
    logDebug(`已将 ${docsToInsert.length} 个文档恢复到 ${dbName}`)
  }

  const message =
    `已恢复 ${restoredCount} 个数据库` +
    (errors.length > 0 ? `，但有 ${errors.length} 个错误` : '')

  // 大声地暴露错误，而不是返回 code:1 让调用方误以为成功。
  // 静默地返回成功并附带 stderr 正是导致 BUG-9 在 macOS x64 的克隆集成测试中漏网的原因。
  if (errors.length > 0) {
    throw new Error(`CouchDB 恢复失败：${errors.join('; ')}`)
  }

  return {
    format: 'json',
    stdout: message,
    stderr: undefined,
    code: 0,
  }
}

/**
 * 轮询 CouchDB 直到节点完全引导完成并能响应数据库查询。
 * 结合 `/_up`（节点就绪后返回 `status:"ok"`）和对一个已知不存在的数据库的模拟 GET 请求
 * （必须返回 404 而非 5xx）。这种组合能证明 mem3/fabric 已经启动，而不仅仅是 chttpd。
 */
async function waitForCouchDBReady(
  port: number,
  auth: { username: string; password: string } | undefined,
  timeoutMs = 30000,
): Promise<void> {
  const startTime = Date.now()
  const checkInterval = 250
  let lastFailure = '未尝试探测'

  while (Date.now() - startTime < timeoutMs) {
    try {
      const up = await couchdbApiRequest(
        port,
        'GET',
        '/_up',
        undefined,
        5000,
        auth ?? null,
      )
      if (up.status === 200) {
        const data = up.data as { status?: string } | null
        if (data?.status === 'ok') {
          const probe = await couchdbApiRequest(
            port,
            'GET',
            '/_spindb_restore_probe',
            undefined,
            5000,
            auth ?? null,
          )
          if (probe.status === 404 || probe.status === 401) {
            return
          }
          lastFailure = `数据库查询探测返回 ${probe.status}`
        } else {
          lastFailure = `/_up 状态为 ${data?.status ?? 'undefined'}`
        }
      } else {
        lastFailure = `/_up 返回 ${up.status}`
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  throw new Error(
    `端口 ${port} 上的 CouchDB 在 ${timeoutMs}ms 内未就绪 ` +
      `（最后失败原因：${lastFailure}）`,
  )
}

/**
 * 发送 `GET /{db}` 并进行短暂重试。如果节点仍在稳定过程中，可能出现瞬态 5xx 响应 —
 * 我们不希望一次偶发的波动级联成静默的恢复失败。
 */
async function getDatabaseStatusWithRetry(
  port: number,
  dbName: string,
  auth: { username: string; password: string } | undefined,
  maxAttempts = 5,
): Promise<{ status: number; data: unknown }> {
  let lastResponse: { status: number; data: unknown } | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await couchdbApiRequest(
      port,
      'GET',
      `/${encodeURIComponent(dbName)}`,
      undefined,
      undefined,
      auth,
    )
    if (response.status === 200 || response.status === 404) {
      return response
    }
    lastResponse = response
    logDebug(
      `CouchDB GET /${dbName} 返回 ${response.status}，正在重试（${attempt + 1}/${maxAttempts}）`,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return lastResponse ?? { status: 0, data: null }
}

/**
 * 解析 CouchDB 连接字符串
 * 格式：http://host[:port][/database] 或 https://host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
  database?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('无效的 CouchDB 连接字符串：期望一个非空字符串')
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `无效的 CouchDB 连接字符串："${connectionString}"。` +
        `期望格式：http://host[:port][/database]`,
      { cause: error },
    )
  }

  // 验证协议
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `无效的 CouchDB 连接字符串：不支持的协议 "${url.protocol}"。` +
        `期望使用 "http://" 或 "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 5984

  // 从路径名中提取数据库（例如 /mydb）
  const pathname = url.pathname || ''
  const database =
    pathname.length > 1 ? pathname.slice(1).split('/')[0] : undefined

  return {
    host,
    port,
    protocol,
    database,
  }
}
