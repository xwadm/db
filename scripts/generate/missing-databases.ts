#!/usr/bin/env tsx
/**
 * 为尚无容器的数据库引擎创建演示容器。
 *
 * 这是一个仅用于开发的工具，用于为每种引擎类型快速创建一个容器，
 * 以便测试。
 *
 * 用法：
 *   pnpm generate:missing                # 创建缺少的演示容器
 *   pnpm generate:missing --all          # 为所有引擎创建演示容器
 *   pnpm generate:missing --seed         # 创建并用演示数据填充
 *   pnpm generate:missing --all --seed   # 创建所有并用演示数据填充
 *   pnpm generate:missing --dry-run      # 显示将要创建的内容
 *
 * 不带 --seed 时，仅创建容器但不启动或填充。
 * 带 --seed 时，每个容器都会创建、启动并通过 `generate:db` 填充。
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { runSpindb, PROJECT_ROOT, type ContainerConfig } from './db/_shared.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// TODO - 如果可能，从 hostdb 获取数据源
const SUPPORTED_ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'ferretdb',
  'redis',
  'valkey',
  'clickhouse',
  'sqlite',
  'duckdb',
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
] as const

type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

/**
 * 需要多个不同版本演示容器的引擎。
 * 每个条目使用指定的版本和名称后缀生成一个独立的容器。
 * 第一个条目（无后缀）是“默认”版本。
 */
const VERSION_OVERRIDES: Record<
  string,
  Array<{ version: string; suffix: string }>
> = {
  ferretdb: [
    { version: '2', suffix: '' }, // demo-ferretdb (v2)
    { version: '1', suffix: '-v1' }, // demo-ferretdb-v1 (v1)
  ],
}

const FILE_BASED_ENGINES: ReadonlySet<string> = new Set(['sqlite', 'duckdb'])

const FILE_BASED_EXTENSIONS: Record<string, string> = {
  sqlite: '.sqlite',
  duckdb: '.duckdb',
}

/**
 * 存放生成的基于文件的数据库的目录。
 * 使用 ~/.spindb/demo/ 以避免污染项目当前工作目录。
 */
