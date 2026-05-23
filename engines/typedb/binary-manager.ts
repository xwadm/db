/**
 * TypeDB 二进制管理器
 *
 * 负责从 hostdb 下载、解压和管理 TypeDB 二进制文件。
 * 继承自 BaseBinaryManager，复用共享的下载/解压逻辑。
 *
 * TypeDB 归档文件解压后产生一个 `typedb/` 目录，嵌套结构如下：
 *   typedb/
 *   ├── typedb                  （启动脚本）
 *   ├── server/
 *   │   ├── typedb_server_bin   （服务器二进制文件）
 *   │   └── config.yml          （默认配置）
 *   ├── console/
 *   │   └── typedb_console_bin  （控制台二进制文件）
 *   └── LICENSE
 *
 * 我们重新组织目录结构，保留启动脚本所期望的相对路径：
 *   bin/
 *   ├── typedb                  （启动器）
 *   ├── server/
 *   │   └── typedb_server_bin   （服务器二进制文件）
 *   ├── console/
 *   │   └── typedb_console_bin  （控制台二进制文件）
 *   └── config.yml              （移出供参考）
 *   server/
 *   └── config.yml              （默认配置供参考）
 */

import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { moveEntry } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'

class TypeDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.TypeDB,
    engineName: 'typedb',
    displayName: 'TypeDB',
    serverBinary: 'typedb',
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
    // 尝试三段式语义化版本号（如 "3.8.0"）
    const threePartMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    if (threePartMatch) {
      return threePartMatch[1]
    }

    // 回退：两段式版本号（如 "3.8"）
    const twoPartMatch = stdout.match(/(\d+\.\d+)/)
    if (twoPartMatch) {
      logDebug(
        `TypeDB 版本解析为两段式: ${twoPartMatch[1]} (来源: ${stdout.trim().slice(0, 100)})`,
      )
      return twoPartMatch[1]
    }

    logDebug(
      `无法从输出中解析 TypeDB 版本: ${stdout.trim().slice(0, 100)}`,
    )
    return null
  }

  /**
   * 重写 moveExtractedEntries 以处理 TypeDB 的嵌套目录结构。
   *
   * TypeDB 归档解压为：typedb/server/typedb_server_bin、typedb/console/typedb_console_bin
   * 重新组织为：bin/typedb、bin/server/typedb_server_bin、bin/console/typedb_console_bin
   * 并保留 server/config.yml 供参考。
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const ext = process.platform === 'win32' ? '.exe' : ''
    const batExt = process.platform === 'win32' ? '.bat' : ''

    // 找到 typedb 目录（如 "typedb" 或 "typedb-3.8.0"）
    const typedbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'typedb' || e.name.startsWith('typedb-')),
    )

    const sourceDir = typedbDir ? join(extractDir, typedbDir.name) : extractDir

    // 创建 bin/ 目录
    const destBinDir = join(binPath, 'bin')
    await mkdir(destBinDir, { recursive: true })

    // 将启动脚本移动到 bin/
    const launcherName = `typedb${batExt}`
    const launcherPath = join(sourceDir, launcherName)
    if (existsSync(launcherPath)) {
      await moveEntry(launcherPath, join(destBinDir, launcherName))
    }

    // 将 server/ 目录移入 bin/（保留启动器所需的 bin/server/typedb_server_bin 路径）
    const destServerDir = join(destBinDir, 'server')
    await mkdir(destServerDir, { recursive: true })
    const serverBinName = `typedb_server_bin${ext}`
    const serverBinPath = join(sourceDir, 'server', serverBinName)
    if (existsSync(serverBinPath)) {
      await moveEntry(serverBinPath, join(destServerDir, serverBinName))
    }

    // 将 console/ 目录移入 bin/（保留启动器所需的 bin/console/typedb_console_bin 路径）
    const destConsoleDir = join(destBinDir, 'console')
    await mkdir(destConsoleDir, { recursive: true })
    const consoleBinName = `typedb_console_bin${ext}`
    const consoleBinPath = join(sourceDir, 'console', consoleBinName)
    if (existsSync(consoleBinPath)) {
      await moveEntry(consoleBinPath, join(destConsoleDir, consoleBinName))
    }

    // 保留 server/config.yml 作为参考配置
    const configPath = join(sourceDir, 'server', 'config.yml')
    if (existsSync(configPath)) {
      const destRefServerDir = join(binPath, 'server')
      await mkdir(destRefServerDir, { recursive: true })
      await moveEntry(configPath, join(destRefServerDir, 'config.yml'))
    }

    // 如果存在 LICENSE 则移动
    const licensePath = join(sourceDir, 'LICENSE')
    if (existsSync(licensePath)) {
      await moveEntry(licensePath, join(binPath, 'LICENSE'))
    }

    logDebug('TypeDB 二进制文件已重新组织为标准 bin/ 布局')
  }

  /**
   * 重写 verify 方法以处理 TypeDB 的启动脚本。
   * TypeDB 的主二进制文件是一个启动脚本，而非可直接执行的文件。
   * 我们改为验证实际的服务器二进制文件存在，而不是运行 --version。
   */
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === Platform.Win32 ? '.exe' : ''
    const batExt = platform === Platform.Win32 ? '.bat' : ''
    const launcherPath = join(binPath, 'bin', `typedb${batExt}`)
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)
    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )

    if (!existsSync(launcherPath)) {
      throw new Error(`TypeDB 启动器未找到: ${launcherPath}`)
    }

    if (!existsSync(serverPath)) {
      throw new Error(`TypeDB 服务器二进制文件未找到: ${serverPath}`)
    }

    if (!existsSync(consolePath)) {
      throw new Error(`TypeDB 控制台二进制文件未找到: ${consolePath}`)
    }

    return true
  }
}

export const typedbBinaryManager = new TypeDBBinaryManager()
