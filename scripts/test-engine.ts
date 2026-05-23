#!/usr/bin/env tsx
/**
 * 集成测试运行脚本
 *
 * 用法：
 *   pnpm test:engine              # 运行所有集成测试
 *   pnpm test:engine postgres     # 运行 PostgreSQL 测试
 *   pnpm test:engine pg           # 运行 PostgreSQL 测试（别名）
 *   pnpm test:engine mongo        # 运行 MongoDB 测试（别名）
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// 引擎名称到测试文件的映射（标准名称）
const ENGINE_TEST_FILES: Record<string, string> = {
  postgresql: 'postgresql.test.ts',
  mysql: 'mysql.test.ts',
  mariadb: 'mariadb.test.ts',
  sqlite: 'sqlite.test.ts',
  duckdb: 'duckdb.test.ts',
  mongodb: 'mongodb.test.ts',
  ferretdb: 'ferretdb.test.ts',
  'ferretdb-v1': 'ferretdb-v1.test.ts',
  redis: 'redis.test.ts',
  valkey: 'valkey.test.ts',
  clickhouse: 'clickhouse.test.ts',
  qdrant: 'qdrant.test.ts',
  meilisearch: 'meilisearch.test.ts',
  couchdb: 'couchdb.test.ts',
  cockroachdb: 'cockroachdb.test.ts',
  surrealdb: 'surrealdb.test.ts',
  questdb: 'questdb.test.ts',
  typedb: 'typedb.test.ts',
  influxdb: 'influxdb.test.ts',
  weaviate: 'weaviate.test.ts',
  tigerbeetle: 'tigerbeetle.test.ts',
  libsql: 'libsql.test.ts',
}

// 引擎别名映射（别名 -> 标准名称）
const ENGINE_ALIASES: Record<string, string> = {
  // PostgreSQL 别名
  postgres: 'postgresql',
  pg: 'postgresql',
  // MongoDB 别名
  mongo: 'mongodb',
  // FerretDB 别名
  ferret: 'ferretdb',
  fdb: 'ferretdb',
  // FerretDB v1 别名
  'ferret-v1': 'ferretdb-v1',
  'fdb-v1': 'ferretdb-v1',
  fdb1: 'ferretdb-v1',
  // SQLite 别名
  lite: 'sqlite',
  // DuckDB 别名
  duck: 'duckdb',
  // Qdrant 别名
  qd: 'qdrant',
  // Meilisearch 别名
  meili: 'meilisearch',
  ms: 'meilisearch',
  // CouchDB 别名
  couch: 'couchdb',
  // CockroachDB 别名
  crdb: 'cockroachdb',
  // SurrealDB 别名
  surreal: 'surrealdb',
  // QuestDB 别名
  quest: 'questdb',
  // TypeDB 别名
  tdb: 'typedb',
  // InfluxDB 别名
  influx: 'influxdb',
  // Weaviate 别名
  wv: 'weaviate',
  // TigerBeetle 别名
  tb: 'tigerbeetle',
  // LibSQL 别名
  lsql: 'libsql',
}

// 测试运行顺序（匹配 test:integration 脚本的顺序）
const TEST_ORDER = [
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'duckdb',
  'mongodb',
  'ferretdb',
  'ferretdb-v1',
  'redis',
  'valkey',
  'clickhouse',
  'qdrant',
  'meilisearch',
  'couchdb',
  'cockroachdb',
  'surrealdb',
  'questdb',
  'typedb',
  'influxdb',
  'weaviate',
  'tigerbeetle',
  'libsql',
]

function resolveEngine(input: string): string | null {
  const normalized = input.toLowerCase().trim()

  // 检查是否为标准名称
  if (ENGINE_TEST_FILES[normalized]) {
    return normalized
  }

  // 检查是否为别名
  if (ENGINE_ALIASES[normalized]) {
    return ENGINE_ALIASES[normalized]
  }

  return null
}

function printUsage(): void {
  console.log('用法：pnpm test:engine [引擎]')
  console.log('')
  console.log('运行数据库引擎的集成测试。')
  console.log('')
  console.log('参数：')
  console.log('  引擎    引擎名称或别名（可选，省略则运行所有测试）')
  console.log('')
  console.log('可用引擎：')
  console.log('  postgresql    （别名：postgres, pg）')
  console.log('  mysql')
  console.log('  mariadb')
  console.log('  sqlite        （别名：lite）')
  console.log('  duckdb        （别名：duck）')
  console.log('  mongodb       （别名：mongo）')
  console.log('  ferretdb      （别名：ferret, fdb）')
  console.log('  ferretdb-v1   （别名：ferret-v1, fdb-v1, fdb1）')
  console.log('  redis')
  console.log('  valkey')
  console.log('  clickhouse')
  console.log('  qdrant        （别名：qd）')
  console.log('  meilisearch   （别名：meili, ms）')
  console.log('  couchdb       （别名：couch）')
  console.log('  cockroachdb   （别名：crdb）')
  console.log('  surrealdb     （别名：surreal）')
  console.log('  questdb       （别名：quest）')
  console.log('  typedb        （别名：tdb）')
  console.log('  influxdb      （别名：influx）')
  console.log('  weaviate      （别名：wv）')
  console.log('  tigerbeetle   （别名：tb）')
  console.log('  libsql        （别名：lsql）')
  console.log('')
  console.log('示例：')
  console.log('  pnpm test:engine              # 运行所有集成测试')
  console.log('  pnpm test:engine postgres     # 运行 PostgreSQL 测试')
  console.log('  pnpm test:engine pg           # 运行 PostgreSQL 测试（别名）')
  console.log('  pnpm test:engine mongo        # 运行 MongoDB 测试')
}

async function runTest(testFile: string): Promise<number> {
  const testPath = join(process.cwd(), 'tests', 'integration', testFile)

  if (!existsSync(testPath)) {
    console.error(`测试文件未找到：${testPath}`)
    return 1
  }

  return new Promise((resolve) => {
    const proc = spawn(
      'node',
      [
        '--import',
        'tsx',
        '--test',
        '--experimental-test-isolation=none',
        testPath,
      ],
      {
        stdio: 'inherit',
        cwd: process.cwd(),
      },
    )

    proc.on('close', (code) => {
      resolve(code ?? 1)
    })

    proc.on('error', (err) => {
      console.error(`运行测试失败：${err.message}`)
      resolve(1)
    })
  })
}

async function runAllTests(): Promise<number> {
  let hasFailure = false

  for (const engine of TEST_ORDER) {
    const testFile = ENGINE_TEST_FILES[engine]
    console.log(`\n${'='.repeat(60)}`)
    console.log(`正在运行 ${engine} 集成测试...`)
    console.log(`${'='.repeat(60)}\n`)

    const exitCode = await runTest(testFile)
    if (exitCode !== 0) {
      hasFailure = true
      console.error(`\n${engine} 测试失败，退出码 ${exitCode}`)
      // 继续下一个测试，而不是停止（与 run-s 行为保持一致）
    }
  }

  return hasFailure ? 1 : 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // 处理帮助标志
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  // 无参数 — 运行所有测试
  if (args.length === 0) {
    const exitCode = await runAllTests()
    process.exit(exitCode)
  }

  // 单引擎参数
  const engineInput = args[0]
  const engine = resolveEngine(engineInput)

  if (!engine) {
    console.error(`错误：未知的引擎 "${engineInput}"`)
    console.error('')
    console.error('有效引擎：' + Object.keys(ENGINE_TEST_FILES).join(', '))
    console.error(
      '有效别名：' +
        Object.entries(ENGINE_ALIASES)
          .map(([alias, canonical]) => `${alias} -> ${canonical}`)
          .join(', '),
    )
    process.exit(1)
  }

  const testFile = ENGINE_TEST_FILES[engine]
  console.log(`正在运行 ${engine} 集成测试...\n`)

  const exitCode = await runTest(testFile)
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
