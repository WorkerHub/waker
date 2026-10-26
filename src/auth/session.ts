/**
 * 会话令牌（ONE-462 / SPEC §5.2）：沿用 Hono 原生 `hono/jwt`，不手搓 JWT。
 *
 * 三种令牌，靠 `typ` claim 区分，**互不通用**（验签时都强制校验 `typ`）：
 *
 *   - `session`：正式管理面会话，HS256 + `JWT_SECRET`，12 小时；
 *     claim `sub=<user_id>` + `role`（现行 `sub:'owner'` 会话已删除）。
 *   - `2fa`：密码步通过、但该用户启用了第二因素时签发的短期令牌，≤5 分钟，
 *     只能在 2FA 步使用；`sid` 指向 DO 里的一次性状态（`auth_tmp:2fa:<sid>`），
 *     验码成功后该状态被删除 —— 令牌随之失效（一次性）。
 *   - 初始化 bootstrap 令牌不是 JWT：它是一枚不透明随机串，由 WakerDO 生成并
 *     以 HMAC 哈希落库（见 `do/auth-service.ts`），同样一次性。
 */
import { sign, verify } from 'hono/jwt'

import type { Env } from '../env'

/** 正式会话有效期：12 小时（与既有管理面口径一致）。 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

/** 两步登录的临时令牌有效期：5 分钟（SPEC §5.1 上限）。 */
export const TWO_FACTOR_TTL_SECONDS = 5 * 60

export type UserRole = 'admin' | 'viewer'

export interface SessionClaims {
  sub: string
  role: UserRole
  typ: 'session'
  iss: 'waker'
  iat: number
  exp: number
}

export interface TwoFactorClaims {
  sub: string
  typ: '2fa'
  sid: string
  iss: 'waker'
  iat: number
  exp: number
}

export interface IssuedToken {
  token: string
  /** 过期时刻（epoch ms），前端可直接展示/倒计时。 */
  expiresAt: number
}

function isRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'viewer'
}

/** 签发正式会话。 */
export async function issueSession(
  env: Env,
  input: { userId: string; role: UserRole },
): Promise<IssuedToken> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + SESSION_TTL_SECONDS
  const token = await sign(
    { sub: input.userId, role: input.role, typ: 'session', iss: 'waker', iat: issuedAt, exp: expiresAt },
    env.JWT_SECRET,
    'HS256',
  )
  return { token, expiresAt: expiresAt * 1000 }
}

/** 校验正式会话；不是本系统签发的 session 令牌一律 null（不抛错）。 */
export async function verifySession(env: Env, token: string): Promise<SessionClaims | null> {
  if (typeof token !== 'string' || token.length === 0) return null
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256')
    if (payload.typ !== 'session') return null
    if (payload.iss !== 'waker') return null
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    if (!isRole(payload.role)) return null
    return payload as unknown as SessionClaims
  } catch {
    return null
  }
}

/** 签发两步登录的临时令牌（只在 2FA 步可用）。 */
export async function issueTwoFactorToken(
  env: Env,
  input: { userId: string; sessionRef: string },
): Promise<IssuedToken> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + TWO_FACTOR_TTL_SECONDS
  const token = await sign(
    { sub: input.userId, typ: '2fa', sid: input.sessionRef, iss: 'waker', iat: issuedAt, exp: expiresAt },
    env.JWT_SECRET,
    'HS256',
  )
  return { token, expiresAt: expiresAt * 1000 }
}

/** 校验临时令牌；正式会话令牌在这里一律无效。 */
export async function verifyTwoFactorToken(
  env: Env,
  token: string,
): Promise<TwoFactorClaims | null> {
  if (typeof token !== 'string' || token.length === 0) return null
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256')
    if (payload.typ !== '2fa') return null
    if (payload.iss !== 'waker') return null
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    if (typeof payload.sid !== 'string' || payload.sid.length === 0) return null
    return payload as unknown as TwoFactorClaims
  } catch {
    return null
  }
}
