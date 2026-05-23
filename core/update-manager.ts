import { exec } from 'child_process'
import { promisify } from 'util'
import { configManager } from './config-manager'
import { logDebug } from './error-handler'
import { VERSION } from '../config/version'

const execAsync = promisify(exec)

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/spindb'
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 小时

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const KNOWN_PACKAGE_MANAGERS: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm']

/** 从 npm user agent 字符串解析包管理器 */
export function parseUserAgent(
  userAgent: string | undefined,
): PackageManager | null {
  if (!userAgent) return null
  const firstToken = userAgent.split('/')[0]?.toLowerCase().trim()
  if (!firstToken) return null
  return KNOWN_PACKAGE_MANAGERS.find((pm) => pm === firstToken) ?? null
}

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  lastChecked: string
}

export type UpdateResult = {
  success: boolean
  previousVersion: string
  newVersion: string
  error?: string
}

export class UpdateManager {
  getCurrentVersion(): string {
    return VERSION
  }

  // 限制为每 24 小时一次，除非 force=true
  async checkForUpdate(force = false): Promise<UpdateCheckResult | null> {
    const config = await configManager.load()
    const lastCheck = config.update?.lastCheck

    if (!force && lastCheck) {
      const elapsed = Date.now() - new Date(lastCheck).getTime()
      if (elapsed < CHECK_THROTTLE_MS && config.update?.latestVersion) {
        const currentVersion = this.getCurrentVersion()
        return {
          currentVersion,
          latestVersion: config.update.latestVersion,
          updateAvailable:
            this.compareVersions(config.update.latestVersion, currentVersion) >
            0,
          lastChecked: lastCheck,
        }
      }
    }

    try {
      const latestVersion = await this.fetchLatestVersion()
      const currentVersion = this.getCurrentVersion()

      config.update = {
        ...config.update,
        lastCheck: new Date().toISOString(),
        latestVersion,
      }
      await configManager.save()

      return {
        currentVersion,
        latestVersion,
        updateAvailable:
          this.compareVersions(latestVersion, currentVersion) > 0,
        lastChecked: new Date().toISOString(),
      }
    } catch {
      // 离线或注册表错误 - 返回 null
      return null
    }
  }

  // 并行检查所有包管理器，回退到 npm_config_user_agent，最后回退到 npm
  async detectPackageManager(): Promise<PackageManager> {
    const checks = await Promise.all([
      this.checkGlobalInstall(
        'pnpm',
        'pnpm list -g spindb --json',
        (stdout) => {
          const data = JSON.parse(stdout) as Array<{
            dependencies?: { spindb?: unknown }
          }>
          return !!data[0]?.dependencies?.spindb
        },
      ),
      this.checkGlobalInstall('yarn', 'yarn global list --json', (stdout) => {
        return stdout.includes('"spindb@')
      }),
      this.checkGlobalInstall('bun', 'bun pm ls -g', (stdout) => {
        return stdout.includes('spindb@')
      }),
      this.checkGlobalInstall('npm', 'npm list -g spindb --json', (stdout) => {
        const data = JSON.parse(stdout) as {
          dependencies?: { spindb?: unknown }
        }
        return !!data.dependencies?.spindb
      }),
    ])

    const globalPm = checks.find((result) => result !== null)
    if (globalPm) {
      logDebug(`检测到全局安装方式: ${globalPm}`)
      return globalPm
    }

    const agentPm = parseUserAgent(process.env.npm_config_user_agent)
    if (agentPm) {
      logDebug(`从 user agent 检测到包管理器: ${agentPm}`)
      return agentPm
    }

    return 'npm'
  }

  private async checkGlobalInstall(
    pm: PackageManager,
    command: string,
    checkOutput: (stdout: string) => boolean,
  ): Promise<PackageManager | null> {
    try {
      const { stdout } = await execAsync(command, { timeout: 5000, cwd: '/' })
      return checkOutput(stdout) ? pm : null
    } catch {
      return null
    }
  }

