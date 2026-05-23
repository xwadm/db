/**
 * 共享的 Meilisearch REST API 客户端工具
 */

/**
 * 向 Meilisearch REST API 发送 HTTP 请求
 *
 * @param port - Meilisearch 监听的 HTTP 端口
 * @param method - HTTP 方法（GET、POST、PUT、DELETE）
 * @param path - API 路径（如 '/indexes'、'/health'）
 * @param body - 可选的 JSON 请求体（用于 POST/PUT 请求）
 * @param timeoutMs - 请求超时（毫秒），默认 30 秒
 */
export async function meilisearchApiRequest(
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
    headers['Authorization'] = `Bearer ${apiKey}`
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

    // 尝试解析为 JSON，若失败则退回纯文本（如 /health 等端点）
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
        `Meilisearch API 请求超时（超过 ${timeoutMs / 1000}s）: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}