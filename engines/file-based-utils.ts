/**
 * 基于文件的数据库引擎（SQLite、DuckDB）的集中工具模块
 *
 * 本模块是以下功能的唯一数据源：
 * - 扩展名 → 引擎映射
 * - 引擎 → 有效扩展名
 * - 引擎 → 注册表
 * - 根据文件名推导容器名称
 * - 扫描未注册文件
 *
 * 所有基于文件的引擎行为都应通过此模块，
 * 因此添加新的基于文件的引擎只需修改此处。
 */

import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, extname } from 'path'
import { Engine, isFileBasedEngine } from '../types'
import { sqliteRegistry } from './sqlite/registry'
import { duckdbRegistry } from './duckdb/registry'

// ============================================================
// 扩展名映射
// ============================================================

/**
 * 文件扩展名到其对应基于文件引擎的映射表。
 * 这是扩展名 → 引擎检测的唯一数据源。
 */
const EXTENSION_TO_ENGINE: Record<string, Engine> = {
  '.sqlite': Engine.SQLite,
  '.sqlite3': Engine.SQLite,
  '.db': Engine.SQLite,
  '.duckdb': Engine.DuckDB,
  '.ddb': Engine.DuckDB,
}

/**
 * 每个引擎的有效扩展名，由扩展名映射表派生。
 * 用于验证（例如，确保 SQLite 容器只能重定位到 SQLite 扩展名）。
 */
const ENGINE_EXTENSIONS: Record<Engine.SQLite | Engine.DuckDB, string[]> = {
  [Engine.SQLite]: ['.sqlite', '.sqlite3', '.db'],
  [Engine.DuckDB]: ['.duckdb', '.ddb'],
}

/**
 * 每个引擎的扩展名正则表达式（用于从文件名中去除扩展名）。
 */
const ENGINE_EXTENSION_REGEX: Record<Engine.SQLite | Engine.DuckDB, RegExp> = {
  [Engine.SQLite]: /\.(sqlite3?|db)$/i,
  [Engine.DuckDB]: /\.(duckdb|ddb)$/i,
}

/**
 * 匹配任何基于文件引擎扩展名的组合正则表达式。
 */
export const FILE_BASED_EXTENSION_REGEX = /\.(sqlite3?|db|duckdb|ddb)$/i

/**
 * 根据文件扩展名检测文件属于哪个基于文件的引擎。
 * 如果扩展名不是可识别的基于文件数据库，则返回 null。
 */
export function detectEngineFromPath(filePath: string): Engine | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_ENGINE[ext] ?? null
}

/**
 * 获取基于文件引擎的有效文件扩展名列表。
 */
export function getExtensionsForEngine(
  engine: Engine.SQLite | Engine.DuckDB,
): string[] {
  return ENGINE_EXTENSIONS[engine]
}

/**
 * 获取所有有效的基于文件数据库扩展名。
 */
export function getAllFileBasedExtensions(): string[] {
  return Object.keys(EXTENSION_TO_ENGINE)
}

/**
 * 检查文件路径对指定引擎是否具有有效扩展名。
 */
export function isValidExtensionForEngine(
  filePath: string,
  engine: Engine.SQLite | Engine.DuckDB,
): boolean {
  const ext = extname(filePath).toLowerCase()
  return ENGINE_EXTENSIONS[engine].includes(ext)
}

/**
 * 返回基于文件引擎有效扩展名的可读字符串。
 */
export function formatExtensionsForEngine(
  engine: Engine.SQLite | Engine.DuckDB,
): string {
  return ENGINE_EXTENSIONS[engine].join(', ')
}

/**
 * 返回所有有效基于文件扩展名的可读字符串。
 */
export function formatAllExtensions(): string {
  return Object.keys(EXTENSION_TO_ENGINE).join(', ')
}

// ============================================================
// 注册表访问
// ============================================================

/**
 * 基于文件引擎注册表的通用接口。
 * SQLite 和 DuckDB 注册表均实现此结构。
 */
