/**
 * 错误处理器
 *
 * 集中式错误处理，提供适当的日志记录和用户反馈。
 * - CLI 命令记录日志并退出（不阻塞脚本/CI）
 * - 交互式菜单使用"按 Enter 继续"模式
 * - 所有错误记录到 ~/.spindb/spindb.log 以便调试
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import chalk from 'chalk'

// 获取 SpinDB 主目录，避免循环导入
function getSpinDBRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.spindb')
}

export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info'

export type SpinDBErrorInfo = {
  code: string
  message: string
  severity: ErrorSeverity
  suggestion?: string
  context?: Record<string, unknown>
}

export const ErrorCodes = {
  // 端口错误
  PORT_IN_USE: 'PORT_IN_USE',
  PORT_PERMISSION_DENIED: 'PORT_PERMISSION_DENIED',
  PORT_RANGE_EXHAUSTED: 'PORT_RANGE_EXHAUSTED',

  // 进程错误
  PROCESS_START_FAILED: 'PROCESS_START_FAILED',
  PROCESS_STOP_TIMEOUT: 'PROCESS_STOP_TIMEOUT',
  PROCESS_ALREADY_RUNNING: 'PROCESS_ALREADY_RUNNING',
  PROCESS_NOT_RUNNING: 'PROCESS_NOT_RUNNING',
  PID_FILE_CORRUPT: 'PID_FILE_CORRUPT',
  PID_FILE_STALE: 'PID_FILE_STALE',
  PID_FILE_READ_FAILED: 'PID_FILE_READ_FAILED',

  // 恢复错误
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  RESTORE_PARTIAL_FAILURE: 'RESTORE_PARTIAL_FAILURE',
  RESTORE_COMPLETE_FAILURE: 'RESTORE_COMPLETE_FAILURE',
  BACKUP_FORMAT_UNKNOWN: 'BACKUP_FORMAT_UNKNOWN',
  WRONG_ENGINE_DUMP: 'WRONG_ENGINE_DUMP',

  // 容器错误
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
  CONTAINER_ALREADY_EXISTS: 'CONTAINER_ALREADY_EXISTS',
  CONTAINER_RUNNING: 'CONTAINER_RUNNING',
  CONTAINER_CREATE_FAILED: 'CONTAINER_CREATE_FAILED',
  INIT_FAILED: 'INIT_FAILED',
  DATABASE_CREATE_FAILED: 'DATABASE_CREATE_FAILED',
  INVALID_DATABASE_NAME: 'INVALID_DATABASE_NAME',
  INVALID_USERNAME: 'INVALID_USERNAME',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',

  // 依赖错误
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  DEPENDENCY_VERSION_INCOMPATIBLE: 'DEPENDENCY_VERSION_INCOMPATIBLE',

  // 连接错误
  CONNECTION_FAILED: 'CONNECTION_FAILED',

  // 回滚错误
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',

  // 剪贴板错误
  CLIPBOARD_FAILED: 'CLIPBOARD_FAILED',

  // 通用错误
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class SpinDBError extends Error {
  public readonly code: string
  public readonly severity: ErrorSeverity
  public readonly suggestion?: string
  public readonly context?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    severity: ErrorSeverity = 'error',
    suggestion?: string,
    context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SpinDBError'
    this.code = code
    this.severity = severity
    this.suggestion = suggestion
    this.context = context

    // 捕获正确的堆栈跟踪
    Error.captureStackTrace(this, SpinDBError)
  }

  // 从未知错误创建 SpinDBError
  static from(
    error: unknown,
    code: string = ErrorCodes.UNKNOWN_ERROR,
    suggestion?: string,
  ): SpinDBError {
    if (error instanceof SpinDBError) {
      return error
    }

    const message = error instanceof Error ? error.message : String(error)

    return new SpinDBError(code, message, 'error', suggestion, {
      originalError: error instanceof Error ? error.stack : undefined,
    })
  }
}

/**
 * 当缺少必需的 CLI 工具（如 psql、pg_dump、mysql）时抛出的错误。
 * 用于在交互式菜单中触发安装提示。
 */
