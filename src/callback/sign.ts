import {
  CALLBACK_SIGNATURE_PREFIX,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  buildSignaturePayload,
} from './protocol'

/**
 * 回调签名（HMAC-SHA256）—— 平台侧签名与参考验签实现。
 *
 * 全部走 WebCrypto 原生能力（`crypto.subtle.importKey/sign/verify`），不自研 HMAC，
 * 也不用「拼字符串后 === 比较」这种非常量时间的对手搓写法：
 * 验签一律用 `crypto.subtle.verify`（原生常量时间比较），比对失败与伪造签名不可区分。
 *
 * B5 的 SDK 会复用同一份规范串（{@link buildSignaturePayload}）与验签逻辑，
 * 因此这里同时导出 `verifyCallbackSignature()` 作为「协议参考实现」。
 */

const encoder = new TextEncoder()

/** HMAC 密钥句柄缓存：同一 signing key 在一个 isolate 内只 import 一次。 */
const keyCache = new Map<string, CryptoKey>()
const KEY_CACHE_LIMIT = 500

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret)
  if (cached !== undefined) return cached

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

  if (keyCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next()
    if (!oldest.done) keyCache.delete(oldest.value)
  }
  keyCache.set(secret, key)
  return key
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

/** 奇数长度或非 hex 字符返回 null（不抛错，验签路径只需要「能不能用」）。 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    bytes[index] = byte
  }
  return bytes
}

/** 签名材料（平台与下游都必须用同一份）。 */
export interface SignatureInput {
  secret: string
  timestamp: string
  executionId: string
  jobId: string
  body: string
}

/**
 * 计算签名头值：`v2=<小写 hex>`。
 *
 * 覆盖 `timestamp + executionId + jobId + body`（规范串见 {@link buildSignaturePayload}）。
 */
export async function signCallback(input: SignatureInput): Promise<string> {
  const key = await importHmacKey(input.secret)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(buildSignaturePayload(input)),
  )
  return `${CALLBACK_SIGNATURE_PREFIX}${bytesToHex(signature)}`
}

/** 验签失败原因（下游可据此分支：过期 vs 伪造 vs 没带签名）。 */
export type SignatureFailureReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_signed_field'
  | 'stale_timestamp'
  | 'bad_signature'

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason }

export interface VerifySignatureInput extends SignatureInput {
  /** `X-Waker-Signature` 头原值（`v2=<hex>`）。 */
  signature: string
  /** 收到请求的时刻（epoch ms），默认 `Date.now()`；测试可注入。 */
  now?: number
  /** 时间窗（秒），默认 {@link CALLBACK_TIMESTAMP_TOLERANCE_SECONDS}。 */
  toleranceSeconds?: number
}

/**
 * 验签（参考实现，供 B5 SDK 对齐 / 本次测试证明签名真的可用）。
 *
 * 判定顺序：材料齐全 → 签名格式 → 时间窗（防重放）→ HMAC 常量时间比对。
 */
export async function verifyCallbackSignature(
  input: VerifySignatureInput,
): Promise<SignatureVerification> {
  if (input.signature === undefined || input.signature.length === 0) {
    return { ok: false, reason: 'missing_signature' }
  }
  if (input.executionId.length === 0 || input.jobId.length === 0 || input.timestamp.length === 0) {
    return { ok: false, reason: 'missing_signed_field' }
  }

  if (!input.signature.startsWith(CALLBACK_SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed_signature' }
  }
  const provided = hexToBytes(input.signature.slice(CALLBACK_SIGNATURE_PREFIX.length))
  if (provided === null || provided.length !== 32) {
    return { ok: false, reason: 'malformed_signature' }
  }

  const timestampSeconds = Number(input.timestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'malformed_signature' }
  }

  const now = input.now ?? Date.now()
  const tolerance = input.toleranceSeconds ?? CALLBACK_TIMESTAMP_TOLERANCE_SECONDS
  const skewSeconds = Math.abs(now / 1000 - timestampSeconds)
  if (skewSeconds > tolerance) return { ok: false, reason: 'stale_timestamp' }

  const key = await importHmacKey(input.secret)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    provided,
    encoder.encode(buildSignaturePayload(input)),
  )
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

/** 测试专用：清空密钥句柄缓存。 */
export function resetSignatureKeyCache(): void {
  keyCache.clear()
}
