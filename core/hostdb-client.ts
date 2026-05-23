/**
 * 共享的 hostdb 客户端模块
 *
 * 提供对预构建数据库二进制文件的集中访问。
 * 主注册表：registry.layerbase.host
 * 回退注册表：GitHub releases (robertjbass/hostdb)
 *
 * 此模块负责获取 releases.json 并使用缓存以避免
 * 重复的网络请求。
 */

import { Platform, type Arch, type Engine } from '../types'
import { logDebug } from './error-handler'

// 注册表基础 URL
export const LAYERBASE_REGISTRY_BASE = 'https://registry.layerbase.host'
export const GITHUB_REGISTRY_BASE =
  'https://github.com/robertjbass/hostdb/releases/download'

/**
 * 切换二进制下载和 releases.json 获取的 GitHub 回退。
 * 设置为 `false` 可仅测试 Layerbase 注册表。
 * 发布前必须重新启用（参见 PRE_RELEASE_TASKS.md）。
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
 * 已获取 releases 的内存缓存。
 *
 * 线程安全说明：此缓存使用模块级可变状态，不安全
 * 用于跨 Node.js worker 线程。每个 worker 线程将拥有
 * 自己的缓存副本。对于 SpinDB 的单线程 CLI 使用场景，
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
 * 获取要尝试的 releases.json URL 列表，遵循 ENABLE_GITHUB_FALLBACK 设置。
 * 当回退禁用时，仅返回 Layerbase URL。
 */
export function getReleasesUrls(): string[] {
  return ENABLE_GITHUB_FALLBACK
    ? [LAYERBASE_RELEASES_URL, GITHUB_RELEASES_URL]
    : [LAYERBASE_RELEASES_URL]
}

/**
 * 从 hostdb 仓库获取 releases.json 并使用缓存。
 *
 * @returns hostdb 的完整 releases 数据
 * @throws 如果获取失败则抛出错误
 */
export async function fetchHostdbReleases(): Promise<HostdbReleasesData> {
  // 如果缓存仍有效则返回
  if (cachedReleases && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedReleases
  }

  // 首先尝试 layerbase 注册表，回退到 GitHub（如果启用）
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
      logDebug(`从 ${url} 获取 releases 失败: ${err.message}`)
      // 如果是最后一个 URL，重新抛出
      if (isLast) {
        throw error
      }
      // 否则尝试下一个 URL
    }
  }

  // 理论上不可达（循环在最后一次迭代时总会抛出）
  throw new Error('从所有注册表获取 hostdb releases 均失败')
}

/**
 * 从 hostdb 数据中获取特定引擎的 releases。
 *
 * @param data - 完整的 hostdb releases 数据
 * @param engine - 引擎（例如 Engine.PostgreSQL 或 'postgresql'）
 * @returns 该引擎的 releases，如果未找到则返回 undefined
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
 * 验证平台是否受 hostdb 支持。
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
      `不支持的平台: ${platform}-${arch}。` +
        `hostdb 提供以下平台的二进制文件: ${supported}`,
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
 * 构建 hostdb release 的下载 URL（底层函数，无验证）。
 *
 * 这是所有引擎在验证平台后应使用的核心 URL 构建器。
 *
 * @param engine - 引擎名称（例如 'postgresql'、'mysql'）
 * @param options - 版本、已验证的平台字符串和可选扩展名
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
 * 构建 hostdb release 的 GitHub 回退 URL（与 layerbase 相同的路径方案）。
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
 * 将 layerbase 注册表 URL 转换为其 GitHub 回退等价 URL。
 * 如果 URL 不是 layerbase URL 或 GitHub 回退已禁用，则返回 null。
 */
export function getRegistryFallbackUrl(url: string): string | null {
  if (!ENABLE_GITHUB_FALLBACK) return null
  if (url.startsWith(LAYERBASE_REGISTRY_BASE)) {
    return url.replace(LAYERBASE_REGISTRY_BASE, GITHUB_REGISTRY_BASE)
  }
  return null
}

/**
 * 获取包装器，首先尝试主 URL，然后如果主 URL 是 layerbase URL
 * 且请求因 404、5xx 或网络错误失败，则回退到 GitHub 注册表。
 *
 * AbortError（超时）永远不会重试 —— 立即传播。
 */
export async function fetchWithRegistryFallback(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetch(url, options)
    if (response.status === 404 || response.status >= 500) {
      const fallbackUrl = getRegistryFallbackUrl(url)
      if (fallbackUrl) {
        logDebug(
          `主注册表返回 ${response.status}，尝试 GitHub 回退`,
        )
        return await fetch(fallbackUrl, options)
      }
    }
    return response
  } catch (error) {
    const err = error as Error
    // 超时（AbortError）不重试
    if (err.name === 'AbortError') {
      throw error
    }
    const fallbackUrl = getRegistryFallbackUrl(url)
    if (fallbackUrl) {
      logDebug(
        `主注册表获取失败 (${err.message})，尝试 GitHub 回退`,
      )
      return await fetch(fallbackUrl, options)
    }
    throw error
  }
}

/**
 * 尝试按顺序从多个注册表 URL 获取，返回第一个
 * 成功（response.ok）的 Response。通过提供的
 * 日志回调记录每个 URL 的失败。
 *
 * @param urls - 要按顺序尝试的 URL（例如先 layerbase 再 GitHub）
 * @param logger - 用于记录每个 URL 失败的回调
 * @param timeoutMs - 每个请求的超时时间（毫秒，默认：5000）
 * @returns 第一个成功的 Response
 * @throws 如果所有 URL 都失败则抛出错误
 */
export async function fetchFromRegistryUrls(
  urls: string[],
  logger: (message: string) => void,
  timeoutMs: number = 5000,
): Promise<Response> {
  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      logger(`从 ${url} 获取注册表: HTTP ${response.status}`)
    } catch (error) {
      logger(`从 ${url} 获取注册表失败: ${error}`)
      lastError = error as Error
    }
  }
  throw lastError ?? new Error('所有 release 注册表均失败')
}

export type BuildDownloadUrlOptions = {
  version: string
  platform: Platform
  arch: Arch
}

/**
 * 构建带平台验证的 hostdb release 下载 URL。
 *
 * 这是 buildHostdbUrl 的便捷包装器，会验证
 * 平台是否在全局 SUPPORTED_PLATFORMS 列表中。对于具有
 * 不同平台支持的引擎（例如 ClickHouse 不支持 Windows），
 * 请在验证引擎特定平台后直接使用 buildHostdbUrl。
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
