#!/usr/bin/env tsx
/**
 * 删除所有由 generate:db 或 generate:missing 创建的演示容器。
 *
 * 这是一个仅用于开发的工具，用于清理演示容器。
 *
 * 用法：
 *   pnpm delete:demos           # 删除所有 demo-* 容器
 *   pnpm delete:demos --dry-run # 显示将要删除的内容
 *   pnpm delete:demos --help    # 显示帮助
 */

import {
  runSpindb,
  runSpindbStreaming,
  type ContainerConfig,
} from './db/_shared.js'

type ParsedArgs = {
  dryRun: boolean
  help: boolean
}

function printUsage(): void {
  console.log('用法：pnpm delete:demos [选项]')
  console.log('')
  console.log('删除由生成脚本创建的所有演示容器（demo-*）。')
  console.log('')
  console.log('选项：')
  console.log('  --dry-run   只显示将要删除的内容，不实际删除')
  console.log('  --help, -h  显示此帮助信息')
  console.log('')
  console.log('示例：')
  console.log('  pnpm delete:demos           # 删除所有 demo-* 容器')
  console.log('  pnpm delete:demos --dry-run # 预览将要删除的内容')
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  return {
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  }
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
    return []
  }
}

function isDemoContainer(name: string): boolean {
  return name.startsWith('demo-')
}

async function main(): Promise<void> {
  const { dryRun, help } = parseArgs()

  if (help) {
    printUsage()
    return
  }

  console.log('删除演示容器')
  console.log('======================\n')

  if (dryRun) {
    console.log('试运行模式 - 不会实际删除容器\n')
  }

  console.log('正在查找演示容器...')
  const containers = getExistingContainers()
  const demoContainers = containers.filter((c) => isDemoContainer(c.name))

  if (demoContainers.length === 0) {
    console.log('没有找到演示容器（demo-*）。')
    return
  }

  console.log(`找到 ${demoContainers.length} 个演示容器：\n`)
  for (const container of demoContainers) {
    const status = container.status === 'running' ? '● 运行中' : '○ 已停止'
    console.log(`  - ${container.name} (${container.engine}) [${status}]`)
  }
  console.log()

  const deleted: string[] = []
  const wouldDelete: string[] = []
  const failed: { name: string; error: string }[] = []

  for (const container of demoContainers) {
    const { name, status } = container

    if (dryRun) {
      if (status === 'running') {
        console.log(`[试运行] 将停止：${name}`)
      }
      console.log(`[试运行] 将删除：${name}\n`)
      wouldDelete.push(name)
      continue
    }

    // 如果正在运行则停止
    if (status === 'running') {
      console.log(`正在停止 ${name}...`)
      const stopCode = await runSpindbStreaming(['stop', name])
      if (stopCode !== 0) {
        console.log(`  警告：停止 ${name} 失败，无论如何尝试删除\n`)
      }
    }

    // 使用 force 标志删除
    console.log(`正在删除 ${name}...`)
    const result = runSpindb(['delete', name, '--force'])

    if (result.success) {
      console.log(`  删除成功\n`)
      deleted.push(name)
    } else {
      const errorLine =
        result.output
          .split('\n')
          .find((line) => line.toLowerCase().includes('error')) || '未知错误'
      console.log(`  失败：${errorLine}\n`)
      failed.push({ name, error: errorLine })
    }
  }

  // 汇总
  console.log('汇总')
  console.log('-------')

  if (dryRun) {
    console.log(`将删除：${wouldDelete.length}`)
    if (wouldDelete.length > 0) {
      for (const name of wouldDelete) {
        console.log(`  - ${name}`)
      }
    }
  } else {
    console.log(`已删除：${deleted.length}`)
    if (deleted.length > 0) {
      for (const name of deleted) {
        console.log(`  - ${name}`)
      }
    }

    if (failed.length > 0) {
      console.log(`\n失败：${failed.length}`)
      for (const { name, error } of failed) {
        console.log(`  - ${name}: ${error}`)
      }
    }
  }
}

main().catch((error) => {
  console.error('错误：', error)
  process.exit(1)
})
