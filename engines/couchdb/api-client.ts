/**
 * 共享的 CouchDB REST API 客户端工具
 */

// 本地开发的默认管理员凭据
// CouchDB 3.x 要求管理员账户才能启动
export const DEFAULT_ADMIN_USER = 'admin'
export const DEFAULT_ADMIN_PASSWORD = 'admin'

/**
 * 向 CouchDB REST API 发起 HTTP 请求
 *
 * @param port - CouchDB 监听的 HTTP 端口
 * @param method - HTTP 方法（GET、POST、PUT、DELETE）
 * @param path - API 路径（例如 '/'、'/_all_dbs'、'/mydb'）
 * @param body - POST/PUT 请求的可选 JSON 请求体
 * @param timeoutMs - 请求超时时间（毫秒，默认：30 秒）
 * @param auth - 可选的身份验证凭据（默认为 admin:admin）
 */
export async function couchdbApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
  auth: { username: string; password: string } | null = {
    username: DEFAULT_ADMIN_USER,
    password: DEFAULT_ADMIN_PASSWORD,
  },
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // 如果提供了凭据，则添加基本认证头
  if (auth) {
    const credentials = Buffer.from(
      `${auth.username}:${auth.password}`,
    ).toString('base64')
    headers['Authorization'] = `Basic ${credentials}`
  }

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)

    // 尝试按 JSON 解析，CouchDB 始终返回 JSON
    let data: unknown
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `CouchDB API 请求在 ${timeoutMs / 1000} 秒后超时：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
