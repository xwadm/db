/**
 * MongoDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 MongoDB 二进制文件。
 * 继承 BaseDocumentBinaryManager 并添加 MongoDB 特定配置。
 */

import {
  BaseDocumentBinaryManager,
  type DocumentBinaryManagerConfig,
} from '../../core/base-document-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MongoDBBinaryManager extends BaseDocumentBinaryManager {
  protected readonly config: DocumentBinaryManagerConfig = {
    engine: Engine.MongoDB,
    engineName: 'mongodb',
    displayName: 'MongoDB',
    serverBinary: 'mongod',
  }

  protected getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }

  protected normalizeVersionFromModule(version: string): string {
    return normalizeVersion(version)
  }

  protected parseVersionFromOutput(stdout: string): string | null {
    // 从类似 "db version v7.0.28" 的输出中提取版本号
    const match = stdout.match(/db version v(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    // 回退：尝试匹配任何 semver 风格的版本号
    const altMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    return altMatch?.[1] ?? null
  }
}

export const mongodbBinaryManager = new MongoDBBinaryManager()
