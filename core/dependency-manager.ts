/**
 * 依赖管理器
 *
 * 负责检查、安装和更新数据库引擎的操作系统级依赖。
 */

import { exec, spawnSync } from 'child_process'
import { promisify } from 'util'
import {
  type PackageManagerId,
  type PackageManagerConfig,
  type Dependency,
  type Platform,
  packageManagers,
  getEngineDependencies,
  getUniqueDependencies,
  usqlDependency,
  pgcliDependency,
  mycliDependency,
  litecliDependency,
  iredisDependency,
} from '../config/os-dependencies'
import { platformService } from './platform-service'
import { configManager } from './config-manager'
import type { BinaryTool } from '../types'

const execAsync = promisify(exec)

const KNOWN_BINARY_TOOLS: readonly BinaryTool[] = [
  // PostgreSQL
  'postgres',
  'pg_ctl',
  'initdb',
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
  // MySQL
  'mysql',
  'mysqldump',
  'mysqlpump',
  'mysqld',
  'mysqladmin',
  // MariaDB
  'mariadb',
  'mariadb-dump',
  'mariadbd',
  'mariadb-admin',
  // SQLite
  'sqlite3',
  'sqldiff',
  'sqlite3_analyzer',
  'sqlite3_rsync',
  // DuckDB
  'duckdb',
  // MongoDB
  'mongod',
  'mongosh',
  'mongodump',
  'mongorestore',
  // FerretDB
  'ferretdb',
  // Redis
  'redis-server',
  'redis-cli',
  // Valkey
  'valkey-server',
  'valkey-cli',
  // ClickHouse
  'clickhouse',
  // Qdrant
  'qdrant',
  // Meilisearch
  'meilisearch',
  // CouchDB
  'couchdb',
  // CockroachDB
  'cockroach',
  // SurrealDB
  'surreal',
  // QuestDB
  'questdb',
  // TypeDB
  'typedb',
  'typedb_console_bin',
  // InfluxDB
  'influxdb3',
  // Weaviate
  'weaviate',
  // TigerBeetle
  'tigerbeetle',
  // LibSQL
  'sqld',
  // Web 面板
  'pgweb',
  // TUI 工具
  'dblab',
  // 增强型终端（可选）
  'pgcli',
  'mycli',
  'litecli',
  'iredis',
  'usql',
] as const

export type DependencyStatus = {
  dependency: Dependency
  installed: boolean
  path?: string
  version?: string
}

export type DetectedPackageManager = {
  config: PackageManagerConfig
  id: PackageManagerId
  name: string
}

export type InstallResult = {
  success: boolean
  dependency: Dependency
  error?: string
}

function isBinaryTool(binary: string): binary is BinaryTool {
  return KNOWN_BINARY_TOOLS.includes(binary as BinaryTool)
}

export async function detectPackageManager(): Promise<DetectedPackageManager | null> {
  const { platform } = platformService.getPlatformInfo()

  // 筛选出当前平台可用的包管理器
  const candidates = packageManagers.filter((pm) =>
    pm.platforms.includes(platform),
  )

  for (const pm of candidates) {
    try {
      await execAsync(pm.checkCommand)
      return {
        config: pm,
        id: pm.id,
        name: pm.name,
      }
    } catch {
      // 该包管理器不可用
    }
  }

  return null
}

export function getCurrentPlatform(): Platform {
  return platformService.getPlatformInfo().platform as Platform
}

export async function findBinary(
  binary: string,
): Promise<{ path: string; version?: string } | null> {
  try {
    // 首先检查是否在配置中注册了该二进制文件（例如已下载的 PostgreSQL）
    if (isBinaryTool(binary)) {
      const configPath = await configManager.getBinaryPath(binary)
      if (configPath) {
        const version =
          (await platformService.getToolVersion(configPath)) || undefined
        return { path: configPath, version }
      }
    }

    // 回退到系统 PATH 搜索
    const path = await platformService.findToolPath(binary)
    if (!path) return null

    // 尝试获取版本号
    const version = (await platformService.getToolVersion(path)) || undefined

    return { path, version }
  } catch {
    return null
  }
}

export async function checkDependency(
  dependency: Dependency,
): Promise<DependencyStatus> {
  const result = await findBinary(dependency.binary)

  return {
    dependency,
    installed: result !== null,
    path: result?.path,
    version: result?.version,
  }
}

export async function checkEngineDependencies(
  engine: string,
): Promise<DependencyStatus[]> {
  const engineDeps = getEngineDependencies(engine)
  if (!engineDeps) return []

  const results = await Promise.all(
    engineDeps.dependencies.map((dep) => checkDependency(dep)),
  )

  return results
}

export async function checkAllDependencies(): Promise<DependencyStatus[]> {
  const deps = getUniqueDependencies()
  const results = await Promise.all(deps.map((dep) => checkDependency(dep)))
  return results
}

