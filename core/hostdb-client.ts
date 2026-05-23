/**
 * 共享的 hostdb 客户端模块
 *
 * 提供对预编译数据库二进制文件的集中访问。
 * 主注册表：registry.layerbase.host
 * 回退注册表：GitHub releases（robertjbass/hostdb）
 *
 * 本模块负责获取 releases.json 并进行缓存，以避免重复的网络请求。
 */

import { Platform, type Arch, type Engine } from '../types'
import { logDebug } from './error-handler'

// 注册表基础 URL
export const LAYERBASE_REGISTRY_BASE = 'https://registry.layerbase.host'
export const GITHUB_REGISTRY_BASE =
  'https://github.com/robertjbass/hostdb/releases/download'

/**
 * 切换二进制文件下载和 releases.json 获取的 GitHub 回退。
 * 设置为 `false` 可专门测试 Layerbase 注册表。
 * 必须在发布前重新启用（参见 PRE_RELEASE_TASKS.md）。
 */
export const ENABLE_GITHUB_FALLBACK = false

// hostdb releases.json 中的平台定义
export type HostdbPlatform = {
  url: string
  sha256: string
  size: number
}

// hostdb releases.json 中的版本条目
export type HostdbRelease = {
  version: string
  releaseTag: string
  releasedAt: string
  deprecated?: boolean
  platforms: Record<string, HostdbPlatform>
}

// hostdb releases.json 的结构
export type HostdbReleasesData = {
  repository: string
  updatedAt: string
  databases: Record<string, Record<string, HostdbRelease>>
}

// hostdb 支持的平台
export const SUPPORTED_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
] as const

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

// hostdb 中可用引擎的类型别名（使用 types 中的 Engine 枚举）
export type HostdbEngine = Engine

/**
 * 已获取的发布信息的内存缓存。
 *
 * 线程安全说明：此缓存使用模块级可变状态，在 Node.js worker 线程之间使用不安全。
 * 每个 worker 线程都会拥有此缓存的独立副本。对于 SpinDB 的单线程 CLI 使用场景，
 * 这是可接受的。
 */
let cachedReleases: HostdbReleasesData | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟

export const LAYERBASE_RELEASES_URL =
  'https://registry.layerbase.host/releases.json'
export const GITHUB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

/**
 * 获取要尝试的 releases.json URL 列表，遵循 ENABLE_GITHUB_FALLBACK 的设置。
 * 当回退被禁用时，仅返回 Layerbase 的 URL。
 */
export function getReleasesUrls(): string[] {
  return ENABLE_GITHUB_FALLBACK
    ? [LAYERBASE_RELEASES_URL, GITHUB_RELEASES_URL]
    : [LAYERBASE_RELEASES_URL]
}

/**
 * 通过缓存从 hostdb 仓库获取 releases.json。
 *
 * @returns hostdb 的完整发布数据
 * @throws 如果获取失败则抛出错误
 */
export async function fetchHostdbReleases(): Promise<HostdbReleasesData> {
  // 如果缓存仍然有效，则返回已缓存的发布信息
  if (cachedReleases && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedReleases
  }

  // 先尝试 layerbase 注册表，若启用则回退到 GitHub
  const urls = getReleasesUrls()
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const isLast = i === urls.length - 1
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = (await response.json()) as HostdbReleasesData

      // 缓存结果
      cachedReleases = data
      cacheTimestamp = Date.now()

      return data
    } catch (error) {
      const err = error as Error
      logDebug(`从 ${url} 获取发布信息失败：${err.message}`)
      // 如果这是最后一个 URL，重新抛出错误
      if (isLast) {
        throw error
      }
      // 否则尝试下一个 URL
    }
  }

  // 不应到达此处（循环在最后一次迭代时总会抛出错误）
  throw new Error('从所有注册表获取 hostdb 发布信息均失败')
}

/**
 * 从 hostdb 数据中获取特定引擎的发布信息。
 *
 * @param data - 完整的 hostdb 发布数据
 * @param engine - 引擎（例如 Engine.PostgreSQL 或 'postgresql'）
 * @returns 该引擎的发布信息，如果未找到则返回 undefined
 */
export function getEngineReleases(
  data: HostdbReleasesData,
  engine: Engine | string,
): Record<string, HostdbRelease> | undefined {
  return data.databases[engine]
}

