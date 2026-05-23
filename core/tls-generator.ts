/**
 * TLS 证书生成器
 *
 * 为安全数据库连接生成自签名 TLS 证书。
 * 使用 openssl 命令行工具，在 macOS、Linux 和 Windows (Git Bash) 上均可用。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

export type TLSCertificateOptions = {
  // 证书输出目录
  outputDir: string
  // 证书通用名称（CN）（默认: localhost）
  commonName?: string
  // 有效期天数（默认: 365）
  validDays?: number
  // 组织名称（默认: SpinDB）
  organization?: string
}

export type TLSCertificateResult = {
  certPath: string
  keyPath: string
}

/**
 * 使用 openssl 生成自签名 TLS 证书
 * @param options 证书生成选项
 * @returns 生成的证书和密钥文件路径
 */
export async function generateTLSCertificates(
  options: TLSCertificateOptions,
): Promise<TLSCertificateResult> {
  const {
    outputDir,
    commonName = 'localhost',
    validDays = 365,
    organization = 'SpinDB',
  } = options

  // 确保输出目录存在
  await mkdir(outputDir, { recursive: true })

  const certPath = join(outputDir, 'server.crt')
  const keyPath = join(outputDir, 'server.key')

  // 构建证书的主题字符串
  const subject = `/O=${organization}/CN=${commonName}`

  // 使用 openssl 生成自签名证书
  // -x509: 输出自签名证书而非 CSR
  // -newkey rsa:2048: 生成 2048 位 RSA 密钥
  // -nodes: 不加密私钥
  // -keyout: 私钥输出路径
  // -out: 证书输出路径
  // -days: 有效期
  // -subj: 证书主题
  // -addext: 添加 localhost 的主题备用名称
  try {
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      String(validDays),
      '-subj',
      subject,
      '-addext',
      `subjectAltName=DNS:${commonName},DNS:localhost,IP:127.0.0.1`,
    ])
  } catch (error) {
    const e = error as Error
    throw new Error(
      `生成 TLS 证书失败: ${e.message}。` +
        '请确保 openssl 已安装且在 PATH 中可用。',
    )
  }

  return { certPath, keyPath }
}

/**
 * 检查系统上是否可用 openssl
 * @returns openssl 可用时返回 true
 */
export async function isOpenSSLAvailable(): Promise<boolean> {
  try {
    await execFileAsync('openssl', ['version'])
    return true
  } catch {
    return false
  }
}

/**
 * 检查目录中是否已存在 TLS 证书
 * @param certsDir 要检查的目录
 * @returns server.crt 和 server.key 都存在时返回 true
 */
export function tlsCertificatesExist(certsDir: string): boolean {
  const certPath = join(certsDir, 'server.crt')
  const keyPath = join(certsDir, 'server.key')
  return existsSync(certPath) && existsSync(keyPath)
}
