/**
 * Weaviate CLI 共享工具
 *
 * 提供查找 Weaviate 二进制文件的公共函数，
 * 供 backup.ts 和 restore.ts 共同使用，避免重复代码。
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * 获取 weaviate 二进制文件路径
 *
 * 查找顺序：
 * 1. configManager 缓存（来自 hostdb 的捆绑/已下载二进制文件）
 * 2. 系统 PATH（对于系统级别安装的 weaviate 的回退方案）
 *
 * @returns weaviate 路径，未找到则返回 null
 */
export async function getWeaviatePath(): Promise<string | null> {
  // 检查是否有来自 hostdb 的缓存/捆绑 weaviate
  const cachedPath = await configManager.getBinaryPath('weaviate')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // 回退到系统 PATH
  return platformService.findToolPath('weaviate')
}

/**
 * weaviate 二进制文件缺失时的错误提示信息
 * 引导用户通过 hostdb（推荐）或系统包管理器（回退）下载
 */
export const WEAVIATE_NOT_FOUND_ERROR =
  '未找到 weaviate。请下载 Weaviate 二进制文件：\n' +
  '  spindb engines download weaviate\n' +
  '\n' +
  '或通过 Docker 运行：\n' +
  '  docker run -p 8080:8080 semitechnologies/weaviate\n' +
  '\n' +
  '详见：https://weaviate.io/developers/weaviate/installation'