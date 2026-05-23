import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { type Engine, ALL_ENGINES } from '../types'

/**
 * SpinDB 引擎元数据。仅携带稳定的引擎形态数据 —— 显示名称、
 * 运行时模型、连接方案等。
 *
 * 与版本相关的字段（存在哪些版本、默认版本是什么）曾经
 * 存放于此，但在 `hostdb` 成为唯一数据源后被移除：
 *   - `supportedVersions` → 使用引擎实例上的 `engine.supportedVersions`
 *     （由 hostdb 驱动的包装器中的 `SUPPORTED_MAJOR_VERSIONS` 构建）。
 *   - `defaultVersion` → 使用 `config/engine-defaults.ts` 中的
 *     `getEngineDefaults(engine).defaultVersion`（spindb 主版本级别策略，
 *     在创建时通过 hostdb 解析为完整版本）。
 *   - `versionPlatforms` → 使用 `hostdb.getAvailablePlatforms(engine, version)`。
 */
export type EngineConfig = {
  displayName: string
  icon: string
  status: 'integrated' | 'pending' | 'planned'
  binarySource: 'hostdb' | 'system' | 'edb'
  defaultPort: number | null
  runtime: 'server' | 'embedded'
  queryLanguage: string
  scriptFileLabel: string | null
  connectionScheme: string
  superuser: string | null
  clientTools: string[]
  licensing?: string | string[]
  notes?: string
  platforms?: string[]
}

export type EnginesJson = {
  $schema?: string
  engines: Record<Engine, EngineConfig>
}

// 已加载引擎配置的缓存
let cachedEngines: EnginesJson | null = null

// 获取当前文件的目录，用于相对路径解析
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export async function loadEnginesJson(): Promise<EnginesJson> {
  if (cachedEngines) return cachedEngines

  const jsonPath = join(__dirname, 'engines.json')

  let content: string
  try {
    content = await readFile(jsonPath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取位于 ${jsonPath} 的 engines.json：${message}`)
  }

  let parsed: EnginesJson
  try {
    parsed = JSON.parse(content) as EnginesJson
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法解析位于 ${jsonPath} 的 engines.json：${message}`)
  }

  // 结构验证：确保解析结果具有预期的形状
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`位于 ${jsonPath} 的 engines.json 结构无效：应为对象`)
  }
  if (!parsed.engines || typeof parsed.engines !== 'object') {
    throw new Error(
      `位于 ${jsonPath} 的 engines.json 结构无效：缺少 'engines' 字段或该字段无效`,
    )
  }

  // 运行时验证：确保所有引擎都存在
  for (const engine of ALL_ENGINES) {
    if (!(engine in parsed.engines)) {
      throw new Error(
        `engines.json 缺少引擎：${engine}。` +
          `所有 Engine 枚举中的引擎都必须存在。`,
      )
    }
  }

  cachedEngines = parsed
  return cachedEngines
}

export async function getEngineConfig(engine: Engine): Promise<EngineConfig> {
  const data = await loadEnginesJson()
  return data.engines[engine]
}

export function getAllEngines(): Engine[] {
  return [...ALL_ENGINES]
}

export function clearEnginesCache(): void {
  cachedEngines = null
}
