/**
 * Pull manager 测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  calculateDownloadProgress,
  formatBytes,
  formatSpeed,
  formatEta,
} from '../../core/pull-manager'

describe('Pull Manager', () => {
  describe('calculateDownloadProgress', () => {
    it('should calculate progress correctly', () => {
      const progress = calculateDownloadProgress(50, 100)

      assertEqual(progress.percentage, 50, '应为 50%')
      assertEqual(progress.downloaded, 50, '应已下载 50 字节')
      assertEqual(progress.total, 100, '总计应为 100 字节')
    })

    it('should handle zero total', () => {
      const progress = calculateDownloadProgress(0, 0)

      assertEqual(progress.percentage, 0, '当总计为 0 时应为 0%')
    })

    it('should cap percentage at 100', () => {
      const progress = calculateDownloadProgress(150, 100)

      assertEqual(progress.percentage, 100, '应限制在 100%')
    })

    it('should handle complete download', () => {
      const progress = calculateDownloadProgress(100, 100)

      assertEqual(progress.percentage, 100, '完成时应为 100%')
      assert(progress.isComplete, '应标记为已完成')
    })
  })

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      assertEqual(formatBytes(0), '0 B', '应格式化 0 字节')
      assertEqual(formatBytes(512), '512 B', '应格式化 512 字节')
      assertEqual(formatBytes(1024), '1.00 KB', '应格式化 1 KB')
      assertEqual(formatBytes(1536), '1.50 KB', '应格式化 1.5 KB')
      assertEqual(formatBytes(1024 * 1024), '1.00 MB', '应格式化 1 MB')
      assertEqual(formatBytes(1024 * 1024 * 1024), '1.00 GB', '应格式化 1 GB')
    })

    it('should use correct units', () => {
      assert(formatBytes(1024).includes('KB'), '应使用 KB')
      assert(formatBytes(1024 * 1024).includes('MB'), '应使用 MB')
      assert(formatBytes(1024 * 1024 * 1024).includes('GB'), '应使用 GB')
    })
  })

  describe('formatSpeed', () => {
    it('should format speed correctly', () => {
      assertEqual(formatSpeed(0), '0 B/s', '应格式化 0 速度')
      assertEqual(formatSpeed(512), '512 B/s', '应格式化 512 B/s')
      assertEqual(formatSpeed(1024), '1.00 KB/s', '应格式化 1 KB/s')
      assertEqual(formatSpeed(1024 * 1024), '1.00 MB/s', '应格式化 1 MB/s')
    })

    it('should include /s suffix', () => {
      assert(formatSpeed(100).includes('/s'), '应包含 /s')
    })
  })

  describe('formatEta', () => {
    it('should format ETA correctly', () => {
      assertEqual(formatEta(0), '0s', '应格式化 0 秒')
      assertEqual(formatEta(30), '30s', '应格式化 30 秒')
      assertEqual(formatEta(60), '1m 0s', '应格式化 1 分钟')
      assertEqual(formatEta(90), '1m 30s', '应格式化 1m 30s')
      assertEqual(formatEta(3600), '1h 0m 0s', '应格式化 1 小时')
    })

    it('should handle large ETAs', () => {
      const eta = formatEta(86400) // 1 天
      assert(eta.includes('h'), '对于较大的 ETA 应包含小时')
    })
  })
})
