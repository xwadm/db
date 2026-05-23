/**
 * 凭证生成器
 *
 * 为 Docker 导出生成安全的随机凭证。
 * 使用 Node.js crypto 模块生成加密安全的随机值。
 */

import { randomBytes } from 'crypto'

// 密码生成用的字符集
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
// 仅使用 shell 安全的符号（不含 # $ & * ? \ ' " ` ! | ; < > 等）
const SYMBOLS = '%+-=@^_'

// 默认字符集（字母数字 + shell 安全符号）
const DEFAULT_CHARSET = LOWERCASE + UPPERCASE + DIGITS + SYMBOLS

// 仅字母数字（用于不支持特殊字符的系统）
const ALPHANUMERIC_CHARSET = LOWERCASE + UPPERCASE + DIGITS

export type PasswordOptions = {
  // 密码长度（默认：16）
  length?: number
  // 仅使用字母数字（不含特殊字符）
  alphanumericOnly?: boolean
  // 自定义字符集
  charset?: string
}

/**
 * 生成加密安全的随机密码
 * @param options 密码生成选项
 * @returns 生成的密码字符串
 */
export function generatePassword(options: PasswordOptions = {}): string {
  const { length = 16, alphanumericOnly = false, charset } = options

  const chars =
    charset || (alphanumericOnly ? ALPHANUMERIC_CHARSET : DEFAULT_CHARSET)

  // 生成随机字节
  const bytes = randomBytes(length)

  // 转换为密码字符
  let password = ''
  for (let i = 0; i < length; i++) {
    // 使用取模将字节映射到字符索引
    // 这存在轻微偏差，但对密码生成来说可以接受
    password += chars[bytes[i] % chars.length]
  }

  return password
}

/**
 * 生成随机十六进制字符串（用于 API 密钥、令牌等）
 * @param byteLength 随机字节数（输出长度为字节数的 2 倍）
 * @returns 十六进制字符串
 */
export function generateHexToken(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('hex')
}

/**
 * 生成随机字母数字 ID（用于容器名称等）
 * @param length ID 长度
 * @returns 字母数字字符串
 */
export function generateId(length: number = 8): string {
  return generatePassword({ length, alphanumericOnly: true }).toLowerCase()
}

export type Credentials = {
  username: string
  password: string
}

/**
 * 为 Docker 导出生成标准凭证
 * 仅使用字母数字以避免特殊字符在以下场景中的问题：
 * - 连接字符串（@ 是分隔符，% 需要 URL 编码）
 * - 环境变量解析（= 可能导致问题）
 * - SQL/shell 命令（引号、反斜杠需要转义）
 * @returns 包含用户名和密码的对象
 */
export function generateCredentials(): Credentials {
  return {
    username: 'spindb',
    password: generatePassword({ length: 20, alphanumericOnly: true }),
  }
}
