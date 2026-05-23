/**
 * 共享 libSQL (sqld) REST API 客户端工具
 *
 * 使用基于 HTTP 的 Hrana 协议进行 SQL 查询。
 * 参见：https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
 */

type HranaValue =
  | { type: 'null'; value?: undefined }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

type HranaResult = {
  cols: { name: string; decltype: string | null }[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
}

type HranaPipelineResponse = {
  results: Array<{
    type: 'ok' | 'error'
    response?: { type: string; result?: HranaResult }
    error?: { message: string; code?: string }
  }>
  baton: string | null
}

/**
 * 通过 Hrana HTTP 协议执行 SQL 语句
 *
 * @param port - sqld 监听的 HTTP 端口
 * @param sql - 要执行的 SQL 语句
 * @param options - 可选设置：timeoutMs（默认：30秒），authToken（JWT Bearer 令牌）
 */
export async function libsqlQuery(
  port: number,
  sql: string,
  options?: { timeoutMs?: number; authToken?: string },
): Promise<HranaResult> {
  const timeoutMs = options?.timeoutMs ?? 30000
  const url = `http://127.0.0.1:${port}/v2/pipeline`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const body = {
    requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options?.authToken) {
    headers['Authorization'] = `Bearer ${options.authToken}`
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`libSQL API 请求失败 (${response.status}): ${text}`)
    }

    const data = (await response.json()) as HranaPipelineResponse

    // 检查管道响应中的错误
    const firstResult = data.results[0]
    if (firstResult?.type === 'error') {
      throw new Error(
        `libSQL 查询错误: ${firstResult.error?.message ?? '未知错误'}`,
      )
    }

    const result = firstResult?.response?.result
    if (!result) {
      // 对于不返回行的语句（如 INSERT/UPDATE）
      return {
        cols: [],
        rows: [],
        affected_row_count: 0,
        last_insert_rowid: null,
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`libSQL API 请求在 ${timeoutMs / 1000}秒 后超时`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 向 sqld 服务器发起通用 HTTP 请求
 *
 * @param port - sqld 监听的 HTTP 端口
 * @param method - HTTP 方法
 * @param path - URL 路径
 * @param timeoutMs - 请求超时时间（毫秒，默认：30秒）
 * @param authToken - 可选，用于身份验证的 JWT Bearer 令牌
 */
export async function libsqlApiRequest(
  port: number,
  method: string,
  path: string,
  timeoutMs = 30000,
  authToken?: string,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    })

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
        `libSQL API 请求在 ${timeoutMs / 1000}秒 后超时: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 将 Hrana 值转换为 JavaScript 友好的值
 */
export function hranaValueToJs(val: HranaValue): unknown {
  switch (val.type) {
    case 'null':
      return null
    case 'integer': {
      const n = BigInt(val.value)
      return n > BigInt(Number.MAX_SAFE_INTEGER) ||
        n < BigInt(-Number.MAX_SAFE_INTEGER)
        ? n
        : Number(val.value)
    }
    case 'float':
      return val.value
    case 'text':
      return val.value
    case 'blob':
      return `<blob:${val.base64}>`
    default:
      return String((val as { value?: unknown }).value ?? null)
  }
}
