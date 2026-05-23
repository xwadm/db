/**
 * 从 hostdb 获取元数据（databases.json 和 downloads.json）
 * 以了解每个引擎需要哪些工具以及如何安装它们。
 *
 * 主注册表：registry.layerbase.host
 * 回退注册表：GitHub raw (robertjbass/hostdb)
 *
 * 架构：
 * - databases.json: 列出每个引擎的服务器、客户端、实用工具和增强型 CLI 工具
 * - downloads.json: 提供用于安装工具的包管理器命令
 */

import {
  loadDatabasesJson as hostdbLoadDatabasesJson,
  loadDownloadsJson as hostdbLoadDownloadsJson,
} from 'hostdb'
import { logDebug } from './error-handler'
import { LAYERBASE_REGISTRY_BASE } from './hostdb-client'
import type { Engine } from '../types'

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟（仅网络回退）

type CliTools = {
  server: string | null
  client: string | null
  utilities: string[]
  enhanced: string[]
}

export type VersionEntryObject = {
  enabled?: boolean
  deprecated?: boolean
  note?: string
  platforms?: string[]
  dependencies?: Array<{
    database: string
    cascadeDelete: boolean
    note?: string
  }>
  cliTools?: CliTools
}

type DatabaseEntry = {
  displayName: string
  cliTools: CliTools
  versions: Record<string, boolean | VersionEntryObject>
  platforms?: string[]
  dependencies?: Array<{
    database: string
    cascadeDelete: boolean
    note?: string
  }>
  spindbStatus?: string
  hostedServiceAllowed?: boolean
}

type PackageManagerDef = {
  name: string
  platforms: string[]
  installCmd: string
  checkCmd: string
}

type ToolPackageInfo = {
  package: string
  tap?: string // Homebrew tap
  repo?: string // apt 仓库
}

type ToolDownloadInfo = {
  packages?: {
    brew?: ToolPackageInfo
    apt?: ToolPackageInfo
    yum?: ToolPackageInfo
    dnf?: ToolPackageInfo
    choco?: ToolPackageInfo
  }
}

// databases.json 可能直接以引擎名称为键（旧版）
// 或包装在 "databases" 键下（当前 schema）
type DatabasesJson = Record<string, DatabaseEntry>

type DownloadsJson = {
  packageManagers: Record<string, PackageManagerDef>
  tools: Record<string, ToolDownloadInfo>
}

// 简单的内存缓存。
// `databasesCache` / `downloadsCache` 保存结果，避免在每次调用时重新解析
// 捆绑的 JSON（或重新获取网络回退）。`timestamp`
// 仅对网络路径有意义 —— 捆绑读取写入 `Infinity`，因此
// 条目在进程内永不过期。
let databasesCache: { data: DatabasesJson; timestamp: number } | null = null
let downloadsCache: { data: DownloadsJson; timestamp: number } | null = null

// 进行中的请求去重，防止对同一 URL 的并行获取
const inFlightRequests = new Map<string, Promise<unknown>>()

async function fetchWithCache<T>(
  urls: string[],
  getCache: () => { data: T; timestamp: number } | null,
  setCache: (cache: { data: T; timestamp: number }) => void,
  transform?: (raw: Record<string, unknown>) => T,
): Promise<T> {
  // 使用 getter 始终检查最新的缓存状态
  const cache = getCache()
  const now = Date.now()
  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  // 使用主 URL 作为键检查进行中的请求
  const cacheKey = urls[0]
  const inFlight = inFlightRequests.get(cacheKey)
  if (inFlight) {
    return inFlight as Promise<T>
  }

  // 创建获取 promise —— 按顺序尝试每个 URL
  const fetchPromise = (async () => {
    try {
      let lastError: Error | null = null
      for (const url of urls) {
        try {
          const response = await fetch(url)
          if (!response.ok) {
            throw new Error(`获取 ${url} 失败: ${response.status}`)
          }

          const raw = await response.json()
          const data = transform
            ? transform(raw as Record<string, unknown>)
            : (raw as T)
          setCache({ data, timestamp: Date.now() })
          return data
        } catch (error) {
          lastError = error as Error
          logDebug(`从 ${url} 获取元数据失败: ${lastError.message}`)
        }
      }
      throw lastError ?? new Error('所有元数据 URL 均失败')
    } finally {
      inFlightRequests.delete(cacheKey)
    }
  })()

  inFlightRequests.set(cacheKey, fetchPromise)
  return fetchPromise
}

