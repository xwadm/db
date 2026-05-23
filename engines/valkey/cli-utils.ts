/**
 * Valkey CLI 共享工具函数
 *
 * 提供定位 Valkey 二进制文件的通用函数，
 * 供 backup.ts 和 restore.ts 共用，避免代码重复。
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * 获取 valkey-cli 二进制文件的路径
 *
 * 查找顺序：
 * 1. configManager 缓存（从 hostdb 下载/打包的二进制文件）
 * 2. 系统 PATH（回退到系统安装的 valkey-tools）
 *
 * @returns valkey-cli 路径，如果未找到则返回 null
 */
export async function getValkeyCliPath(): Promise<string | null> {
  // 检查是否已有来自 hostdb 的缓存/打包的 valkey-cli
  const cachedPath = await configManager.getBinaryPath('valkey-cli')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('valkey-cli')
}

/**
 * valkey-cli 未找到时的错误提示信息
 * 引导用户通过 hostdb（推荐）或系统包管理器（回退）下载
 */
export const VALKEY_CLI_NOT_FOUND_ERROR =
  '未找到 valkey-cli。请下载 Valkey 二进制文件：\n' +
  '  spindb engines download valkey\n' +
  '\n' +
  '或进行系统级安装：\n' +
  '  macOS: brew install valkey\n' +
  '  Ubuntu: sudo apt install valkey-tools'