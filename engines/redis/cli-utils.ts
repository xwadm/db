/**
 * Redis CLI 共享工具函数
 *
 * 提供查找 Redis 二进制文件的通用函数，
 * 供 backup.ts 和 restore.ts 共用，避免代码重复。
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * 获取 redis-cli 二进制文件的路径
 *
 * 查找顺序：
 * 1. configManager 缓存（来自 hostdb 的捆绑/下载的二进制文件）
 * 2. 系统 PATH（回退到系统安装的 redis-tools）
 *
 * @returns redis-cli 路径，如果未找到则返回 null
 */
export async function getRedisCliPath(): Promise<string | null> {
  // 检查是否有来自 hostdb 的缓存/捆绑的 redis-cli
  const cachedPath = await configManager.getBinaryPath('redis-cli')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('redis-cli')
}

/**
 * redis-cli 未找到时的错误提示信息
 * 引导用户通过 hostdb（推荐）或系统包管理器（回退）下载
 */
export const REDIS_CLI_NOT_FOUND_ERROR =
  '未找到 redis-cli。请下载 Redis 二进制文件：\n' +
  '  spindb engines download redis\n' +
  '\n' +
  '或通过系统包管理器安装：\n' +
  '  macOS: brew install redis\n' +
  '  Ubuntu: sudo apt install redis-tools'