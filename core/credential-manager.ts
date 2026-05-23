/**
 * 凭证管理器
 *
 * 管理保存在磁盘上的数据库凭证。
 * 凭证以 .env 文件形式存储在容器的 credentials/ 目录中。
 */

import { existsSync } from 'fs'
import { readFile, writeFile, readdir, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { paths } from '../config/paths'
import { Engine, type UserCredentials } from '../types'
import { isValidUsername } from './error-handler'

/**
 * 获取容器的凭证目录。
 */
function getCredentialsDir(containerName: string, engine: Engine): string {
  const containerPath = paths.getContainerPath(containerName, { engine })
  return join(containerPath, 'credentials')
}

/**
 * 获取特定用户名的凭证文件路径。
 * 验证用户名以防止路径遍历（与 assertValidUsername 相同的规则）。
 */
function getCredentialFilePath(
  containerName: string,
  engine: Engine,
  username: string,
): string {
  if (!isValidUsername(username)) {
    throw new Error(
      `凭证文件的用户名无效："${username}"。必须匹配 ^[a-zA-Z][a-zA-Z0-9_]{0,62}$`,
    )
  }
  return join(getCredentialsDir(containerName, engine), `.env.${username}`)
}

function isRedisFamilyDefaultAlias(engine: Engine, username: string): boolean {
  return (
    (engine === Engine.Redis || engine === Engine.Valkey) &&
    username === 'default'
  )
}

function getCredentialStorageUsername(
  engine: Engine,
  username: string,
): string {
  if (isRedisFamilyDefaultAlias(engine, username)) {
    return getDefaultUsername(engine)
  }
  return username
}

function getCredentialLookupUsernames(
  engine: Engine,
  username: string,
): string[] {
  if (engine !== Engine.Redis && engine !== Engine.Valkey) {
    return [username]
  }

  const alias = getDefaultUsername(engine)
  if (username === alias || username === 'default') {
    return [alias, 'default']
  }
  return [username]
}

/**
 * 将凭证格式化为 .env 文件内容。
 */
function encodeEnvValue(value: string): string {
  if (/[\n\r=\\]/.test(value)) {
    return JSON.stringify(value)
  }
  return value
}

function decodeEnvValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw
    }
  }
  return raw
}

function formatCredentials(credentials: UserCredentials): string {
  const lines: string[] = []

  if (credentials.apiKey) {
    lines.push(`API_KEY_NAME=${encodeEnvValue(credentials.username)}`)
    lines.push(`API_KEY=${encodeEnvValue(credentials.apiKey)}`)
    lines.push(`API_URL=${encodeEnvValue(credentials.connectionString)}`)
  } else {
    lines.push(`DB_USER=${encodeEnvValue(credentials.username)}`)
    lines.push(`DB_PASSWORD=${encodeEnvValue(credentials.password)}`)
    // 从连接字符串中提取主机和端口。
    // 尽可能使用 URL 解析；回退到针对 host:port 的正则表达式。
    let extractedHost: string | undefined
    let extractedPort: string | undefined
    try {
      const url = new URL(credentials.connectionString)
      if (url.hostname) {
        extractedHost = url.hostname
      }
      if (url.port) {
        extractedPort = url.port
      }
    } catch {
      // 不是有效的 URL（例如自定义协议）。使用针对 host:port 段的正则表达式。
      const hostPortMatch = credentials.connectionString.match(
        /@(\[[^\]]+\]|[^:/?#]+):(\d+)(?:\/|$)/,
      )
      if (hostPortMatch) {
        extractedHost = hostPortMatch[1].replace(/^\[|\]$/g, '')
        extractedPort = hostPortMatch[2]
      }
    }
    lines.push(`DB_HOST=${extractedHost || '127.0.0.1'}`)
    if (extractedPort) {
      lines.push(`DB_PORT=${extractedPort}`)
    }
    if (credentials.database) {
      lines.push(`DB_NAME=${encodeEnvValue(credentials.database)}`)
    }
    lines.push(`DB_URL=${encodeEnvValue(credentials.connectionString)}`)
  }

  return lines.join('\n') + '\n'
}

/**
 * 将 .env 凭证文件解析回 UserCredentials。
 */
function parseCredentialFile(
  content: string,
  containerName: string,
  engine: Engine,
): UserCredentials {
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const rawValue = trimmed.slice(eqIdx + 1).trim()
    vars[key] = decodeEnvValue(rawValue)
  }

  // API 密钥凭证：密码有意为空（认证使用 API 密钥，而非密码）
  if (vars.API_KEY) {
    if (!vars.API_KEY_NAME || !vars.API_URL) {
      throw new Error(
        `容器 "${containerName}" 的凭证文件已损坏：缺少 API_KEY_NAME 或 API_URL`,
      )
    }
    return {
      username: vars.API_KEY_NAME,
      password: '', // 基于 API 密钥的认证不使用密码
      connectionString: vars.API_URL,
      engine,
      container: containerName,
      apiKey: vars.API_KEY,
    }
  }

  // 空字符串的 DB_PASSWORD 是有意允许的（某些数据库允许无密码连接）
  if (!vars.DB_USER || vars.DB_PASSWORD === undefined || !vars.DB_URL) {
    throw new Error(
      `容器 "${containerName}" 的凭证文件已损坏：缺少 DB_USER、DB_PASSWORD 或 DB_URL`,
    )
  }

  return {
    username: vars.DB_USER,
    password: vars.DB_PASSWORD,
    connectionString: vars.DB_URL,
    engine,
    container: containerName,
    database: vars.DB_NAME,
  }
}

