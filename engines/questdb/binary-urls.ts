/**
 * QuestDB 二进制文件 URL 生成
 *
 * 从 layerbase 注册表构建 QuestDB 二进制文件的下载 URL。
 * QuestDB 归档是自包含的，附带捆绑的 JRE。
 *
 * URL 格式：
 * https://registry.layerbase.host/questdb-{version}/questdb-{version}-{platform}-{arch}.tar.gz
 */

import { FALLBACK_VERSION_MAP } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * 获取指定版本和平台的二进制文件下载 URL
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  // 解析为完整版本
  const fullVersion = FALLBACK_VERSION_MAP[version] || version

  // Windows 使用 .zip，Unix 使用 .tar.gz
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.QuestDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}