function getDemoDir(): string {
  const dir = join(homedir(), '.spindb', 'demo')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

type ParsedArgs = {
  all: boolean
  seed: boolean
  dryRun: boolean
  help: boolean
}

function printUsage(): void {
  console.log('用法：pnpm generate:missing [选项]')
  console.log('')
  console.log('为尚无容器的数据库引擎创建演示容器。')
  console.log('')
  console.log('选项：')
  console.log('  --all       为所有引擎创建演示容器，即使已有容器')
  console.log('  --seed      启动每个容器并用演示数据填充')
  console.log('  --dry-run   只显示将要创建的内容，不实际创建')
  console.log('  --help, -h  显示此帮助信息')
  console.log('')
  console.log('示例：')
  console.log('  pnpm generate:missing           # 创建缺少的演示容器')
  console.log('  pnpm generate:missing --all     # 为每个引擎各创建一个')
  console.log('  pnpm generate:missing --seed    # 创建缺少的并用演示数据填充')
  console.log('  pnpm generate:missing --dry-run # 预览将要创建的内容')
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  return {
    all: args.includes('--all'),
    seed: args.includes('--seed'),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  }
}

function hasSeedScript(engine: string): boolean {
  return existsSync(join(__dirname, 'db', `${engine}.ts`))
}

function getCreateArgs(
  engine: string,
  containerName: string,
  version?: string,
): string[] {
  const args = ['create', containerName, '--engine', engine]
  if (version) {
    args.push('--version', version)
  }
  if (FILE_BASED_ENGINES.has(engine)) {
    const ext = FILE_BASED_EXTENSIONS[engine]
    const dbPath = join(getDemoDir(), `${containerName}${ext}`)
    args.push('--path', dbPath)
  }
  return args
}

function runGenerateDb(
  engine: string,
  containerName: string,
  version?: string,
): Promise<number> {
  const scriptPath = join(__dirname, 'db', `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.log(`  没有用于 ${engine} 的填充脚本，跳过填充`)
    return Promise.resolve(0)
  }

  return new Promise((resolve) => {
    let settled = false
    const args = [scriptPath, containerName]
    if (version) {
      args.push('--version', version)
    }
    const child = spawn('tsx', args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        resolve(code ?? 1)
      }
    })
    child.on('error', (err) => {
      console.error(`  运行 ${engine} 的填充脚本时出错：${err.message}`)
      if (!settled) {
        settled = true
        resolve(1)
      }
    })
  })
}

function getExistingContainers(): ContainerConfig[] {
  const result = runSpindb(['list', '--json', '--no-scan'])

  if (!result.success) {
    console.error('列出容器时出错')
    process.exit(1)
  }

  try {
    return JSON.parse(result.output) as ContainerConfig[]
  } catch {
    // 没有容器（空输出）或 JSON 解析错误
    if (result.output.trim()) {
      console.warn('警告：无法解析容器列表输出')
    }
    return []
  }
}

function getEnginesWithContainers(
  containers: ContainerConfig[],
): Set<SupportedEngine> {
  const engines = new Set<SupportedEngine>()
  for (const container of containers) {
    if (SUPPORTED_ENGINES.includes(container.engine as SupportedEngine)) {
      engines.add(container.engine as SupportedEngine)
    }
  }
  return engines
}

function getNextAvailableName(
  baseName: string,
  existingNames: Set<string>,
): string {
  if (!existingNames.has(baseName)) {
    return baseName
  }

  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix++
  }
  return `${baseName}-${suffix}`
}

async function main(): Promise<void> {
  const { all, seed, dryRun, help } = parseArgs()

  if (help) {
    printUsage()
    return
  }

  console.log('缺失数据库生成器')
  console.log('===========================\n')

  if (dryRun) {
    console.log('试运行模式 - 不会实际创建容器\n')
  }

  if (seed) {
    console.log('填充模式 - 容器将被启动并填充演示数据\n')
  }

  console.log('正在检查现有容器...')
  const containers = getExistingContainers()
  const existingEngines = getEnginesWithContainers(containers)
  const existingNames = new Set(containers.map((c) => c.name))

  console.log(`找到 ${containers.length} 个现有容器`)
  if (existingEngines.size > 0) {
    console.log(`已有容器的引擎：${Array.from(existingEngines).join(', ')}`)
  }
  console.log()

  // 确定需要创建容器的引擎
  const enginesToCreate: SupportedEngine[] = all
    ? [...SUPPORTED_ENGINES]
    : SUPPORTED_ENGINES.filter((engine) => !existingEngines.has(engine))

  if (enginesToCreate.length === 0) {
    console.log('所有引擎都已经有容器。无需创建。')
    console.log('使用 --all 标志可创建额外的演示容器。')
    return
  }

  console.log(
    `将创建 ${enginesToCreate.length} 个容器：${enginesToCreate.join(', ')}\n`,
  )

  const created: string[] = []
  const seeded: string[] = []
  const failed: { engine: string; error: string }[] = []

  // 构建要创建的容器列表，展开 VERSION_OVERRIDES
  type CreateTask = {
    engine: SupportedEngine
    containerName: string
    version?: string
  }
  const createTasks: CreateTask[] = []

  for (const engine of enginesToCreate) {
    const overrides = VERSION_OVERRIDES[engine]
    if (overrides) {
      // 引擎有多个版本变体 — 为每个变体创建一个容器
      for (const { version, suffix } of overrides) {
        const baseName = `demo-${engine}${suffix}`
        const containerName = getNextAvailableName(baseName, existingNames)
        createTasks.push({ engine, containerName, version })
        existingNames.add(containerName)
      }
    } else {
      const baseName = `demo-${engine}`
      const containerName = getNextAvailableName(baseName, existingNames)
      createTasks.push({ engine, containerName })
      existingNames.add(containerName)
    }
  }

  for (const { engine, containerName, version } of createTasks) {
    const versionLabel = version ? ` v${version}` : ''

    if (dryRun) {
      const action = seed ? '创建并填充' : '创建'
      console.log(`  [试运行] 将${action}：${containerName}${versionLabel}`)
      created.push(containerName)
      continue
    }

    if (seed && hasSeedScript(engine)) {
      // 使用 generate:db，它处理创建 + 启动 + 填充
      console.log(
        `\n正在创建并填充 ${containerName}（${engine}${versionLabel}）...`,
      )
      console.log('─'.repeat(50))
      const exitCode = await runGenerateDb(engine, containerName, version)

      if (exitCode === 0) {
        created.push(containerName)
        seeded.push(containerName)
      } else {
        failed.push({ engine, error: 'generate:db 失败' })
      }
    } else if (seed && !hasSeedScript(engine)) {
      // 没有填充脚本 — 回退到仅创建
      console.log(
        `正在创建 ${containerName}（${engine} 没有填充脚本${versionLabel}）...`,
      )
      const result = runSpindb(getCreateArgs(engine, containerName, version))

      if (result.success) {
        console.log(`  创建成功（无可用的填充脚本）\n`)
        created.push(containerName)
      } else {
        const errorLine =
          result.output
            .split('\n')
            .find((line) => line.toLowerCase().includes('error')) || '未知错误'
        console.log(`  失败：${errorLine}\n`)
        failed.push({ engine, error: errorLine })
      }
    } else {
      console.log(`正在创建 ${containerName}${versionLabel}...`)
      const result = runSpindb(getCreateArgs(engine, containerName, version))

      if (result.success) {
        console.log(`  创建成功\n`)
        created.push(containerName)
      } else {
        const errorLine =
          result.output
            .split('\n')
            .find((line) => line.toLowerCase().includes('error')) || '未知错误'
        console.log(`  失败：${errorLine}\n`)
        failed.push({ engine, error: errorLine })
      }
    }
  }

  // 汇总
  console.log('\n\n汇总')
  console.log('-------')
  console.log(`已创建：${created.length}`)
  if (created.length > 0) {
    for (const name of created) {
      console.log(`  - ${name}`)
    }
  }

  if (seeded.length > 0) {
    console.log(`已填充：${seeded.length}`)
    for (const name of seeded) {
      console.log(`  - ${name}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\n失败：${failed.length}`)
    for (const { engine, error } of failed) {
      console.log(`  - ${engine}: ${error}`)
    }
  }

  if (!seed) {
    console.log('\n容器已创建但未启动。')
    console.log('启动：spindb start <名称>')
    console.log('用演示数据填充：pnpm generate:db <引擎> <名称>')
  }
}

main().catch((error) => {
  console.error('错误：', error)
  process.exit(1)
})
