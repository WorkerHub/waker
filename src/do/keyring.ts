/**
 * 凭据材料：项目令牌与 signing key 的生成 / 哈希 / 静态加密。
 *
 * 全部走 WebCrypto 原生能力（`crypto.getRandomValues` / `crypto.subtle.digest` /
 * `HKDF` / `AES-GCM`），不自研哈希、加密或随机数。
 *
 * 三条落库规则（B4 冻结）：
 *   1. 项目令牌**只存哈希**：`sha256(token)` 的 hex，明文只在发放/轮换应答里出现一次。
 *   2. signing key **加密存 DO**：AES-256-GCM，密钥由 `JWT_SECRET` 经 HKDF-SHA256 派生
 *      （不额外增加部署期 secret，符合 SPEC「signing key 不进 env / CI」）。
 *   3. 明文只在 DO 内部取用（`WakerDO.#resolveCallbackTarget`），密文/明文都不返回给 consumer、
 *      不进队列消息、不进日志。
 */

const encoder = new TextEncoder()

/** signing key 密文信封前缀（版本化，便于日后换算法而不静默误判）。 */
export const SIGNING_SECRET_ENVELOPE_PREFIX = 'waker-enc:v1:'

/** 项目令牌明文前缀（便于密钥泄漏扫描器识别，如 GitHub secret scanning）。 */
export const PROJECT_TOKEN_PREFIX = 'wkr_'

/** 签名算法（写进 `signing_keys.algorithm` 与契约）。 */
export const SIGNING_ALGORITHM = 'HMAC-SHA256'

/**
 * KEK 派生的定值参数。
 *
 * `salt` / `info` 是协议常量（不是密钥），改动等价于换一代信封格式：
 * 老密文会解不开并以 `signing_key_unreadable` 报错，而不是静默签出一个错签名。
 */
const KEK_SALT = 'waker/signing-key/kek/v1'
const KEK_INFO = 'waker:signing-key:aes-256-gcm:v1'

/** 32 字节随机 → 小写 hex。 */
function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** SHA-256 hex（令牌哈希与指纹共用）。 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  const bytes = new Uint8Array(digest)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** 生成项目令牌明文（`wkr_` + 32 字节随机 hex = 256 bit 熵）。 */
export function generateProjectToken(): string {
  return `${PROJECT_TOKEN_PREFIX}${randomHex(32)}`
}

/** 令牌落库值：只存 `sha256(token)`。 */
export function hashProjectToken(token: string): Promise<string> {
  return sha256Hex(token)
}

/** 掩码展示值：取哈希前 16 hex（不可反推明文，且足够人工比对）。 */
export function fingerprintFromHash(hash: string): string {
  return hash.slice(0, 16)
}

/** 生成 signing key 明文（32 字节随机 hex，HMAC-SHA256 用）。 */
export function generateSigningSecret(): string {
  return randomHex(32)
}

/** signing key 指纹（展示用）：`sha256(secret)` 前 16 hex。 */
export async function signingSecretFingerprint(secret: string): Promise<string> {
  return fingerprintFromHash(await sha256Hex(secret))
}

/**
 * 由 `JWT_SECRET` 派生 KEK（HKDF-SHA256 → AES-256-GCM）。
 *
 * 为什么用 HKDF 而不是直接拿 `JWT_SECRET` 当 AES 密钥：
 *   - 一把密钥只干一件事（JWT 签名与 signing key 加密互不影响）；
 *   - 密钥长度由 HKDF 规整成 AES-256 需要的 32 字节，不依赖 secret 的字符长度；
 *   - 全程 WebCrypto 原生，不自研 KDF。
 */
export async function deriveSigningKeyKek(jwtSecret: string): Promise<CryptoKey> {
  if (typeof jwtSecret !== 'string' || jwtSecret.length === 0) {
    throw new Error('JWT_SECRET 未配置：无法派生 signing key 的加密密钥')
  }
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(jwtSecret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(KEK_SALT),
      info: encoder.encode(KEK_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 加密 signing key 明文 → `waker-enc:v1:<iv b64>:<密文 b64>`（IV 12 字节随机）。 */
export async function encryptSigningSecret(secret: string, kek: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    kek,
    encoder.encode(secret),
  )
  return `${SIGNING_SECRET_ENVELOPE_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`
}

/**
 * 解密信封；格式不认识或密钥不匹配时返回 null（调用方翻译成
 * `signing_key_unreadable`，不让密文以「明文」身份被拿去签名）。
 */
export async function decryptSigningSecret(
  envelope: string,
  kek: CryptoKey,
): Promise<string | null> {
  if (!envelope.startsWith(SIGNING_SECRET_ENVELOPE_PREFIX)) return null
  const body = envelope.slice(SIGNING_SECRET_ENVELOPE_PREFIX.length)
  const separator = body.indexOf(':')
  if (separator <= 0 || separator === body.length - 1) return null

  try {
    const iv = base64ToBytes(body.slice(0, separator))
    const ciphertext = base64ToBytes(body.slice(separator + 1))
    if (iv.length !== 12 || ciphertext.length === 0) return null
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch {
    // GCM 认证失败（换过 JWT_SECRET / 密文被改动）：一律视为不可读，不区分原因。
    return null
  }
}

/** 信封是否是本模块产出的密文（迁移期的老明文数据判定用）。 */
export function isSigningSecretEnvelope(value: string): boolean {
  return value.startsWith(SIGNING_SECRET_ENVELOPE_PREFIX)
}
