export function validateTypedbConnectionString(input: string): string | null {
  const hostPortPattern = /^(?:[\w.-]+|\[[\da-fA-F:]+\]):\d+(?:\/.*)?$/
  const schemeHostPattern = /^(?:typedb|typedb-core|https?):\/\/[^/]+/
  if (!hostPortPattern.test(input) && !schemeHostPattern.test(input)) {
    return '连接字符串必须为 host:port、[IPv6]:port、typedb://、typedb-core:// 或 http(s):// 格式并包含主机地址'
  }
  return null
}