export class MissingToolError extends Error {
  public readonly tool: string

  constructor(tool: string, message?: string) {
    super(message ?? `${tool} 未找到`)
    this.name = 'MissingToolError'
    this.tool = tool
    Error.captureStackTrace(this, MissingToolError)
  }
}

/**
 * 当某个引擎不支持某操作时抛出的错误。
 * 例如，在不具备数据库概念的引擎上执行 listDatabases。
 */
export class UnsupportedOperationError extends Error {
  public readonly operation: string
  public readonly engine: string

  constructor(operation: string, engine: string, message?: string) {
    super(
      message ??
        `${operation} 不支持 ${engine}。` +
          `该引擎可能使用不同的概念（集合、索引等）。`,
    )
    this.name = 'UnsupportedOperationError'
    this.operation = operation
    this.engine = engine
    Error.captureStackTrace(this, UnsupportedOperationError)
  }
}

function getLogPath(): string {
  return join(getSpinDBRoot(), 'spindb.log')
}

function ensureLogDirectory(): void {
  const logPath = getLogPath()
  const logDir = dirname(logPath)
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
}

function appendToLogFile(entry: SpinDBErrorInfo): void {
  try {
    ensureLogDirectory()
    const logPath = getLogPath()
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    }
    appendFileSync(logPath, JSON.stringify(logEntry) + '\n')
  } catch {
    // 如果无法写入日志文件，不中断操作
    // 这可能发生在 ~/.spindb 尚未存在时
  }
}

function formatSeverity(severity: ErrorSeverity): string {
  switch (severity) {
    case 'fatal':
      return chalk.red.bold('[致命]')
    case 'error':
      return chalk.red('[错误]')
    case 'warning':
      return chalk.yellow('[警告]')
    case 'info':
      return chalk.blue('[信息]')
  }
}

// 将错误记录到控制台和日志文件（CLI 命令非阻塞）。
export function logError(error: SpinDBErrorInfo): void {
  // 带颜色的控制台输出
  const prefix = formatSeverity(error.severity)
  console.error(`${prefix} [${error.code}] ${error.message}`)

  if (error.suggestion) {
    console.error(chalk.yellow(`  建议: ${error.suggestion}`))
  }

  // 同时追加到日志文件以便无头调试
  appendToLogFile(error)
}

export function logSpinDBError(error: SpinDBError): void {
  logError({
    code: error.code,
    message: error.message,
    severity: error.severity,
    suggestion: error.suggestion,
    context: error.context,
  })
}

export function logWarning(
  message: string,
  context?: Record<string, unknown>,
): void {
  console.warn(chalk.yellow(`  ⚠ ${message}`))

  appendToLogFile({
    code: 'WARNING',
    message,
    severity: 'warning',
    context,
  })
}

export function logInfo(
  message: string,
  context?: Record<string, unknown>,
): void {
  appendToLogFile({
    code: 'INFO',
    message,
    severity: 'info',
    context,
  })
}

// 记录调试消息（仅写入文件，不输出到控制台）。
export function logDebug(
  message: string,
  context?: Record<string, unknown>,
): void {
  appendToLogFile({
    code: 'DEBUG',
    message,
    severity: 'info',
    context,
  })
}

export function createPortInUseError(port: number): SpinDBError {
  return new SpinDBError(
    ErrorCodes.PORT_IN_USE,
    `端口 ${port} 已被占用`,
    'error',
    `使用 -p 标志指定其他端口，或停止占用端口 ${port} 的进程`,
    { port },
  )
}

export function createContainerNotFoundError(name: string): SpinDBError {
  return new SpinDBError(
    ErrorCodes.CONTAINER_NOT_FOUND,
    `未找到容器 "${name}"`,
    'error',
    '运行 "spindb list" 查看可用容器',
    { containerName: name },
  )
}

