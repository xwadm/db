/**
 * SurrealDB 认证模块
 *
 * 处理 SurrealDB 的三级认证层级：root、namespace、database。
 * SurrealDB 连接字符串支持 ?authLevel= 参数来指定认证层级。
 */

export type SurrealAuthLevel = 'root' | 'namespace' | 'database'

export type LocalSurrealAuth = {
  username: string
  password: string
  authLevel: SurrealAuthLevel
}

/**
 * 规范化认证层级字符串
 */
function normalizeSurrealAuthLevel(
  value?: string | null,
): SurrealAuthLevel | null {
  if (!value) {
    return null
  }

  switch (value.toLowerCase()) {
    case 'root':
      return 'root'
    case 'namespace':
    case 'ns':
      return 'namespace'
    case 'database':
    case 'db':
      return 'database'
    default:
      return null
  }
}

/**
 * 从连接字符串中读取显式指定的认证层级
 */
function readExplicitSurrealAuthLevel(
  connectionString: string,
): SurrealAuthLevel | null {
  const url = new URL(connectionString)
  const rawAuthLevel = url.searchParams.get('authLevel')
  const explicit = normalizeSurrealAuthLevel(rawAuthLevel)

  if (rawAuthLevel && !explicit) {
    throw new Error(
      `SurrealDB 连接字符串中的 authLevel "${rawAuthLevel}" 无效`,
    )
  }

  return explicit
}

/**
 * 获取 SurrealDB 的默认引导凭据
 */
export function getBootstrapSurrealAuth(): LocalSurrealAuth {
  return {
    username: 'root',
    password: 'root',
    authLevel: 'root',
  }
}

/**
 * 推断 SurrealDB 认证层级
 *
 * 规则：
 * - 如果连接字符串中显式指定了 authLevel，则使用该值
 * - 如果用户名为 'root'，则认证层级为 'root'
 * - 否则，如果指定了数据库，则为 'database'，否则为 'namespace'
 */
export function inferSurrealAuthLevel(options: {
  username: string
  database?: string
  connectionString?: string
}): SurrealAuthLevel {
  if (options.connectionString) {
    const explicit = readExplicitSurrealAuthLevel(options.connectionString)
    if (explicit) {
      return explicit
    }
    if (options.username !== 'root') {
      throw new Error(
        '非 root 凭据的 SurrealDB 连接字符串必须包含 ?authLevel=namespace 或 ?authLevel=database',
      )
    }
  }

  if (options.username === 'root') {
    return 'root'
  }

  return options.database ? 'database' : 'namespace'
}

/**
 * 将认证参数添加到命令行参数列表
 */
export function addSurrealAuthArgs(
  args: string[],
  auth: LocalSurrealAuth,
): string[] {
  args.push(
    '--user',
    auth.username,
    '--pass',
    auth.password,
    '--auth-level',
    auth.authLevel,
  )
  return args
}

/**
 * 对命令行参数中的敏感信息进行脱敏处理
 */
export function sanitizeSurrealAuthArgs(args: string[]): string[] {
  const sanitized = [...args]

  for (let i = 0; i < sanitized.length; i++) {
    if (
      sanitized[i] === '--pass' ||
      sanitized[i] === '--password' ||
      sanitized[i] === '--token'
    ) {
      if (i + 1 < sanitized.length) {
        sanitized[i + 1] = '<已脱敏>'
      }
    }
  }

  return sanitized
}

/**
 * 构建 SurrealDB 用户连接字符串
 */
export function buildSurrealUserConnectionString(options: {
  username: string
  password: string
  port: number
  namespace: string
  database: string
  authLevel: SurrealAuthLevel
}): string {
  const url = new URL(
    `surrealdb://127.0.0.1:${options.port}/${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.database)}`,
  )
  url.username = options.username
  url.password = options.password
  url.searchParams.set('authLevel', options.authLevel)
  return url.toString()
}

/**
 * 解析 SurrealDB 连接字符串
 *
 * 格式：surrealdb://[user:password@]host[:port][/namespace/database]
 * 或：ws://host:port 或 http://host:port
 */
export function parseSurrealConnectionString(connectionString: string): {
  host: string
  port: number
  username: string
  password: string
  namespace: string
  database: string
  authLevel: SurrealAuthLevel
} {
  const url = new URL(connectionString)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const username = decodeURIComponent(url.username || 'root')
  const password = decodeURIComponent(url.password || 'root')

  const namespace =
    pathParts[0] && pathParts[0] !== 'rpc'
      ? decodeURIComponent(pathParts[0])
      : url.searchParams.get('ns') || 'test'
  const database =
    pathParts[1] && pathParts[0] !== 'rpc'
      ? decodeURIComponent(pathParts[1])
      : url.searchParams.get('db') || 'test'

  return {
    host: url.hostname || '127.0.0.1',
    port: parseInt(url.port, 10) || 8000,
    username,
    password,
    namespace,
    database,
    authLevel: inferSurrealAuthLevel({
      username,
      database,
      connectionString,
    }),
  }
}
