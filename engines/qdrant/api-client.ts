/**
 * Qdrant REST API 客户端公共工具
 */

/**
 * 向 Qdrant REST API 发起 HTTP 请求
 *
 * @param port - Qdrant 监听的 HTTP 端口
 * @param method - HTTP 方法（GET、POST、PUT、DELETE）
 * @param path - API 路径（例如 '/collections'、'/snapshots'）
 * @param body - POST/PUT 请求的可选 JSON 请求体
 * @param timeoutMs - 请求超时时间，单位毫秒（默认 30s）
 */
export async function qdrantApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
  apiKey?: string,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers['api-key'] = apiKey
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

    // 尝试解析为 JSON，失败时降级为文本（处理 /healthz 等纯文本接口）
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
        `Qdrant API 请求在 ${timeoutMs / 1000}s 后超时: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}