/**
 * InfluxDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 InfluxDB 二进制文件。
 * 继承 BaseBinaryManager 以复用通用的下载/解压逻辑。
 *
 * InfluxDB 3.x 压缩包解压后为扁平的 `influxdb/` 目录结构：
 *   influxdb/
 *   ├── influxdb3           （服务端二进制文件）
 *   ├── python/             （捆绑的 Python 运行时）
 *   │   └── lib/
 *   │       └── libpython3.13.dylib
 *   ├── LICENSE-APACHE
 *   └── LICENSE-MIT
 *
 * 二进制文件使用 @executable_path/python/lib/libpython3.13.dylib，
 * 因此 python/ 必须与二进制文件位于同一目录。我们重新组织为：
 *   bin/
 *   ├── influxdb3
 *   └── python/             （与二进制文件同目录，用于 @executable_path 解析）
 */

import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { moveEntry } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { getWindowsDllEnv } from '../../core/library-env'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class InfluxDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.InfluxDB,
    engineName: 'influxdb',
    displayName: 'InfluxDB',
    serverBinary: 'influxdb3',
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
    // 从类似 "influxdb3 3.8.0" 或 "InfluxDB 3 Edge v3.8.0" 的输出中提取版本号
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * 在 Windows 上，influxdb3.exe 在加载时依赖 python313.dll
   * （捆绑的 Python 运行时，用于 PYO3）。该 DLL 位于 bin/python/ 目录，
   * 但 Windows 默认只搜索应用程序目录。将 bin/python/ 添加到 PATH
   * 使其可被发现。
   */
  protected override getSpawnEnv(binPath: string): Record<string, string> | undefined {
    return getWindowsDllEnv(join(binPath, 'bin', 'python'))
  }

  /**
   * 重写 moveExtractedEntries 以将 python/ 与二进制文件放置在同一目录。
   *
   * influxdb3 二进制文件引用 @executable_path/python/lib/libpython3.13.dylib，
   * 因此 python/ 目录必须位于 bin/ 内，与二进制文件相邻。
   * 默认的扁平结构处理器会将 python/ 放在 binPath/python/ 而不是
   * binPath/bin/python/，导致 dylib 加载失败。
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // 查找 influxdb 目录（例如 "influxdb" 或 "influxdb-3.8.0"）
    const influxDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'influxdb' || e.name.startsWith('influxdb-')),
    )

    const sourceDir = influxDir ? join(extractDir, influxDir.name) : extractDir
    const sourceEntries = influxDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // 创建 bin/ 目录
    const destBinDir = join(binPath, 'bin')
    await mkdir(destBinDir, { recursive: true })

    for (const entry of sourceEntries) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'influxdb3' || entry.name === 'influxdb3.exe') {
        // 服务端二进制文件 → bin/
        await moveEntry(sourcePath, join(destBinDir, entry.name))
      } else if (entry.name === 'python') {
        // Python 运行时 → bin/python/（必须与二进制文件同目录，用于 @executable_path 解析）
        await moveEntry(sourcePath, join(destBinDir, 'python'))
      } else {
        // 许可证、元数据等 → binPath 根目录
        await moveEntry(sourcePath, join(binPath, entry.name))
      }
    }

    logDebug('InfluxDB 二进制文件已重新组织，python/ 已放置在 bin/ 中与二进制文件同目录')
  }
}

export const influxdbBinaryManager = new InfluxDBBinaryManager()