export type FileBasedRegistry = {
  add(entry: { name: string; filePath: string; created: string }): Promise<void>
  get(name: string): Promise<{ name: string; filePath: string } | null>
  remove(name: string): Promise<boolean>
  update(
    name: string,
    updates: { filePath?: string; lastVerified?: string },
  ): Promise<boolean>
  exists(name: string): Promise<boolean>
  isPathRegistered(filePath: string): Promise<boolean>
  getByPath(
    filePath: string,
  ): Promise<{ name: string; filePath: string } | null>
  isFolderIgnored(folderPath: string): Promise<boolean>
  addIgnoreFolder(folderPath: string): Promise<void>
  removeIgnoreFolder(folderPath: string): Promise<boolean>
  listIgnoredFolders(): Promise<string[]>
}

/**
 * 获取基于文件引擎的注册表。
 * 如果引擎不是基于文件的，则抛出错误。
 */
export function getRegistryForEngine(engine: Engine): FileBasedRegistry {
  switch (engine) {
    case Engine.SQLite:
      return sqliteRegistry
    case Engine.DuckDB:
      return duckdbRegistry
    default:
      if (isFileBasedEngine(engine)) {
        throw new Error(
          `基于文件的引擎 "${engine}" 在 getRegistryForEngine() 中未配置注册表`,
        )
      }
      throw new Error(`"${engine}" 不是基于文件的引擎`)
  }
}

// ============================================================
// 容器名称推导
// ============================================================

/**
 * 从数据库文件名推导出有效的容器名称。
 * 去除引擎特定的扩展名，并进行清理以用作容器名称。
 *
 * - 必须以字母开头
 * - 可包含字母、数字、连字符、下划线
 * - 如果结果为空，则回退到特定引擎的默认名称
 */
export function deriveContainerName(
  fileName: string,
  engine: Engine.SQLite | Engine.DuckDB,
): string {
  const extensionRegex = ENGINE_EXTENSION_REGEX[engine]
  const fallback = engine === Engine.SQLite ? 'sqlite-db' : 'duckdb-db'

  // 去除扩展名
  const base = fileName.replace(extensionRegex, '')

  // 如果去除扩展名后没有任何内容，则返回引擎特定默认名称
  const sanitizedBase = base
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!sanitizedBase) {
    return fallback
  }

  // 转换为有效的容器名称（字母数字、连字符、下划线）
  let name = base.replace(/[^a-zA-Z0-9_-]/g, '-')

  // 确保以字母开头
  if (!/^[a-zA-Z]/.test(name)) {
    name = 'db-' + name
  }

  // 去除连续连字符
  name = name.replace(/-+/g, '-')

  // 去除首尾连字符
  name = name.replace(/^-+|-+$/g, '')

  return name || fallback
}

// ============================================================
// 文件扫描
// ============================================================

export type UnregisteredFile = {
  fileName: string
  absolutePath: string
}

/**
 * 扫描目录中未注册的基于文件的数据库文件。
 *
 * @param engine 要扫描的基于文件的引擎
 * @param directory 要扫描的目录（默认为当前工作目录）
 * @returns 未注册文件的数组
 */
export async function scanForUnregisteredFiles(
  engine: Engine.SQLite | Engine.DuckDB,
  directory: string = process.cwd(),
): Promise<UnregisteredFile[]> {
  const absoluteDir = resolve(directory)
  const registry = getRegistryForEngine(engine)
  const extensionRegex = ENGINE_EXTENSION_REGEX[engine]

  // 检查文件夹是否被忽略
  if (await registry.isFolderIgnored(absoluteDir)) {
    return []
  }

  // 检查目录是否存在
  if (!existsSync(absoluteDir)) {
    return []
  }

  try {
    const entries = await readdir(absoluteDir, { withFileTypes: true })

    const matchingFiles = entries
      .filter((e) => e.isFile())
      .filter((e) => extensionRegex.test(e.name))
      .map((e) => ({
        fileName: e.name,
        absolutePath: resolve(absoluteDir, e.name),
      }))

    const unregistered: UnregisteredFile[] = []
    for (const file of matchingFiles) {
      if (!(await registry.isPathRegistered(file.absolutePath))) {
        unregistered.push(file)
      }
    }

    return unregistered
  } catch {
    return []
  }
}