  /** 获取包管理器的安装命令 */
  getInstallCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm add -g spindb@latest'
      case 'yarn':
        return 'yarn global add spindb@latest'
      case 'bun':
        return 'bun add -g spindb@latest'
      case 'npm':
        return 'npm install -g spindb@latest'
    }
  }

  /** 获取包管理器的列表查询命令 */
  private getListCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm list -g spindb --json'
      case 'yarn':
        return 'yarn global list --json'
      case 'bun':
        return 'bun pm ls -g'
      case 'npm':
        return 'npm list -g spindb --json'
    }
  }

  /** 从列表输出中解析版本号 */
  private parseVersionFromListOutput(
    pm: PackageManager,
    stdout: string,
    fallback: string,
  ): string {
    try {
      switch (pm) {
        case 'pnpm': {
          const data = JSON.parse(stdout) as Array<{
            dependencies?: { spindb?: { version?: string } }
          }>
          return data[0]?.dependencies?.spindb?.version || fallback
        }
        case 'npm': {
          const data = JSON.parse(stdout) as {
            dependencies?: { spindb?: { version?: string } }
          }
          return data.dependencies?.spindb?.version || fallback
        }
        case 'yarn':
        case 'bun': {
          // 从 "spindb@x.y.z" 模式中提取版本
          const match = stdout.match(/spindb@(\d+\.\d+\.\d+)/)
          return match?.[1] || fallback
        }
      }
    } catch {
      return fallback
    }
  }

  /** 执行更新操作 */
  async performUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getCurrentVersion()
    const pm = await this.detectPackageManager()
    const installCmd = this.getInstallCommand(pm)

    // 执行安装命令
    try {
      await execAsync(installCmd, { timeout: 60000, cwd: '/' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (message.includes('EACCES') || message.includes('permission')) {
        const sudoCmd = pm === 'npm' ? `sudo ${installCmd}` : installCmd
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          error: `权限不足。请尝试: ${sudoCmd}`,
        }
      }

      // pnpm 10+ 在 `pnpm setup` 未将 PNPM_HOME 写入 shell 配置文件之前
      // 会拒绝 `add -g`。全新安装 pnpm 的用户会遇到
      // "global bin directory ... not in PATH" 错误 - 回退到 npm 以确保
      // 更新仍然成功，而不是让用户陷入困境。
      const isPnpmSetupError =
        pm === 'pnpm' &&
        (message.includes('global bin directory') ||
          message.includes('is not in PATH') ||
          message.includes('Run "pnpm setup"'))

      if (isPnpmSetupError) {
        const npmCmd = this.getInstallCommand('npm')
        logDebug(`pnpm 安装失败，回退到: ${npmCmd}`)
        try {
          await execAsync(npmCmd, { timeout: 60000, cwd: '/' })
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError)
          return {
            success: false,
            previousVersion,
            newVersion: previousVersion,
            error: `${message}\n回退到 npm 也失败了: ${fallbackMessage}\n手动更新: ${installCmd}，或先运行 \`pnpm setup\``,
          }
        }
      } else {
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          error: `${message}\n手动更新: ${installCmd}`,
        }
      }
    }

    // 验证新版本 - 使用显式 cwd 以避免过期目录问题
    // （fnm 等版本管理器在全局安装期间可能使 cwd 失效）
    let newVersion = previousVersion
    try {
      const { stdout } = await execAsync(this.getListCommand(pm), {
        timeout: 10000,
        cwd: '/',
      })
      newVersion = this.parseVersionFromListOutput(pm, stdout, previousVersion)
    } catch {
      // 验证失败但安装可能已成功 - 从注册表获取
      try {
        newVersion = await this.fetchLatestVersion()
      } catch {
        // 回退到之前的版本（安装仍然成功）
      }
    }

    return {
      success: true,
      previousVersion,
      newVersion,
    }
  }

  /** 获取缓存的更新信息 */
  async getCachedUpdateInfo(): Promise<{
    latestVersion?: string
    autoCheckEnabled: boolean
  }> {
    const config = await configManager.load()
    return {
      latestVersion: config.update?.latestVersion,
      autoCheckEnabled: config.update?.autoCheckEnabled !== false,
    }
  }

  /** 设置是否启用自动检查更新 */
  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    const config = await configManager.load()
    config.update = {
      ...config.update,
      autoCheckEnabled: enabled,
    }
    await configManager.save()
  }

  /** 从 npm 注册表获取最新版本号 */
  private async fetchLatestVersion(): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    try {
      const response = await fetch(NPM_REGISTRY_URL, {
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`注册表返回 ${response.status}`)
      }
      const data = (await response.json()) as {
        'dist-tags': { latest: string }
      }
      return data['dist-tags'].latest
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 比较两个版本号 */
  compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
    const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)

    for (let i = 0; i < 3; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  }
}

export const updateManager = new UpdateManager()
