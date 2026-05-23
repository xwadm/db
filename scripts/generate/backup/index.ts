#!/usr/bin/env tsx
/**
 * 备份生成脚本调度器。
 *
 * 用法：
 *   pnpm generate:backup <引擎> [参数...]
 *
 * 示例：
 *   pnpm generate:backup qdrant              # 生成 Qdrant 快照固件
 *   pnpm generate:backup qdrant my-snapshot  # 使用自定义名称
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPPORTED_ENGINES = ['qdrant', 'weaviate'] as const
type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

function printUsage(): void {
  console.log('用法：pnpm generate:backup <引擎> [参数...]')
  console.log('')
  console.log('支持的引擎：')
  for (const engine of SUPPORTED_ENGINES) {
    console.log(`  - ${engine}`)
  }
  console.log('')
  console.log('示例：')
  console.log('  pnpm generate:backup qdrant')
  console.log('  pnpm generate:backup qdrant my-snapshot')
}

function isSupported(engine: string): engine is SupportedEngine {
  return SUPPORTED_ENGINES.includes(engine as SupportedEngine)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(args.length === 0 ? 1 : 0)
  }

  const engine = args[0].toLowerCase()
  const engineArgs = args.slice(1)

  if (!isSupported(engine)) {
    console.error(`错误：未知的引擎 "${engine}"`)
    console.error('')
    printUsage()
    process.exit(1)
  }

  const scriptPath = join(__dirname, `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.error(`错误：未找到脚本：${scriptPath}`)
    process.exit(1)
  }

  // 使用 tsx 运行对应引擎的脚本
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
  console.error(`运行脚本时出错：${message}`)
  process.exit(1)
})