export function createVersionMismatchError(
  dumpVersion: string,
  toolVersion: string,
): SpinDBError {
  return new SpinDBError(
    ErrorCodes.VERSION_MISMATCH,
    `备份由 PostgreSQL ${dumpVersion} 创建，但您的 pg_restore 版本为 ${toolVersion}`,
    'fatal',
    `安装 PostgreSQL ${dumpVersion} 客户端工具: brew install postgresql@${dumpVersion}`,
    { dumpVersion, toolVersion },
  )
}

export function createDependencyMissingError(
  toolName: string,
  engine: string,
): SpinDBError {
  const suggestions: Record<string, string> = {
    psql: 'brew install libpq && brew link --force libpq',
    pg_dump: 'brew install libpq && brew link --force libpq',
    pg_restore: 'brew install libpq && brew link --force libpq',
    mysql: 'brew install mysql-client',
    mysqldump: 'brew install mysql-client',
    mysqld: 'brew install mysql',
  }

  return new SpinDBError(
    ErrorCodes.DEPENDENCY_MISSING,
    `未找到 ${toolName}`,
    'error',
    suggestions[toolName] || `安装 ${engine} 客户端工具`,
    { toolName, engine },
  )
}

// 验证数据库名称以防止 SQL 注入。
// 排除连字符，因为它们在 SQL 中需要引用标识符。
export function isValidDatabaseName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)
}

export function assertValidDatabaseName(name: string): void {
  if (!isValidDatabaseName(name)) {
    throw new SpinDBError(
      ErrorCodes.INVALID_DATABASE_NAME,
      `无效的数据库名称: "${name}"`,
      'error',
      '数据库名称必须以字母开头，只能包含字母、数字和下划线',
      { databaseName: name },
    )
  }
}

// 验证用户名以防止 SQL 注入。
export function isValidUsername(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)
}

export function assertValidUsername(name: string): void {
  if (!isValidUsername(name)) {
    throw new SpinDBError(
      ErrorCodes.INVALID_USERNAME,
      `无效的用户名: "${name}"`,
      'error',
      '用户名必须以字母开头，只能包含字母、数字和下划线，且最多 63 个字符',
      { username: name },
    )
  }
}

/**
 * 检查当前进程是否在交互式终端中运行。
 * 如果 stdin 是 TTY（用户可以与提示交互），则返回 true。
 */
export function isInteractiveMode(): boolean {
  return Boolean(process.stdin.isTTY)
}

/**
 * 等待用户按 Enter 键后继续。
 * 仅在交互模式下显示提示。
 */
async function waitForEnter(): Promise<void> {
  if (!isInteractiveMode()) {
    return
  }

  return new Promise((resolve) => {
    process.stdout.write(chalk.gray('\n按 Enter 继续...'))
    try {
      // 禁用原始模式，使 Enter 键正常工作（而不仅仅是任意按键）
      // setRawMode 可能失败，因为 stdin 不是 TTY（上面已检查，但以防万一）
      process.stdin.setRawMode?.(false)
      process.stdin.resume()
      process.stdin.once('data', () => {
        process.stdin.pause()
        resolve()
      })
    } catch {
      // 如果 stdin 操作失败（例如 stdin 已关闭），立即 resolve
      resolve()
    }
  })
}

/**
 * 以错误退出进程，可选在交互模式下等待用户输入。
 * 这为交互式 CLI 使用提供了更好的用户体验，同时保持
 * 脚本和 CI 管道的正确退出码。
 *
 * @param options.message - 要显示的错误消息
 * @param options.code - 退出码（默认：1）
 * @param options.json - 如果为 true，以 JSON 格式输出错误并跳过交互式提示
 */
export async function exitWithError(options: {
  message: string
  code?: number
  json?: boolean
}): Promise<never> {
  const { message, code = 1, json = false } = options

  if (json) {
    console.log(JSON.stringify({ error: message }))
  } else {
    console.error(chalk.red(`\n  ✕ ${message}`))

    // 在交互模式下，退出前等待用户按 Enter 键
    // 这给用户时间阅读错误消息
    if (isInteractiveMode()) {
      await waitForEnter()
    }
  }

  process.exit(code)
}
