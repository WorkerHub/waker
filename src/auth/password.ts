/**
 * 密码哈希与规则（ONE-462 / SPEC §4.1）。
 *
 * **对齐 eNotify 现行 `worker/src/core/auth.ts`，不新发明**：
 *   - PBKDF2-HMAC-SHA256，100_000 轮，32 字节随机 salt，派生 256 bit；
 *   - 落库形态 `saltHex:hashHex`（小写 hex），salt 每条独立；
 *   - 校验用全量比较累积差异（不提前 return），避免按字符前缀泄漏。
 *
 * 规则（同样对齐 eNotify，只多一条长度上限）：
 *   - 至少 8 个字符；
 *   - 至多 200 个字符 —— 纯属防 PBKDF2 拖垮唯一 DO 的上限，不是新的复杂度规则。
 *
 * 全部走 WebCrypto 原生（`crypto.subtle.deriveBits`），不自研 KDF。
 */

const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 32
const DERIVED_BITS = 256

/** 密码长度下限（eNotify 现行规则）。 */
export const PASSWORD_MIN_LENGTH = 8
/** 密码长度上限（防 PBKDF2 DoS；不做复杂度规则）。 */
export const PASSWORD_MAX_LENGTH = 200

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** 密码是否符合规则；不符合时返回人话原因（路由直接透出）。 */
export function checkPasswordPolicy(password: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, message: '密码不能为空' }
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符` }
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `密码最长 ${PASSWORD_MAX_LENGTH} 个字符` }
  }
  return { ok: true }
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    DERIVED_BITS,
  )
  return new Uint8Array(bits)
}

/** 生成落库哈希：`saltHex:hashHex`。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  return `${toHex(salt)}:${toHex(await derive(password, salt))}`
}

/** 校验密码（格式不认识的哈希一律 false，不抛错）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const separator = stored.indexOf(':')
  if (separator <= 0) return false

  const salt = fromHex(stored.slice(0, separator))
  const expected = fromHex(stored.slice(separator + 1))
  if (salt === null || expected === null || expected.length === 0) return false

  const actual = await derive(password, salt)
  if (actual.length !== expected.length) return false

  let diff = 0
  for (let index = 0; index < actual.length; index += 1) diff |= actual[index]! ^ expected[index]!
  return diff === 0
}

/**
 * 用户不存在时也走一遍同样代价的哈希，抹平「邮箱是否注册」的计时差异
 * （照 eNotify `login` 的做法，用一条等长的假哈希）。
 */
export const DUMMY_PASSWORD_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000:' +
  '0000000000000000000000000000000000000000000000000000000000000000'
