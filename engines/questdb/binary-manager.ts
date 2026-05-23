/**
 * QuestDB 二进制文件管理器
 *
 * 负责从 hostdb 下载、解压和管理 QuestDB 二进制文件。
 * QuestDB 是一款基于 Java 的数据库，内置了 JRE。
 *
 * 归档结构：
 * questdb/
 * ├── questdb.sh         # 启动脚本 (Unix)
 * ├── questdb.exe        # 启动脚本 (Windows)
 * ├── questdb.jar        # 主应用程序
 * ├── lib/               # 依赖项
 * └── jre/               # 内置 JRE
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch, type ProgressCallback } from '../../types'
import { existsSync } from 'fs'
import { join, dirname, relative } from 'path'
import { chmod, symlink, readdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { getReleasesUrls } from '../../core/hostdb-client'
import { moveEntry } from '../../core/fs-error-utils'
import { paths } from '../../config/paths'

class QuestDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.QuestDB,
    engineName: 'questdb',
    displayName: 'QuestDB',
    serverBinary: 'questdb.sh', // Unix 启动脚本
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

  /**
   * 从 QuestDB 输出中解析版本信息
   * 可以通过 questdb.sh/exe 脚本获取 QuestDB 版本
   */
  protected parseVersionFromOutput(stdout: string): string | null {
    // QuestDB 输出类似 "QuestDB 9.2.3" 的版本信息
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * 覆盖 isInstalled 方法，以检查 questdb.sh（Unix）或 questdb.exe（Windows）
   * 注意：归档结构因平台而异：
   * - macOS: questdb.sh 位于根目录 (questdb/questdb.sh)
   * - Linux: questdb.sh 位于 bin/ 子目录 (questdb/bin/questdb.sh)
   */
  override async isInstalled(
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

    // 检查启动脚本 - 可能位于根目录或 bin/ 子目录中
    if (platform === Platform.Win32) {
      const exePath = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      return existsSync(exePath) || existsSync(exePathBin)
    } else {
      const shPath = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      return existsSync(shPath) || existsSync(shPathBin)
    }
  }

  /**
   * 覆盖 moveExtractedEntries 方法，以保留 QuestDB 独特的目录结构。
   * QuestDB 的 questdb.sh/exe 位于根目录级别（而非 bin/ 目录），与 lib/ 和 jre/ 并列。
   * 基类会尝试将 questdb.sh 移动到 bin/ 中，这会破坏我们的目录结构。
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    // 使用 console.log 以便在 CI 中可见（logDebug 需要 --debug 标志）
    console.log(
      `[QuestDB] 解压结果：找到 ${entries.length} 个条目：${entries.map((e) => e.name).join(', ')}`,
    )

    // 查找 questdb 目录 - 可能为：
    // - "questdb"（简单名称）
    // - "questdb-9.2.3"（带版本号）
    // - "questdb-9.2.3-linux-x64"（完整的归档名称）
    const questdbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'questdb' || e.name.startsWith('questdb-')),
    )

    let sourceDir = extractDir
    let sourceEntries = entries

    if (questdbDir) {
      console.log(`[QuestDB] 找到 questdb 目录：${questdbDir.name}`)
      sourceDir = join(extractDir, questdbDir.name)
      sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      console.log(
        `[QuestDB] 目录内容：${sourceEntries.map((e) => e.name).join(', ')}`,
      )
    } else {
      // 检查 questdb.sh 是否直接位于 extractDir 中（无子目录）
      const hasQuestdbSh = entries.some(
        (e) => e.name === 'questdb.sh' || e.name === 'questdb.exe',
      )
      if (hasQuestdbSh) {
        console.log(`[QuestDB] 直接在 extractDir 中找到 questdb.sh`)
      } else {
        console.log(`[QuestDB] 警告：未找到 questdb 目录`)
      }
    }

    // 按原样移动所有条目，保留 QuestDB 的结构：
    console.log(
      `[QuestDB] 正在将 ${sourceEntries.length} 个条目移动到 ${binPath}`,
    )
    for (const entry of sourceEntries) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(binPath, entry.name)
      await moveEntry(sourcePath, destPath)
    }

    // 验证 questdb.sh 是否已移动
    const expectedScript = join(binPath, 'questdb.sh')
    if (existsSync(expectedScript)) {
      console.log(`[QuestDB] 成功：在 ${expectedScript} 找到 questdb.sh`)
    } else {
      const binContents = await readdir(binPath).catch(() => ['（读取失败）'])
      console.log(
        `[QuestDB] 错误：未找到 questdb.sh。binPath 目录内容：${binContents.join(', ')}`,
      )
    }
  }

  /**
   * 解压后，确保启动脚本具有可执行权限，并创建 java 符号链接
   * 归档结构因平台而异：
   * - macOS: questdb.sh 位于根目录，jre/bin/java
   * - （下一行有意留空，避免过早结束注释）
   * - Linux: bin/questdb.sh, lib/jvm/ * /bin/java (标准 JRE 布局)
   */
  async postExtract(binPath: string, platform: Platform): Promise<void> {
    if (platform !== Platform.Win32) {
      // 赋予启动脚本可执行权限 - 同时检查两个位置
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')

      if (existsSync(shPathRoot)) {
        await chmod(shPathRoot, 0o755)
        logDebug(`已赋予 questdb.sh 可执行权限：${shPathRoot}`)
      }
      if (existsSync(shPathBin)) {
        await chmod(shPathBin, 0o755)
        logDebug(`已赋予 questdb.sh 可执行权限：${shPathBin}`)
      }

      // 针对 macOS 结构：在根目录创建从 'java' 到 'jre/bin/java' 的符号链接
      // questdb.sh 会检查 $BASE/java 来判断是否内置了 JRE
      // 使用相对路径，这样即使 binPath 被移动，符号链接也能正常工作
      const javaSymlink = join(binPath, 'java')
      const javaTarget = join(binPath, 'jre', 'bin', 'java')
      if (existsSync(javaTarget) && !existsSync(javaSymlink)) {
        try {
          const relativeTarget = relative(dirname(javaSymlink), javaTarget)
          await symlink(relativeTarget, javaSymlink)
          logDebug(`已创建 java 符号链接：${javaSymlink} -> ${relativeTarget}`)
        } catch (error) {
          logDebug(`创建 java 符号链接失败：${error}`)
        }
      }
    }
  }

  /**
   * 覆盖 verify 方法，以检查 QuestDB 的正确路径结构
   * 归档结构因平台而异：
   * - macOS: questdb.sh 位于根目录
   * - Linux: questdb.sh 位于 bin/ 子目录
   * 此外，QuestDB 不支持 --version 标志（Java 应用程序）
   */
  override async verify(
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

    // 检查启动脚本是否位于根目录或 bin/ 子目录中
    const scriptName =
      platform === Platform.Win32 ? 'questdb.exe' : 'questdb.sh'
    const scriptPathRoot = join(binPath, scriptName)
    const scriptPathBin = join(binPath, 'bin', scriptName)

    if (!existsSync(scriptPathRoot) && !existsSync(scriptPathBin)) {
      throw new Error(
        `${this.config.displayName} 二进制文件未找到，位于 ${scriptPathRoot} 或 ${scriptPathBin}`,
      )
    }

    // QuestDB 是 Java 应用程序 - 启动脚本是主要的验证依据
    // jar 文件在不同版本中可能位于不同位置，因此我们仅发出警告
    const jarPath = join(binPath, 'questdb.jar')
    if (!existsSync(jarPath)) {
      logDebug(
        `在 ${jarPath} 未找到 QuestDB jar 文件（启动脚本已找到，将继续执行）`,
      )
    }

    logDebug(`QuestDB 二进制文件已在 ${binPath} 验证通过`)
    return true
  }

  /**
   * 在尝试下载前，检查 hostdb 中是否提供了 QuestDB 二进制文件
   */
  private async checkHostdbAvailability(): Promise<boolean> {
    try {
      // 首先尝试 layerbase，失败时回退到 GitHub
      let response: Response | null = null
      for (const url of getReleasesUrls()) {
        try {
          response = await fetch(url, {
            signal: AbortSignal.timeout(10000),
          })
          if (response.ok) break
          response = null
        } catch {
          // 尝试下一个 URL
        }
      }
      if (!response || !response.ok) return false

      const releases = (await response.json()) as {
        databases?: Record<string, unknown>
      }
      // releases.json 的结构为：{ databases: { questdb: {...}, ... } }
      return Boolean(releases.databases?.questdb)
    } catch {
      // 网络错误或超时 - 让下载尝试继续进行，由其自身的错误处理机制处理
      return true
    }
  }

  /**
   * 覆盖 download 方法，先检查 hostdb 可用性，然后调用 postExtract
   */
  override async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    // 检查 hostdb 中是否提供了 QuestDB
    const isAvailable = await this.checkHostdbAvailability()
    if (!isAvailable) {
      throw new Error(
        `QuestDB 二进制文件在 hostdb 中尚不可用。\n\n` +
          `QuestDB 支持已添加到 SpinDB，但需要先将二进制文件上传到 hostdb。\n\n` +
          `要立即使用 QuestDB，您可以：\n` +
          `  1. 等待下一个包含 QuestDB 二进制文件的 hostdb 版本\n` +
          `  2. 从 https://questdb.io/get-questdb/ 手动下载 QuestDB\n\n` +
          `请查看 https://registry.layerbase.host 以获取更新。`,
      )
    }

    const binPath = await super.download(version, platform, arch, onProgress)

    // 执行解压后设置（赋予执行权限、创建 java 符号链接）
    await this.postExtract(binPath, platform)

    return binPath
  }
}

export const questdbBinaryManager = new QuestDBBinaryManager()
