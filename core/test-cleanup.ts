/**
 * 测试容器清理工具
 *
 * 提供检测和删除孤立测试容器的功能。
 * 可由 doctor 命令使用，或在测试后直接调用。
 */

import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { paths } from '../config/paths'
import { getSupportedEngines } from '../config/engine-defaults'

// 测试容器检测模式
// 这些匹配集成测试使用的命名约定
export const TEST_CONTAINER_PATTERNS = [
  // 模式: name-test_<8位十六进制>（例如 duckdb-test_04b0613f）
  /^.+-test_[0-9a-f]{6,}$/i,
  // 模式: name-test-suffix_<8位十六进制>（例如 ferretdb-test-conflict_21e4d447）
  /^.+-test-.+_[0-9a-f]{6,}$/i,
  // 模式: name-test-renamed_<8位十六进制>（例如 mysql-test-renamed-1862f018）
  /^.+-test-renamed[-_][0-9a-f]{6,}$/i,
]

export type OrphanedTestContainer = {
  engine: string
  name: string
  path: string
}

/**
 * 检查容器名称是否匹配测试容器模式。
 */
export function isTestContainer(name: string): boolean {
  return TEST_CONTAINER_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * 查找所有孤立的测试容器目录。
 * 直接扫描文件系统，因为这些可能没有有效的 container.json 文件。
 *
 * @returns 孤立测试容器信息数组
 */
export async function findOrphanedTestContainers(): Promise<
  OrphanedTestContainer[]
> {
  const containersDir = paths.containers
  if (!existsSync(containersDir)) {
    return []
  }

  const engines = getSupportedEngines()
  const testDirs: OrphanedTestContainer[] = []

  for (const engine of engines) {
    const engineDir = paths.getEngineContainersPath(engine)
    if (!existsSync(engineDir)) {
      continue
    }

    try {
      const entries = await readdir(engineDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && isTestContainer(entry.name)) {
          testDirs.push({
            engine,
            name: entry.name,
            path: join(engineDir, entry.name),
          })
        }
      }
    } catch {
      // 忽略读取目录时的错误
    }
  }

  return testDirs
}

/**
 * 删除单个孤立的测试容器目录。
 *
 * @param container - 要删除的容器
 */
export async function deleteTestContainer(
  container: OrphanedTestContainer,
): Promise<void> {
  await rm(container.path, { recursive: true, force: true })
}

/**
 * 并行删除所有孤立的测试容器。
 * 适用于集成测试后的清理。
 *
 * @returns 成功删除的容器数量
 */
export async function cleanupTestContainers(): Promise<number> {
  const orphaned = await findOrphanedTestContainers()

  const results = await Promise.allSettled(
    orphaned.map((container) => deleteTestContainer(container)),
  )

  // 统计成功删除的数量
  const successCount = results.filter((r) => r.status === 'fulfilled').length

  return successCount
}
