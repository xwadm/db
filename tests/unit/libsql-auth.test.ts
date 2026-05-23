/**
 * libSQL JWT 认证单元测试
 *
 * 测试 Ed25519 密钥生成、JWT 创建、格式验证
 * 以及签名验证，遵循与 libSQL 引擎的 createJwt() 函数
 * 相同的模式。
 */

import { describe, it } from 'node:test'
import { generateKeyPairSync, sign, verify, createPublicKey } from 'crypto'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'

/**
 * 本地重新实现 createJwt，以便测试 JWT 格式和
 * 签名逻辑，而无需从引擎模块导出私有函数。
 */
function createJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ a: 'rw' })).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString(
    'base64url',
  )
  return `${signingInput}.${signature}`
}

describe('libSQL JWT Authentication', () => {
  describe('JWT token format', () => {
    it('应生成三部分点分隔的令牌', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const parts = token.split('.')
      assertEqual(
        parts.length,
        3,
        'JWT 应有 3 部分 (header.payload.signature)',
      )
    })

    it('应有 base64url 编码的 header', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      // base64url 不应包含 +, /, 或 = (填充)
      assert(
        !/[+/=]/.test(headerPart),
        'Header 应为 base64url (无 +, /, 或 =)',
      )

      // 应解码为有效的 JSON
      const decoded = Buffer.from(headerPart, 'base64url').toString('utf-8')
      const parsed = JSON.parse(decoded)
      assert(typeof parsed === 'object', 'Header 应解码为对象')
    })

    it('应有 base64url 编码的 payload', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      assert(
        !/[+/=]/.test(payloadPart),
        'Payload 应为 base64url (无 +, /, 或 =)',
      )

      const decoded = Buffer.from(payloadPart, 'base64url').toString('utf-8')
      const parsed = JSON.parse(decoded)
      assert(typeof parsed === 'object', 'Payload 应解码为对象')
    })

    it('应有 base64url 编码的 signature', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const signaturePart = token.split('.')[2]
      assert(signaturePart.length > 0, 'Signature 部分不应为空')
      assert(
        !/[+/=]/.test(signaturePart),
        'Signature 应为 base64url (无 +, /, 或 =)',
      )
    })
  })

  describe('JWT header', () => {
    it('alg 应设置为 EdDSA', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      assertEqual(header.alg, 'EdDSA', '算法应为 EdDSA')
    })

    it('typ 应设置为 JWT', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      assertEqual(header.typ, 'JWT', '类型应为 JWT')
    })

    it('应只有 alg 和 typ 字段', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      const keys = Object.keys(header).sort()
      assertEqual(keys.length, 2, 'Header 应只有 2 个键')
      assertEqual(keys[0], 'alg', '第一个键应为 alg')
      assertEqual(keys[1], 'typ', '第二个键应为 typ')
    })
  })

  describe('JWT payload', () => {
    it('"a" 声明应设置为 "rw"', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf-8'),
      )

      assertEqual(payload.a, 'rw', 'Payload "a" 声明应为 "rw"')
    })

    it('应只有一个声明', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf-8'),
      )

      const keys = Object.keys(payload)
      assertEqual(keys.length, 1, 'Payload 应只有 1 个键')
      assertEqual(keys[0], 'a', '唯一键应为 "a"')
    })
  })

  describe('Ed25519 密钥生成和 JWT 签名', () => {
    it('应生成有效的 Ed25519 密钥对', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')

      assertTruthy(publicKey, '应生成 Public key')
      assertTruthy(privateKey, '应生成 Private key')

      assertEqual(
        publicKey.asymmetricKeyType,
        'ed25519',
        'Public key 应为 Ed25519',
      )
      assertEqual(
        privateKey.asymmetricKeyType,
        'ed25519',
        'Private key 应为 Ed25519',
      )
    })

    it('应生成可验证的签名', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        publicKey,
        signature,
      )
      assert(isValid, '签名应能通过 Public key 验证')
    })

    it('使用不同密钥对应验证失败', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const { publicKey: otherPublicKey } = generateKeyPairSync('ed25519')

      const token = createJwt(privateKey)
      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        otherPublicKey,
        signature,
      )
      assert(
        !isValid,
        '签名不应通过不同的 Public key 验证',
      )
    })

    it('不同密钥对应生成不同的令牌', () => {
      const keyPair1 = generateKeyPairSync('ed25519')
      const keyPair2 = generateKeyPairSync('ed25519')

      const token1 = createJwt(keyPair1.privateKey)
      const token2 = createJwt(keyPair2.privateKey)

      // Header 和 payload 是确定性的，但签名不同
      const sig1 = token1.split('.')[2]
      const sig2 = token2.split('.')[2]
      assert(
        sig1 !== sig2,
        '不同密钥对应生成不同的签名',
      )
    })

    it('相同密钥对应生成相同的令牌', () => {
      const { privateKey } = generateKeyPairSync('ed25519')

      const token1 = createJwt(privateKey)
      const token2 = createJwt(privateKey)

      // Ed25519 签名是确定性的（无随机 nonce）
      assertEqual(
        token1,
        token2,
        '相同密钥对应生成相同的令牌',
      )
    })
  })

  describe('JWT public key导出用于 sqld', () => {
    it('应以 PEM 格式导出 public key', () => {
      const { publicKey } = generateKeyPairSync('ed25519')

      const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string

      assertTruthy(pem, 'PEM 不应为空')
      assert(
        pem.startsWith('-----BEGIN PUBLIC KEY-----'),
        'PEM 应以 BEGIN PUBLIC KEY 头部开头',
      )
      assert(
        pem.trimEnd().endsWith('-----END PUBLIC KEY-----'),
        'PEM 应以 END PUBLIC KEY 尾部结尾',
      )
    })

    it('生成的 PEM 应可重新导入并用于验证', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      // 导出并重新导入 public key（模拟 sqld 读取文件）
      const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
      const reimported = createPublicKey({ key: pem, format: 'pem' })

      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        reimported,
        signature,
      )
      assert(isValid, '重新导入的 PEM 密钥应能验证 JWT 签名')
    })
  })
})
