import { describe, expect, it } from 'vitest'

import {
  SIGNING_SECRET_ENVELOPE_PREFIX,
  decryptSigningSecret,
  deriveSigningKeyKek,
  encryptSigningSecret,
  fingerprintFromHash,
  generateProjectToken,
  generateSigningSecret,
  hashProjectToken,
  isSigningSecretEnvelope,
  sha256Hex,
  signingSecretFingerprint,
} from '../src/do/keyring'

/**
 * 凭据材料的单元测试：只测纯 crypto 行为（不做 IO、不起 workerd）。
 *
 * 覆盖 B4 的两条落库不变量：
 *   1. 令牌只以 `sha256(token)` 形式存在（可直查、不可反推、不可凭掩码还原）；
 *   2. signing key 只有 AES-256-GCM 信封进库，换密钥 / 篡改密文都必须解不开（fail closed）。
 */

const JWT_SECRET = 'unit-test-jwt-secret-not-a-real-value'

describe('项目令牌：生成 / 哈希 / 掩码', () => {
  it('令牌是 wkr_ + 64 位小写 hex（256 bit 熵）且每次不同', () => {
    const tokens = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const token = generateProjectToken()
      expect(token).toMatch(/^wkr_[0-9a-f]{64}$/)
      tokens.add(token)
    }
    expect(tokens.size).toBe(200)
  })

  it('哈希是稳定的 sha256 hex，掩码只取前 16 位', async () => {
    const token = generateProjectToken()
    const hash = await hashProjectToken(token)
    expect(hash).toHaveLength(64)
    expect(hash).toBe(await sha256Hex(token))
    expect(hash).toBe(await hashProjectToken(token))
    expect(fingerprintFromHash(hash)).toHaveLength(16)
    expect(fingerprintFromHash(hash)).toBe(hash.slice(0, 16))
    // 哈希里不出现令牌明文（防「哈希列当明文存」这类错误实现）。
    expect(hash).not.toContain(token)
  })
})

describe('signing key：AES-256-GCM 信封', () => {
  it('加密 → 解密可还原；信封带版本前缀且不含明文', async () => {
    const kek = await deriveSigningKeyKek(JWT_SECRET)
    const secret = generateSigningSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    const envelope = await encryptSigningSecret(secret, kek)
    expect(envelope.startsWith(SIGNING_SECRET_ENVELOPE_PREFIX)).toBe(true)
    expect(envelope).not.toContain(secret)
    expect(isSigningSecretEnvelope(envelope)).toBe(true)

    expect(await decryptSigningSecret(envelope, kek)).toBe(secret)
  })

  it('同一明文两次加密得到不同密文（IV 随机，同明文不产生可关联密文）', async () => {
    const kek = await deriveSigningKeyKek(JWT_SECRET)
    const secret = generateSigningSecret()
    const first = await encryptSigningSecret(secret, kek)
    const second = await encryptSigningSecret(secret, kek)
    expect(first).not.toBe(second)
    expect(await decryptSigningSecret(first, kek)).toBe(secret)
    expect(await decryptSigningSecret(second, kek)).toBe(secret)
  })

  it('换 JWT_SECRET 后解不开（返回 null，不当明文用）', async () => {
    const sourceKek = await deriveSigningKeyKek(JWT_SECRET)
    const otherKek = await deriveSigningKeyKek('another-jwt-secret-not-a-real-value')
    const envelope = await encryptSigningSecret(generateSigningSecret(), sourceKek)
    expect(await decryptSigningSecret(envelope, otherKek)).toBeNull()
  })

  it('密文被篡改 / 格式不认识 → null（GCM 认证失败不降级成明文）', async () => {
    const kek = await deriveSigningKeyKek(JWT_SECRET)
    const envelope = await encryptSigningSecret(generateSigningSecret(), kek)

    const tampered = `${envelope.slice(0, -4)}0000`
    expect(await decryptSigningSecret(tampered, kek)).toBeNull()
    expect(await decryptSigningSecret('plain-text-secret', kek)).toBeNull()
    expect(await decryptSigningSecret(`${SIGNING_SECRET_ENVELOPE_PREFIX}bad`, kek)).toBeNull()
  })

  it('指纹是对明文的 sha256 前 16 hex，且与明文无关可复原', async () => {
    const secret = generateSigningSecret()
    expect(await signingSecretFingerprint(secret)).toBe((await sha256Hex(secret)).slice(0, 16))
    expect(await signingSecretFingerprint(secret)).toHaveLength(16)
  })
})
