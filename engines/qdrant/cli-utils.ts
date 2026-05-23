/**
 * Qdrant CLI 公共工具
 *
 * 提供定位 Qdrant 二进制文件的通用函数，
 * 供 backup.ts 和 restore.ts 共用，避免重复代码。
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * 获取 qdrant 二进制文件路径
 *
 * 查找顺序：
 * 1. configManager 缓存（来自 hostdb 的内置/已下载二进制文件）
 * 2. 系统 PATH（回退到系统安装的 qdrant）
 *
 * @returns qdrant 路径，未找到时返回 null
 */
export async function getQdrantPath(): Promise<string | null> {
  // 检查是否已有来自 hostdb 的缓存/内置 qdrant
  const cachedPath = await configManager.getBinaryPath('qdrant')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('qdrant')
}

/**
 * qdrant 二进制文件缺失时的错误提示
 * 引导用户通过 hostdb（推荐）或系统包管理器（回退）下载
 */
export const QDRANT_NOT_FOUND_ERROR =
  '未找到 qdrant。请下载 Qdrant 二进制文件：\n' +
  '  spindb engines download qdrant\n' +
  '\n' +
  '或通过 Docker 运行：\n' +
  '  docker run -p 6333:6333 qdrant/qdrant\n' +
  '\n' +
  '参见: https://qdrant.tech/documentation/guides/installation/'