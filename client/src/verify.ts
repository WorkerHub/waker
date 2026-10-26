import {
  CALLBACK_SIGNATURE_PREFIX,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  buildSignaturePayload,
} from './protocol'

/**
 * HMAC 验签 helper（对齐 B3 冻结契约）。
 *
 * 全部用 Workers / Node 都自带的 WebCrypto：`crypto.subtle.importKey` / `crypto.subtle.verify`。
 * **不手搓 HMAC，也不用 `===` 比较签名**——`crypto.subtle.verify` 是原生常量时间实现，
 * 自己逐字节比会是计时侧信道。
 */

const encoder = new TextEncoder()

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

export interface VerifySignatureInput {
  /** 项目 signing key 明文（平台建项目时一次性展示的那把）。 */
  secret: string
  /** `X-Waker-Signature` 头原值（`v2=<hex>`）。 */
  signature: string
  /** `X-Waker-Timestamp` 头原值（epoch 秒的十进制字符串）。 */
  timestamp: string
  /** `X-Waker-Execution-Id`。 */
  executionId: string
  /** `X-Waker-Job-Id`。 */
  jobId: string
  /** 未解析的原始请求体字符串。 */
  body: string
  /** 收到请求的时刻（epoch ms），默认 `Date.now()`；测试可注入。 */
  now?: number
  /** 时间窗（秒），默认 {@link CALLBACK_TIMESTAMP_TOLERANCE_SECONDS}。 */
  toleranceSeconds?: number
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    bytes[index] = byte
  }
  return bytes
}

/**
 * 验签：材料齐全 → 签名格式 → 时间窗（防重放）→ HMAC 常量时间比对。
 *
 * 该函数不抛错，所有失败折成 `{ ok: false, reason }`，便于下游直接映射 HTTP 状态码。
 */
export async function verifyWakerSignature(
  input: VerifySignatureInput,
): Promise<SignatureVerification> {
  if (input.signature.length === 0) return { ok: false, reason: 'missing_signature' }
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
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: 'malformed_signature' }

  const now = input.now ?? Date.now()
  const tolerance = input.toleranceSeconds ?? CALLBACK_TIMESTAMP_TOLERANCE_SECONDS
  if (Math.abs(now / 1000 - timestampSeconds) > tolerance) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    provided,
    encoder.encode(buildSignaturePayload(input)),
  )
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' }
}
