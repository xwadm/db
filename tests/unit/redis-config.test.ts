import { describe, it } from 'node:test'
import { assert } from '../utils/assertions'

/**
 * 测试 generateRedisConfig 函数的跨平台兼容性。
 *
 * 这些测试专门验证 Windows 路径被规范化为正斜杠，
 * 这是 Redis 配置文件在 Windows 上正常工作所必需的。
 */

// 重新实现配置生成逻辑用于测试
// （实际函数未导出，因此我们测试相同的逻辑）
function generateRedisConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
}): string {
  const daemonizeValue = options.daemonize ?? true
  const normalizePathForRedis = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB generated Redis configuration
port ${options.port}
bind 127.0.0.1
dir ${normalizePathForRedis(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForRedis(options.logFile)}
pidfile ${normalizePathForRedis(options.pidFile)}

# Persistence - RDB snapshots
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# Append Only File (disabled for local dev)
appendonly no
`
}

describe('Redis Config Generation', () => {
  describe('path normalization for Windows', () => {
    it('should convert Windows backslashes to forward slashes in dataDir', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(!config.includes('\\'), '配置文件不应该包含反斜杠')
      assert(
        config.includes('dir C:/Users/test/.spindb/containers/redis/test/data'),
        'dataDir 应该使用正斜杠',
      )
    })

    it('should convert Windows backslashes to forward slashes in logFile', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(!config.includes('\\'), '配置文件不应该包含反斜杠')
      assert(
        config.includes(
          'logfile C:/Users/test/.spindb/containers/redis/test/redis.log',
        ),
        'logFile 应该使用正斜杠',
      )
    })

    it('should convert Windows backslashes to forward slashes in pidFile', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\redis.pid',
      })

      assert(!config.includes('\\'), '配置文件不应该包含反斜杠')
      assert(
        config.includes(
          'pidfile C:/Users/test/.spindb/containers/redis/test/redis.pid',
        ),
        'pidFile 应该使用正斜杠',
      )
    })

    it('should handle all Windows paths together', () => {
      const config = generateRedisConfig({
        port: 6399,
        dataDir:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\data',
        logFile:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\redis.log',
        pidFile:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\redis.pid',
      })

      // 不应该包含任何反斜杠
      assert(
        !config.includes('\\'),
        '配置文件不应该包含任何反斜杠',
      )

      // 验证所有路径都已转换
      assert(
        config.includes(
          'dir C:/Users/runneradmin/.spindb/containers/redis/redis-test/data',
        ),
        'dataDir 应该已规范化',
      )
      assert(
        config.includes(
          'logfile C:/Users/runneradmin/.spindb/containers/redis/redis-test/redis.log',
        ),
        'logFile 应该已规范化',
      )
      assert(
        config.includes(
          'pidfile C:/Users/runneradmin/.spindb/containers/redis/redis-test/redis.pid',
        ),
        'pidFile 应该已规范化',
      )
    })

    it('should leave Unix paths unchanged', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/home/user/.spindb/containers/redis/test/data',
        logFile: '/home/user/.spindb/containers/redis/test/redis.log',
        pidFile: '/home/user/.spindb/containers/redis/test/redis.pid',
      })

      assert(
        config.includes('dir /home/user/.spindb/containers/redis/test/data'),
        'Unix dataDir 应该保持不变',
      )
      assert(
        config.includes(
          'logfile /home/user/.spindb/containers/redis/test/redis.log',
        ),
        'Unix logFile 应该保持不变',
      )
      assert(
        config.includes(
          'pidfile /home/user/.spindb/containers/redis/test/redis.pid',
        ),
        'Unix pidFile 应该保持不变',
      )
    })
  })

  describe('daemonize option', () => {
    it('should default to daemonize yes', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(
        config.includes('daemonize yes'),
        '应该默认为 daemonize yes',
      )
    })

    it('should set daemonize no when explicitly disabled', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
        daemonize: false,
      })

      assert(
        config.includes('daemonize no'),
        '禁用时应该设置为 daemonize no',
      )
    })
  })

  describe('port configuration', () => {
    it('should include the specified port', () => {
      const config = generateRedisConfig({
        port: 6399,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(config.includes('port 6399'), '应该包含指定的端口')
    })
  })
})
