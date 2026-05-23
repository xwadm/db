/**
 * InfluxDB REST API 公共客户端工具
 */

/**
 * 向 InfluxDB REST API 发起 HTTP 请求
 *
 * @param port - InfluxDB 监听的 HTTP 端口
 * @param method - HTTP 方法（GET、POST、PUT、DELETE）
 * @param path - API 路径（例如 '/health'、'/api/v3/query_sql'）
 * @param body - 可选请求体：对象类型用于 JSON，字符串类型用于 text/plain（行协议格式）
 * @param timeoutMs - 请求超时时间，单位毫秒（默认：30秒）
 */
export async function influxdbApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown> | string,
  timeoutMs = 30000,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['Content-Type'] = 'text/plain'
      options.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
  }

  try {
    const response = await fetch(url, options)

    // 尝试解析为 JSON，对于 /health 等端点则回退为文本解析
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
        `InfluxDB API 请求超时（${timeoutMs / 1000}秒）：${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