/**
 * 解包 databases.json schema：当前 schema 将引擎包装在 "databases" 键下，
 * 旧版 schema 将引擎放在顶层。两种格式均兼容。
 */
export function unwrapDatabasesJson(
  raw: Record<string, unknown>,
): DatabasesJson {
  if (
    raw.databases &&
    typeof raw.databases === 'object' &&
    !Array.isArray(raw.databases)
  ) {
    return raw.databases as DatabasesJson
  }
  return raw as DatabasesJson
}

/**
 * 返回已安装的 `hostdb` npm 包中捆绑的 databases.json。
 *
 * 无需网络：hostdb 发布的 tarball 包含在发布时构建的 databases.json 快照。
 * SpinDB 依赖于固定版本的 hostdb，因此对于任何给定的 SpinDB 构建，
 * 快照是确定性的。下面的 5 分钟网络缓存 + 获取回退仅作为防御措施，
 * 以防捆绑文件加载失败（例如安装损坏）。
 */
export async function fetchDatabasesJson(): Promise<DatabasesJson> {
  if (databasesCache) return databasesCache.data
  try {
    const raw = hostdbLoadDatabasesJson() as unknown as Record<string, unknown>
    const data = unwrapDatabasesJson(raw)
    databasesCache = { data, timestamp: Infinity }
    return data
  } catch (error) {
    logDebug('回退到网络获取 databases.json', {
      error: error instanceof Error ? error.message : String(error),
    })
    return fetchWithCache(
      [
        `${LAYERBASE_REGISTRY_BASE}/databases.json`,
        `${GITHUB_RAW_BASE}/databases.json`,
      ],
      () => databasesCache,
      (c) => {
        databasesCache = c
      },
      unwrapDatabasesJson,
    )
  }
}

/**
 * 返回已安装的 `hostdb` npm 包中捆绑的 downloads.json。
 * 与 fetchDatabasesJson 相同的离线保证 —— 网络回退仅为防御性措施。
 */
export async function fetchDownloadsJson(): Promise<DownloadsJson> {
  if (downloadsCache) return downloadsCache.data
  try {
    const data = hostdbLoadDownloadsJson() as DownloadsJson
    downloadsCache = { data, timestamp: Infinity }
    return data
  } catch (error) {
    logDebug('回退到网络获取 downloads.json', {
      error: error instanceof Error ? error.message : String(error),
    })
    return fetchWithCache(
      [
        `${LAYERBASE_REGISTRY_BASE}/downloads.json`,
        `${GITHUB_RAW_BASE}/downloads.json`,
      ],
      () => downloadsCache,
      (c) => {
        downloadsCache = c
      },
    )
  }
}

/**
 * 获取数据库引擎的 CLI 工具定义
 * @param engine 引擎（例如 Engine.PostgreSQL 或 'postgresql'）
 */
