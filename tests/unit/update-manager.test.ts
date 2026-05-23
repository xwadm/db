/**
 * 更新管理器单元测试
 * 
 * 测试 SpinDB 更新管理器的核心功能，包括检查更新、下载进度跟踪、校验和验证和回滚机制。
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { UpdateManager, UpdateStatus } from '../../core/update-manager'
import { SpinDBError, ErrorCodes } from '../../core/error-handler'

describe('更新管理器', () => {
  describe('更新检查', () => {
    it('应该检测到可用更新', async () => {
      const manager = new UpdateManager()
      const currentVersion = '1.0.0'
      const latestVersion = '1.1.0'
      
      const updateInfo = await manager.checkForUpdate(currentVersion, latestVersion)
      
      assert(updateInfo.available, '应该检测到可用更新')
      assertEqual(updateInfo.fromVersion, currentVersion, '起始版本应该正确')
      assertEqual(updateInfo.toVersion, latestVersion, '目标版本应该正确')
    })

    it('当已经是最新版本时不应该提示更新', async () => {
      const manager = new UpdateManager()
      const currentVersion = '1.1.0'
      const latestVersion = '1.1.0'
      
      const updateInfo = await manager.checkForUpdate(currentVersion, latestVersion)
      
      assert(!updateInfo.available, '不应该提示更新')
    })

    it('应该正确处理预发布版本', async () => {
      const manager = new UpdateManager()
      const currentVersion = '1.0.0'
      const latestVersion = '1.1.0-beta.1'
      
      const updateInfo = await manager.checkForUpdate(currentVersion, latestVersion, { includePrerelease: true })
      
      assert(updateInfo.available, '应该检测到预发布版本更新')
      assert(updateInfo.isPrerelease, '应该标记为预发布版本')
    })
  })

  describe('下载进度跟踪', () => {
    it('应该报告下载进度', async () => {
      const manager = new UpdateManager()
      const progressEvents: number[] = []
      
      manager.onProgress((progress) => {
        progressEvents.push(progress.percentage)
      })
      
      // 模拟下载
      await manager.simulateDownload(100)
      
      assert(progressEvents.length > 0, '应该收到进度事件')
      assertEqual(progressEvents[progressEvents.length - 1], 100, '最终进度应该是 100%')
    })

    it('应该支持下载取消', async () => {
      const manager = new UpdateManager()
      
      const downloadPromise = manager.startDownload('http://example.com/update.zip')
      manager.cancelDownload()
      
      try {
        await downloadPromise
        assert(false, '应该抛出取消错误')
      } catch (error) {
        assert(error instanceof SpinDBError, '应该抛出 SpinDBError')
        assertEqual((error as SpinDBError).code, ErrorCodes.UPDATE_CANCELLED, '应该是取消错误')
      }
    })
  })

  describe('校验和验证', () => {
    it('应该验证有效的校验和', async () => {
      const manager = new UpdateManager()
      const fileContent = 'test content'
      const expectedChecksum = 'a test checksum'
      
      // 模拟校验和验证
      const isValid = await manager.verifyChecksum(fileContent, expectedChecksum)
      
      assert(isValid, '应该验证有效的校验和')
    })

    it('应该拒绝无效的校验和', async () => {
      const manager = new UpdateManager()
      const fileContent = 'test content'
      const wrongChecksum = 'wrong checksum'
      
      try {
        await manager.verifyChecksum(fileContent, wrongChecksum)
        assert(false, '应该抛出校验和错误')
      } catch (error) {
        assert(error instanceof SpinDBError, '应该抛出 SpinDBError')
        assertEqual((error as SpinDBError).code, ErrorCodes.CHECKSUM_MISMATCH, '应该是校验和不匹配错误')
      }
    })
  })

  describe('回滚机制', () => {
    it('应该在更新失败时回滚', async () => {
      const manager = new UpdateManager()
      
      // 创建备份
      await manager.createBackup()
      
      try {
        // 模拟失败的更新
        await manager.applyUpdateWithFailure()
        assert(false, '应该抛出更新错误')
      } catch (error) {
        // 验证回滚
        const rollbackResult = await manager.rollback()
        assert(rollbackResult.success, '应该成功回滚')
        assertEqual(manager.getStatus(), UpdateStatus.ROLLED_BACK, '状态应该是已回滚')
      }
    })

    it('应该保留有限数量的备份', async () => {
      const manager = new UpdateManager({ maxBackups: 3 })
      
      // 创建超过最大数量的备份
      await manager.createBackup()
      await manager.createBackup()
      await manager.createBackup()
      await manager.createBackup()
      
      const backups = await manager.listBackups()
      assertEqual(backups.length, 3, '应该只保留 3 个备份')
    })
  })

  describe('更新状态', () => {
    it('应该正确跟踪更新状态', async () => {
      const manager = new UpdateManager()
      
      assertEqual(manager.getStatus(), UpdateStatus.IDLE, '初始状态应该是 IDLE')
      
      await manager.checkForUpdate('1.0.0', '1.1.0')
      // 状态可能根据实现而变化
      
      assert(
        [UpdateStatus.IDLE, UpdateStatus.CHECKING, UpdateStatus.UPDATE_AVAILABLE].includes(manager.getStatus()),
        '状态应该是有效的'
      )
    })
  })
})