export async function getMissingDependencies(
  engine: string,
): Promise<Dependency[]> {
  const statuses = await checkEngineDependencies(engine)
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

export async function getAllMissingDependencies(): Promise<Dependency[]> {
  const statuses = await checkAllDependencies()
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

function hasTTY(): boolean {
  return process.stdin.isTTY === true
}

function isRoot(): boolean {
  return process.getuid?.() === 0
}

// 检查是否在 CI 环境中运行（sudo 不需要密码）
function isPasswordlessSudoEnvironment(): boolean {
  // GitHub Actions、GitLab CI、CircleCI、Travis CI 等
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS
  )
}

/**
 * 以继承标准输入输出的方式执行命令（用于 sudo 的 TTY 支持）
 * 使用 spawnSync 以正确连接终端进行密码提示
 */
function execWithInheritedStdio(command: string): void {
  let cmdToRun = command

  // 如果已以 root 身份运行，则去除命令中的 sudo
  if (isRoot() && command.startsWith('sudo ')) {
    cmdToRun = command.replace(/^sudo\s+/, '')
  }

  // 检查是否需要 TTY 来进行 sudo 密码提示
  // 在 CI 环境中跳过此检查（sudo 不需要密码）
  if (
    !hasTTY() &&
    cmdToRun.includes('sudo') &&
    !isPasswordlessSudoEnvironment()
  ) {
    throw new Error(
      '无法在没有交互式终端的情况下运行 sudo 命令。请手动运行安装命令：\n' +
        `  ${command}`,
    )
  }

  const result = spawnSync(cmdToRun, [], {
    shell: true,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      `命令执行失败，退出码 ${result.status}: ${cmdToRun}`,
    )
  }
}

export function buildInstallCommand(
  dependency: Dependency,
  packageManager: DetectedPackageManager,
): string[] {
  const pkgDef = dependency.packages[packageManager.id]
  if (!pkgDef) {
    throw new Error(
      `未找到 ${dependency.name} 在 ${packageManager.name} 下的包定义`,
    )
  }

  const commands: string[] = []

  // 安装前命令
  if (pkgDef.preInstall) {
    commands.push(...pkgDef.preInstall)
  }

  // 主安装命令
  const installCmd = packageManager.config.installTemplate.replace(
    '{package}',
    pkgDef.package,
  )
  commands.push(installCmd)

  // 安装后命令
  if (pkgDef.postInstall) {
    commands.push(...pkgDef.postInstall)
  }

  return commands
}

export async function installDependency(
  dependency: Dependency,
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  try {
    const commands = buildInstallCommand(dependency, packageManager)

    for (const cmd of commands) {
      // 使用继承的标准输入输出，以便 sudo 可以在终端中提示输入密码
      // 注意：execWithInheritedStdio 会在以 root 身份运行时自动去除 sudo
      execWithInheritedStdio(cmd)
    }

    // 包管理器交互后刷新配置缓存
    // 确保新安装的工具能被检测到正确的版本
    await configManager.refreshAllBinaries()

    // 验证安装
    const status = await checkDependency(dependency)
    if (!status.installed) {
      return {
        success: false,
        dependency,
        error: '安装已完成，但在 PATH 中未找到二进制文件',
      }
    }

    return { success: true, dependency }
  } catch (error) {
    return {
      success: false,
      dependency,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function installEngineDependencies(
  engine: string,
  packageManager: DetectedPackageManager,
): Promise<InstallResult[]> {
  const missing = await getMissingDependencies(engine)
  if (missing.length === 0) return []

  // 按包分组，避免重复安装同一个包
  const packageGroups = new Map<string, Dependency[]>()
  for (const dep of missing) {
    const pkgDef = dep.packages[packageManager.id]
    if (pkgDef) {
      const existing = packageGroups.get(pkgDef.package) || []
      existing.push(dep)
      packageGroups.set(pkgDef.package, existing)
    }
  }

  const results: InstallResult[] = []

  // 每个唯一的包只安装一次
  for (const [, deps] of packageGroups) {
    // 使用第一个依赖项安装（它们都使用同一个包）
    const result = await installDependency(deps[0], packageManager)

    // 将同一包下的所有依赖项标记为相同结果
    for (const dep of deps) {
      results.push({ ...result, dependency: dep })
    }
  }

  return results
}

// 安装所有引擎中缺失的依赖
export async function installAllDependencies(
  packageManager: DetectedPackageManager,
): Promise<InstallResult[]> {
  const missing = await getAllMissingDependencies()
  if (missing.length === 0) return []

  // 按包分组
  const packageGroups = new Map<string, Dependency[]>()
  for (const dep of missing) {
    const pkgDef = dep.packages[packageManager.id]
    if (pkgDef) {
      const existing = packageGroups.get(pkgDef.package) || []
      existing.push(dep)
      packageGroups.set(pkgDef.package, existing)
    }
  }

  const results: InstallResult[] = []

  for (const [, deps] of packageGroups) {
    const result = await installDependency(deps[0], packageManager)
    for (const dep of deps) {
      results.push({ ...result, dependency: dep })
    }
  }

  return results
}

export function getManualInstallInstructions(
  dependency: Dependency,
  platform: Platform = getCurrentPlatform(),
): string[] {
  return dependency.manualInstall[platform] || []
}

export async function isUsqlInstalled(): Promise<boolean> {
  const status = await checkDependency(usqlDependency)
  return status.installed
}

export async function installUsql(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(usqlDependency, packageManager)
}

export function getUsqlManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(usqlDependency, platform)
}

export async function isPgcliInstalled(): Promise<boolean> {
  const status = await checkDependency(pgcliDependency)
  return status.installed
}

export async function installPgcli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(pgcliDependency, packageManager)
}

export function getPgcliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(pgcliDependency, platform)
}

export async function isMycliInstalled(): Promise<boolean> {
  const status = await checkDependency(mycliDependency)
  return status.installed
}

export async function installMycli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(mycliDependency, packageManager)
}

export function getMycliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(mycliDependency, platform)
}

export async function isLitecliInstalled(): Promise<boolean> {
  const status = await checkDependency(litecliDependency)
  return status.installed
}

export async function installLitecli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(litecliDependency, packageManager)
}

export function getLitecliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(litecliDependency, platform)
}

export async function isIredisInstalled(): Promise<boolean> {
  const status = await checkDependency(iredisDependency)
  return status.installed
}

export async function installIredis(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(iredisDependency, packageManager)
}

export function getIredisManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(iredisDependency, platform)
}