export async function getDatabaseTools(
  engine: Engine | string,
): Promise<CliTools | null> {
  try {
    const data = await fetchDatabasesJson()
    // hostdb 使用小写引擎名称
    const key = engine.toLowerCase()
    const entry = data[key]
    return entry?.cliTools || null
  } catch (error) {
    logDebug('从 hostdb 获取数据库工具失败', {
      engine,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 获取数据库引擎所需的客户端工具
 * 返回工具名称数组（客户端 + 实用工具）
 */
export async function getRequiredClientTools(
  engine: Engine | string,
): Promise<string[]> {
  const cliTools = await getDatabaseTools(engine)
  if (!cliTools) return []

  const required: string[] = []
  if (cliTools.client) {
    required.push(cliTools.client)
  }
  if (cliTools.utilities) {
    required.push(...cliTools.utilities)
  }
  return required
}

/**
 * 获取特定工具的包管理器信息
 * @param tool 工具名称（例如 'psql'、'mysqldump'）
 */
export async function getToolPackageInfo(
  tool: string,
): Promise<ToolDownloadInfo | null> {
  try {
    const data = await fetchDownloadsJson()
    return data.tools[tool] || null
  } catch (error) {
    logDebug('从 hostdb 获取工具包信息失败', {
      tool,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 使用特定包管理器获取工具的安装命令
 * @param tool 工具名称（例如 'psql'、'pg_dump'）
 * @param packageManager 包管理器键（例如 'brew'、'apt'）
 * @returns 完整的安装命令，如果不可用则返回 null
 */
export async function getInstallCommand(
  tool: string,
  packageManager: 'brew' | 'apt' | 'yum' | 'dnf' | 'choco',
): Promise<string | null> {
  try {
    const data = await fetchDownloadsJson()

    // 获取包管理器定义
    const pmDef = data.packageManagers[packageManager]
    if (!pmDef) return null

    // 获取该工具在此包管理器下的包信息
    const toolInfo = data.tools[tool]
    if (!toolInfo?.packages?.[packageManager]) return null

    const pkgInfo = toolInfo.packages[packageManager]

    // 构建命令
    let cmd = pmDef.installCmd.replace('{package}', pkgInfo.package)

    // 处理 Homebrew tap
    if (packageManager === 'brew' && pkgInfo.tap) {
      cmd = `brew tap ${pkgInfo.tap} && ${cmd}`
    }

    return cmd
  } catch (error) {
    logDebug('从 hostdb 获取安装命令失败', {
      tool,
      packageManager,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 获取提供一组工具所需的安装包
 * 对于许多工具，单个包提供多个二进制文件（例如 postgresql 提供 psql、pg_dump 等）
 * 此函数返回安装所有请求工具所需的唯一包
 */
export async function getPackagesForTools(
  tools: string[],
  packageManager: 'brew' | 'apt' | 'yum' | 'dnf' | 'choco',
): Promise<Array<{ package: string; tap?: string; tools: string[] }>> {
  try {
    const data = await fetchDownloadsJson()
    const packageMap = new Map<string, { tap?: string; tools: string[] }>()

    for (const tool of tools) {
      const toolInfo = data.tools[tool]
      if (!toolInfo?.packages?.[packageManager]) continue

      const pkgInfo = toolInfo.packages[packageManager]
      const key = pkgInfo.package

      const existing = packageMap.get(key)
      if (existing) {
        existing.tools.push(tool)
      } else {
        packageMap.set(key, {
          tap: pkgInfo.tap,
          tools: [tool],
        })
      }
    }

    return Array.from(packageMap.entries()).map(([pkg, info]) => ({
      package: pkg,
      tap: info.tap,
      tools: info.tools,
    }))
  } catch (error) {
    logDebug('从 hostdb 获取工具对应的包失败', {
      tools,
      packageManager,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * 检查版本条目是否已启用。
 * 同时处理旧版 schema（布尔值）和新版 schema（带可选 enabled 字段的对象）。
 * 对象默认启用，除非明确设置 `{ enabled: false }`。
 */
export function isVersionEnabled(value: boolean | VersionEntryObject): boolean {
  if (typeof value === 'boolean') return value
  return value.enabled !== false
}

/**
 * 检查版本条目是否已弃用。
 * 弃用的版本保留其现有 releases，但不建议
 * 用于新安装。
 */
export function isVersionDeprecated(
  value: boolean | VersionEntryObject,
): boolean {
  if (typeof value === 'boolean') return false
  return value.deprecated === true
}

/**
 * 从 databases.json 获取数据库引擎的已弃用版本字符串集合
 * @param engine 引擎（例如 Engine.PostgreSQL 或 'postgresql'）
 * @returns 已弃用的版本字符串集合，获取失败时返回空集合
 */
export async function getDeprecatedVersions(
  engine: Engine | string,
): Promise<Set<string>> {
  try {
    const data = await fetchDatabasesJson()
    const key = engine.toLowerCase()
    const entry = data[key]
    if (!entry?.versions) return new Set()

    return new Set(
      Object.entries(entry.versions)
        .filter(
          ([, value]) => isVersionEnabled(value) && isVersionDeprecated(value),
        )
        .map(([version]) => version),
    )
  } catch (error) {
    logDebug('从 hostdb 获取已弃用版本失败', {
      engine,
      error: error instanceof Error ? error.message : String(error),
    })
    return new Set()
  }
}

/**
 * 从 databases.json 获取数据库引擎的可用版本
 * 这是 hostdb 中实际可用版本的权威来源。
 * @param engine 引擎（例如 Engine.PostgreSQL 或 'postgresql'）
 * @returns 可用版本字符串数组，获取失败时返回 null
 */
export async function getAvailableVersions(
  engine: Engine | string,
): Promise<string[] | null> {
  try {
    const data = await fetchDatabasesJson()
    const key = engine.toLowerCase()
    const entry = data[key]
    if (!entry?.versions) return null

    return Object.entries(entry.versions)
      .filter(([, value]) => isVersionEnabled(value))
      .map(([version]) => version)
  } catch (error) {
    logDebug('从 hostdb 获取可用版本失败', {
      engine,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