/**
 * 将 Node.js 平台标识符映射为 hostdb 平台标识符。
 *
 * @param platform - Node.js 平台（例如 Platform.Darwin）
 * @param arch - Node.js 架构（例如 Arch.ARM64）
 * @returns hostdb 平台标识符，如果不支持则返回 undefined
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): SupportedPlatform | undefined {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.includes(key as SupportedPlatform)
    ? (key as SupportedPlatform)
    : undefined
}

/**
 * 验证某个平台是否受 hostdb 支持。
 *
 * @param platform - Node.js 平台（例如 Platform.Darwin）
 * @param arch - Node.js 架构（例如 Arch.ARM64）
 * @returns 验证后的 hostdb 平台标识符
 * @throws 如果平台不受支持则抛出错误
 */
export function validatePlatform(
  platform: Platform,
  arch: Arch,
): SupportedPlatform {
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    const supported = SUPPORTED_PLATFORMS.join(', ')
    throw new Error(
      `不支持的平台：${platform}-${arch}。` +
        `hostdb 为以下平台提供二进制文件：${supported}`,
    )
  }
  return hostdbPlatform
}

export type BuildHostdbUrlOptions = {
  version: string
  hostdbPlatform: string
  extension?: 'tar.gz' | 'zip'
}

/**
 * 构建 hostdb 发布版的下载 URL（底层实现，无验证）。
 *
 * 这是核心 URL 构建器，所有引擎在根据自身支持的平台集进行验证后都应使用它。
 *
 * @param engine - 引擎名称（例如 'postgresql'、'mysql'）
 * @param options - 版本、预先验证过的平台字符串以及可选的扩展名
 * @returns 下载 URL
 */
export function buildHostdbUrl(
  engine: Engine | string,
  options: BuildHostdbUrlOptions,
): string {
  const { version, hostdbPlatform, extension = 'tar.gz' } = options
  const tag = `${engine}-${version}`
  const filename = `${engine}-${version}-${hostdbPlatform}.${extension}`

  return `${LAYERBASE_REGISTRY_BASE}/${tag}/${filename}`
}

/**
 * 为 hostdb 发布版构建 GitHub 回退 URL（路径方案与 layerbase 相同）。
 */
export function buildGithubFallbackUrl(
  engine: Engine | string,
  options: BuildHostdbUrlOptions,
): string {
  const { version, hostdbPlatform, extension = 'tar.gz' } = options
  const tag = `${engine}-${version}`
  const filename = `${engine}-${version}-${hostdbPlatform}.${extension}`

  return `${GITHUB_REGISTRY_BASE}/${tag}/${filename}`
}

/**
 * 将 layerbase 注册表 URL 转换为其 GitHub 回退等效 URL。
 * 如果 URL 不是 layerbase URL 或 GitHub 回退被禁用，则返回 null。
 */
export function getRegistryFallbackUrl(url: string): string | null {
  if (!ENABLE_GITHUB_FALLBACK) return null
  if (url.startsWith(LAYERBASE_REGISTRY_BASE)) {
    return url.replace(LAYERBASE_REGISTRY_BASE, GITHUB_REGISTRY_BASE)
  }
  return null
}

// 瞬态网络故障的重试策略。选择此策略使得 1-2 秒的波动能被吸收，
// 但真正的故障能快速暴露。每次 URL 的最坏情况总预算 = 延迟之和 = 0 + 300 + 900 = 1.2 秒的回退，
// 共 3 次尝试。
const TRANSIENT_RETRY_DELAYS_MS = [0, 300, 900]

/**
 * 当来自 `fetch` 的错误看起来像是值得重试的瞬态网络问题时，返回 true。
 * 排除有意设置的超时（AbortError，它们有其自身的含义）以及在此层不应重试的非瞬态客户端错误。
 *
 * Node 的 undici 对几乎所有连接级故障都会抛出 `TypeError: fetch failed`；
 * 底层原因位于 `error.cause.code` 中（例如 'ECONNRESET'、'ETIMEDOUT'、'EAI_AGAIN'、
 * 'UND_ERR_SOCKET'）。将所有这些视为瞬态错误是正确的做法 — 它们均不表示 URL 永久不可用。
 */
function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return false
  if (error.message === 'fetch failed') return true
  const cause = (error as { cause?: { code?: string } }).cause
  if (cause?.code) {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(cause.code)
  }
  return false
}

/**
 * 当 HTTP 响应状态码值得重试时返回 true。
 * 涵盖瞬态服务器端状况（5xx）和速率限制（429）。客户端错误（其他 4xx）不会重试 — 它们
 * 重试也不会改变，通常是请求中的错误。
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 获取 URL 并在瞬态网络错误和瞬态 HTTP 响应（5xx、408、429）时进行重试。
 * 用作 fetchWithRegistryFallback 和 fetchFromRegistryUrls 所基于的底层原语，
 * 因此单次网络波动不会导致二进制文件下载失败。遵守 AbortError，因此调用方提供的超时
 * 仍会立即终止。
 */
