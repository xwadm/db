/**
 * Weaviate REST API 客户端共享工具
 */

/**
 * 向 Weaviate REST API 发送 HTTP 请求
 *
 * @param port - Weaviate 监听的 HTTP 端口
 * @param method - HTTP 方法（GET、POST、PUT、DELETE）
 * @param path - API 路径（例如 '/v1/schema'、'/v1/.well-known/ready'）
 * @param body - POST/PUT 请求的可选 JSON 请求体
 * @param timeoutMs - 请求超时时间，单位毫秒（默认：30 秒）
 */
export async function weaviateApiRequest(
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

    // 尝试解析为 JSON，对于 /v1/.well-known/ready 等端点回退为纯文本
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
        `Weaviate API 请求超时（${timeoutMs / 1000} 秒）：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}