/**
 * 将凭证保存为 .env 文件到磁盘。
 * 如果 credentials/ 目录不存在则创建。
 * @returns 已保存的凭证文件路径。
 */
export async function saveCredentials(
  containerName: string,
  engine: Engine,
  credentials: UserCredentials,
): Promise<string> {
  const credDir = getCredentialsDir(containerName, engine)
  if (!existsSync(credDir)) {
    await mkdir(credDir, { recursive: true, mode: 0o700 })
  }

  const filePath = getCredentialFilePath(
    containerName,
    engine,
    getCredentialStorageUsername(engine, credentials.username),
  )
  await writeFile(filePath, formatCredentials(credentials), {
    encoding: 'utf-8',
    mode: 0o600,
  })

  // POSIX 文件权限在 Windows 上无效
  if (process.platform !== 'win32') {
    await chmod(credDir, 0o700)
    await chmod(filePath, 0o600)
  }
  return filePath
}

/**
 * 从磁盘加载特定用户名的凭证。
 * 如果凭证文件不存在则返回 null。
 */
export async function loadCredentials(
  containerName: string,
  engine: Engine,
  username: string,
): Promise<UserCredentials | null> {
  for (const candidate of getCredentialLookupUsernames(engine, username)) {
    const filePath = getCredentialFilePath(containerName, engine, candidate)
    try {
      const content = await readFile(filePath, 'utf-8')
      return parseCredentialFile(content, containerName, engine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
  return null
}

/**
 * 列出容器的所有已保存凭证用户名。
 * 如果凭证目录不存在则返回空数组。
 */
export async function listCredentials(
  containerName: string,
  engine: Engine,
): Promise<string[]> {
  const credDir = getCredentialsDir(containerName, engine)
  if (!existsSync(credDir)) {
    return []
  }

  const files = await readdir(credDir)
  return files
    .filter((f) => f.startsWith('.env.'))
    .map((f) => f.slice(5)) // 移除 '.env.' 前缀
    .sort()
}

/**
 * 检查特定用户名的凭证是否存在。
 */
export function credentialsExist(
  containerName: string,
  engine: Engine,
  username: string,
): boolean {
  return getCredentialLookupUsernames(engine, username).some((candidate) =>
    existsSync(getCredentialFilePath(containerName, engine, candidate)),
  )
}

/**
 * 获取给定引擎的默认用户名。
 * API 密钥引擎使用 'search_key' 或 'api_key'，其他使用 'spindb'。
 */
export function getDefaultUsername(engine: Engine): string {
  switch (engine) {
    case Engine.Meilisearch:
      return 'search_key'
    case Engine.Qdrant:
      return 'api_key'
    case Engine.Weaviate:
      return 'api_key'
    case Engine.LibSQL:
      return 'auth_token'
    default:
      return 'spindb'
  }
}
