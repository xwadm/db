#!/usr/bin/env tsx
/**
 * 数据库生成脚本的调度器。
 *
 * 用法:
 *   pnpm generate:db <引擎> [容器名称] [--port <端口>]
 *
 * 示例:
 *   pnpm generate:db postgresql           # 创建 demo-postgresql 并填充种子数据
 *   pnpm generate:db pg mydb              # 填充现有容器 "mydb"
 *   pnpm generate:db postgres --port 5555 # 在指定端口创建
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 引擎名称和别名的唯一数据源
const ENGINE_DEFS = [
  { engine: 'postgresql', aliases: ['postgres', 'pg'] },
  { engine: 'mysql', aliases: [] },
  { engine: 'mariadb', aliases: ['maria'] },
  { engine: 'mongodb', aliases: ['mongo'] },
  { engine: 'ferretdb', aliases: ['ferret'] },
  { engine: 'redis', aliases: [] },
  { engine: 'valkey', aliases: [] },
  { engine: 'clickhouse', aliases: ['ch'] },
  { engine: 'sqlite', aliases: ['lite'] },
  { engine: 'duckdb', aliases: ['duck'] },
  { engine: 'qdrant', aliases: ['qd'] },
  { engine: 'meilisearch', aliases: ['meili', 'ms'] },
  { engine: 'couchdb', aliases: ['couch'] },
  { engine: 'cockroachdb', aliases: ['crdb', 'cockroach'] },
  { engine: 'surrealdb', aliases: ['surreal'] },
  { engine: 'questdb', aliases: ['quest'] },
  { engine: 'typedb', aliases: ['tdb'] },
  { engine: 'influxdb', aliases: ['influx'] },
  { engine: 'weaviate', aliases: ['wv'] },
  { engine: 'tigerbeetle', aliases: ['tb'] },
  { engine: 'libsql', aliases: ['lsql', 'sqld'] },
] as const

type SupportedEngine = (typeof ENGINE_DEFS)[number]['engine']

// 从 ENGINE_DEFS 派生别名映射
const ENGINE_ALIASES: Record<string, SupportedEngine> = Object.fromEntries(
  ENGINE_DEFS.flatMap(({ engine, aliases }) => [
    [engine, engine],
    ...aliases.map((alias) => [alias, engine]),
  ]),
) as Record<string, SupportedEngine>

function resolveEngine(input: string): SupportedEngine | null {
  return ENGINE_ALIASES[input.toLowerCase()] ?? null
}

function printUsage(): void {
  console.log(
    '用法: pnpm generate:db <引擎> [容器名称] [--port <端口>]',
  )
  console.log('')
  console.log('支持的引擎 (含别名):')
  for (const { engine, aliases } of ENGINE_DEFS) {
    const aliasText = aliases.length > 0 ? ` (${aliases.join(', ')})` : ''
    console.log(`  - ${engine}${aliasText}`)
  }
  console.log('')
  console.log('选项:')
  console.log('  --port <端口>  指定新容器的端口')
  console.log('')
  console.log('示例:')
  console.log(
    '  pnpm generate:db postgresql           # 创建 demo-postgresql',
  )
  console.log('  pnpm generate:db pg mydb              # 填充现有 "mydb"')
  console.log(
    '  pnpm generate:db postgres --port 5555 # 在指定端口创建',
  )
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(args.length === 0 ? 1 : 0)
  }

  const engineInput = args[0]
  const engine = resolveEngine(engineInput)
  const engineArgs = args.slice(1)

  if (!engine) {
    console.error(`错误: 未知的引擎 "${engineInput}"`)
    console.error('')
    printUsage()
    process.exit(1)
  }

  const scriptPath = join(__dirname, `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.error(`错误: 脚本未找到: ${scriptPath}`)
    console.error(
      `\n"${engine}" 的生成器尚未实现。`,
    )
    process.exit(1)
  }

  // 使用 tsx 运行引擎特定脚本
  const child = spawn('tsx', [scriptPath, ...engineArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', reject)
  })

  process.exit(exitCode)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`运行脚本时出错: ${message}`)
  process.exit(1)
})
