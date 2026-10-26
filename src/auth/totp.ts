/**
 * TOTP（RFC 6238）—— 用 eNotify 已在用的 `otpauth` 依赖，不手搓 base32/HMAC/截断。
 *
 * SPEC §5 只冻结了协议形状：6 位、SHA-1、30 秒周期、校验 ±1 窗口、码用过即记防重放。
 * 参数与 eNotify `services/twofa.ts` 的 otpauth URI 完全一致（algorithm=SHA1 & digits=6 & period=30）。
 *
 * 与 eNotify 的有意分叉（SPEC §0 已定）：secret 在 waker 里**密文信封**落库，
 * 明文只在 DO 内存里出现（加密/解密见 `src/do/keyring.ts`）。
 */
import * as OTPAuth from 'otpauth'

/** 展示用的发行方名（otpauth URI 的 issuer；对齐 eNotify 的固定值做法）。 */
export const TOTP_ISSUER = 'waker'

/** 6 位码的校验窗口：±1 个周期（照 SPEC §5.1）。 */
export const TOTP_WINDOW = 1

/** 生成 20 字节随机 secret 的 base32 表示（160 bit，RFC 4226 推荐长度）。 */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

function totpFor(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  })
}

/** 生成 otpauth URI（前端用 qrcode 库渲染成二维码，后端不生成图片）。 */
export function totpUri(secret: string, label: string): string {
  return totpFor(secret, label).toString()
}

/** 当前应输入的 6 位码（仅测试与自测脚本使用）。 */
export function totpCodeAt(secret: string, label: string, epochMs: number = Date.now()): string {
  return totpFor(secret, label).generate({ timestamp: epochMs })
}

/**
 * 校验 6 位码（±1 窗口）。
 *
 * 返回命中窗口的 delta（0 / ±1）或 null —— 调用方只关心「过没过」，
 * 但把 delta 返回出来方便测试断言窗口语义。
 */
export function verifyTotpCode(
  secret: string,
  label: string,
  code: string,
  epochMs: number = Date.now(),
): number | null {
  const token = typeof code === 'string' ? code.trim() : ''
  if (!/^[0-9]{6}$/.test(token)) return null
  return totpFor(secret, label).validate({ token, timestamp: epochMs, window: TOTP_WINDOW })
}