async function fetchWithRetries(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  let lastError: unknown
  let lastStatus: number | null = null
  for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
    try {
      const response = await fetch(url, options)
      if (response.ok || !isTransientStatus(response.status)) {
        return response
      }
      lastStatus = response.status
      logDebug(
        `获取 ${url} 在第 ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length} 次尝试时返回 ${response.status}，正在重试...`,
      )
    } catch (error) {
      if (!isTransientFetchError(error)) {
        throw error
      }
      lastError = error
      logDebug(
        `获取 ${url} 在第 ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length} 次尝试时发生瞬态失败：${(error as Error).message}`,
      )
    }
  }
  // 所有尝试均已用完。抛出我们看到的最后一个错误，或者在没有抛出错误的情况下
  // 抛出携带最后一个 HTTP 状态码的合成错误。
  if (lastError) throw lastError
  throw new Error(
    `获取 ${url} 在 ${TRANSIENT_RETRY_DELAYS_MS.length} 次尝试后失败（最后状态码：${lastStatus ?? '未知'}）`,
  )
}

/**
 * 一个 fetch 封装器，首先尝试主 URL，如果主 URL 是 layerbase URL 且请求
 * 因 404、5xx 或网络错误而失败，则回退到 GitHub 注册表。
 *
 * 每次 URL 尝试在回退到下一个 URL 之前，会在内部对瞬态错误进行重试 —
 * 单次网络波动不会耗尽回退机会。AbortError（超时）仍会立即传播。
 */
export async function fetchWithRegistryFallback(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchWithRetries(url, options)
    if (response.status === 404 || response.status >= 500) {
      const fallbackUrl = getRegistryFallbackUrl(url)
      if (fallbackUrl) {
        logDebug(`主注册表返回 ${response.status}，正在尝试 GitHub 回退`)
        return await fetchWithRetries(fallbackUrl, options)
      }
    }
    return response
  } catch (error) {
    const err = error as Error
    // 超时（AbortError）永不重试
    if (err.name === 'AbortError') {
      throw error
    }
    const fallbackUrl = getRegistryFallbackUrl(url)
    if (fallbackUrl) {
      logDebug(`主注册表获取失败（${err.message}），正在尝试 GitHub 回退`)
      return await fetchWithRetries(fallbackUrl, options)
    }
    throw error
  }
}

/**
 * 尝试按顺序从多个注册表 URL 获取，返回第一个成功的（response.ok）Response。
 * 在转到下一个之前，每个 URL 都有自己的重试预算，因此瞬态波动不会耗尽注册表列表。
 * 通过提供的 logger 回调记录每个 URL 的失败情况。
 *
 * @param urls - 要按顺序尝试的 URL（例如先 layerbase，再 GitHub）
 * @param logger - 用于记录每个 URL 失败情况的回调
 * @param timeoutMs - 每次请求的超时毫秒数（默认：5000）
 * @returns 第一个成功的 Response
 * @throws 如果所有 URL 均失败则抛出错误
 */
export async function fetchFromRegistryUrls(
  urls: string[],
  logger: (message: string) => void,
  timeoutMs: number = 5000,
): Promise<Response> {
  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const response = await fetchWithRetries(url, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      logger(`从 ${url} 获取注册表：HTTP ${response.status}`)
    } catch (error) {
      logger(`从 ${url} 获取注册表失败：${error}`)
      lastError = error as Error
    }
  }
  throw lastError ?? new Error('所有发布注册表均失败')
}

export type BuildDownloadUrlOptions = {
  version: string
  platform: Platform
  arch: Arch
}

/**
 * 通过平台验证构建 hostdb 发布版的下载 URL。
 *
 * 这是 buildHostdbUrl 的一个便捷封装器，它会根据全局 SUPPORTED_PLATFORMS 列表验证平台。
 * 对于具有不同平台支持情况的引擎（例如 ClickHouse 不支持 Windows），
 * 请根据引擎特定的平台进行验证后直接使用 buildHostdbUrl。
 *
 * @param engine - 引擎名称（例如 'postgresql'、'mysql'）
 * @param options - 版本和平台配置
 * @returns 下载 URL
 * @throws 如果平台不受 hostdb 支持则抛出错误
 */
export function buildDownloadUrl(
  engine: Engine | string,
  options: BuildDownloadUrlOptions,
): string {
  const { version, platform, arch } = options
  const hostdbPlatform = validatePlatform(platform, arch)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(engine, { version, hostdbPlatform, extension: ext })
}
