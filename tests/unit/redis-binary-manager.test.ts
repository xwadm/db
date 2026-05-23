import { describe, it, before, after } from 'node:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert } from '../utils/assertions'

/**
 * 测试跨平台兼容性的二进制文件解压逻辑。
 *
 * 这些测试验证 moveExtractedEntries 逻辑能够正确处理
 * 不同的压缩包结构：
 * - Unix: redis/bin/redis-server (包含 bin/ 子目录)
 * - Windows: redis/redis-server.exe (没有 bin/ 子目录，二进制文件在根目录)
 *
 * 解压操作应该将两种结构都规范化为 binPath/bin/ 结构。
 */

let testDir: string

describe('Redis Binary Manager', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-redis-binary-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // 忽略清理错误
    }
  })

  describe('archive structure detection', () => {
    it('should detect Unix structure (has bin/ subdirectory)', async () => {
      // 模拟 Unix 压缩包结构: redis/bin/redis-server
      const extractDir = join(testDir, 'unix-extract')
      const redisDir = join(extractDir, 'redis')
      const binDir = join(redisDir, 'bin')

      await mkdir(binDir, { recursive: true })
      await writeFile(join(binDir, 'redis-server'), 'fake-binary')
      await writeFile(join(binDir, 'redis-cli'), 'fake-binary')
      await writeFile(join(redisDir, 'redis.conf'), 'fake-config')

      // 检查结构
      assert(
        existsSync(join(redisDir, 'bin')),
        'Unix 结构应该包含 bin/ 目录',
      )
      assert(
        existsSync(join(binDir, 'redis-server')),
        'Unix 结构应该在 bin/ 目录中包含 redis-server',
      )
    })

    it('should detect Windows structure (no bin/ subdirectory)', async () => {
      // 模拟 Windows 压缩包结构: redis/redis-server.exe
      const extractDir = join(testDir, 'windows-extract')
      const redisDir = join(extractDir, 'redis')

      await mkdir(redisDir, { recursive: true })
      await writeFile(join(redisDir, 'redis-server.exe'), 'fake-binary')
      await writeFile(join(redisDir, 'redis-cli.exe'), 'fake-binary')
      await writeFile(join(redisDir, 'msys-2.0.dll'), 'fake-dll')
      await writeFile(join(redisDir, 'redis.conf'), 'fake-config')

      // 检查结构 - 不应该包含 bin/ 目录
      assert(
        !existsSync(join(redisDir, 'bin')),
        'Windows 结构不应该包含 bin/ 目录',
      )
      assert(
        existsSync(join(redisDir, 'redis-server.exe')),
        'Windows 结构应该在根目录包含 redis-server.exe',
      )
    })
  })

  describe('moveExtractedEntries logic', () => {
    /**
     * 重新实现 binary-manager.ts 中的核心逻辑用于测试。
     * 这样可以在不需要模拟实际文件操作的情况下测试算法。
     */

    interface FileEntry {
      name: string
      isDirectory: boolean
    }

    function simulateMoveExtractedEntries(sourceEntries: FileEntry[]): {
      hasBinDir: boolean
      destinationMap: Map<string, string>
    } {
      const hasBinDir = sourceEntries.some(
        (e) => e.isDirectory && e.name === 'bin',
      )

      const destinationMap = new Map<string, string>()

      if (hasBinDir) {
        // Unix 结构: 按原样移动所有条目
        for (const entry of sourceEntries) {
          destinationMap.set(entry.name, entry.name)
        }
      } else {
        // Windows 结构: 创建 bin/ 目录并将可执行文件/DLL 移动到该目录
        for (const entry of sourceEntries) {
          const isExecutable = entry.name.endsWith('.exe')
          const isDll = entry.name.endsWith('.dll')
          const destPath =
            isExecutable || isDll ? `bin/${entry.name}` : entry.name
          destinationMap.set(entry.name, destPath)
        }
      }

      return { hasBinDir, destinationMap }
    }

    it('should preserve bin/ structure for Unix archives', () => {
      const unixEntries: FileEntry[] = [
        { name: 'bin', isDirectory: true },
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(unixEntries)

      assert(result.hasBinDir, '应该检测到 bin/ 目录')
      assert(
        result.destinationMap.get('bin') === 'bin',
        'bin/ 目录应该按原样保留',
      )
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        '配置文件应该在根目录保留',
      )
    })

    it('should create bin/ structure for Windows archives', () => {
      const windowsEntries: FileEntry[] = [
        { name: 'redis-server.exe', isDirectory: false },
        { name: 'redis-cli.exe', isDirectory: false },
        { name: 'redis-benchmark.exe', isDirectory: false },
        { name: 'msys-2.0.dll', isDirectory: false },
        { name: 'msys-ssl-3.dll', isDirectory: false },
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
        { name: 'README.md', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(windowsEntries)

      assert(!result.hasBinDir, '不应该检测到 bin/ 目录')

      // 可执行文件应该移动到 bin/ 目录
      assert(
        result.destinationMap.get('redis-server.exe') ===
          'bin/redis-server.exe',
        'redis-server.exe 应该移动到 bin/ 目录',
      )
      assert(
        result.destinationMap.get('redis-cli.exe') === 'bin/redis-cli.exe',
        'redis-cli.exe 应该移动到 bin/ 目录',
      )

      // DLL 文件应该移动到 bin/ 目录（与可执行文件在同一目录）
      assert(
        result.destinationMap.get('msys-2.0.dll') === 'bin/msys-2.0.dll',
        'DLL 文件应该与可执行文件一起移动到 bin/ 目录',
      )
      assert(
        result.destinationMap.get('msys-ssl-3.dll') === 'bin/msys-ssl-3.dll',
        'DLL 文件应该与可执行文件一起移动到 bin/ 目录',
      )

      // 配置文件应该保留在根目录
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        '配置文件应该保留在根目录',
      )
      assert(
        result.destinationMap.get('README.md') === 'README.md',
        'README 文件应该保留在根目录',
      )
    })

    it('should handle empty archives gracefully', () => {
      const emptyEntries: FileEntry[] = []
      const result = simulateMoveExtractedEntries(emptyEntries)

      assert(!result.hasBinDir, '空压缩包不应该包含 bin/ 目录')
      assert(result.destinationMap.size === 0, '没有文件需要映射')
    })

    it('should handle archives with only config files', () => {
      const configOnlyEntries: FileEntry[] = [
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(configOnlyEntries)

      assert(!result.hasBinDir, '不应该检测到 bin/ 目录')
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        '配置文件应该保留在根目录',
      )
    })
  })
})
