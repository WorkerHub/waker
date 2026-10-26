import { HTTPException } from 'hono/http-exception'
import { bearerAuth } from 'hono/bearer-auth'
import { jwt, sign } from 'hono/jwt'
import type { MiddlewareHandler } from 'hono'

import type { ProjectAuthView } from '../do/types'
import { getWakerStub } from '../do/instance'
import type { Env } from '../env'
import { jsonError } from './errors'

/**
 * 两套互相独立的鉴权（B4 冻结）：
 *
 *   - **注册 API**（`/v1/*`）：每项目一个令牌，`Authorization: Bearer <项目令牌>`。
 *     校验在 WakerDO 内部完成（令牌只存哈希，`sha256(token)` 直查唯一索引）。
 *     解析与判定都用 Hono 原生 `bearerAuth` 中间件，不自研头解析。
 *
 *   - **管理面 API**（`/api/*`）：单人所有者模型。用 `SETUP_SECRET` 换一枚 JWT 会话
 *     （`POST /api/auth/setup`），后续请求带 `Authorization: Bearer <JWT>`；
 *     签发与校验都用 Hono 原生 `hono/jwt`，不自研 JWT/签名。
 *
 * 说明（已在交付评论里上报的缺口）：SPEC §6 的 Passkey / TOTP 登录器不在本单范围，
 * 当前管理面只做到「SETUP_SECRET 换会话」这一步——它保证未授权者进不了管理面，
 * 但还不是完整的登录器。Passkey/TOTP 需要单独立单（涉及前端与凭据管理）。
 */

/** 路由上下文变量：注册 API 通过鉴权后把项目身份挂在这里（路由只信它）。 */
export interface ApiEnv {
  Bindings: Env
  Variables: {
    project: ProjectAuthView
  }
}

const encoder = new TextEncoder()

/**
 * 常量时间比较（用于 `SETUP_SECRET`）。
 *
 * 做法：用运行时原生 HMAC 计算两边的认证标签，再用 `crypto.subtle.verify` 比较 ——
 * 规范要求 verify 是常量时间实现，因此不泄漏「前缀匹配了多少位」。
 * 不手写逐字节比较（那正是计时侧信道来源）。
 */
export async function constantTimeEquals(presented: string, expected: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const tag = await crypto.subtle.sign('HMAC', key, encoder.encode(presented))
  return crypto.subtle.verify('HMAC', key, tag, encoder.encode(expected))
}

/** 注册 API 鉴权：项目令牌 → `c.get('project')`。 */
export function registrationAuth(): MiddlewareHandler<ApiEnv> {
  return bearerAuth<ApiEnv>({
    realm: 'waker-registration',
    verifyToken: async (token, c) => {
      const result = await getWakerStub(c.env).verifyProjectToken({ token })
      if (!result.ok) return false
      const project = result.value
      if (project === null) return false
      c.set('project', project)
      return true
    },
    noAuthenticationHeader: {
      message: (c) => jsonError(c, 'unauthorized', '缺少项目令牌（Authorization: Bearer <项目令牌>）'),
      wwwAuthenticateHeader: 'Bearer realm="waker-registration"',
    },
    invalidToken: {
      message: (c) => jsonError(c, 'unauthorized', '项目令牌无效或项目已停用'),
      wwwAuthenticateHeader: 'Bearer error="invalid_token"',
    },
  })
}

/** 管理面会话有效期：12 小时（单人自托管，够一个工作日，不追求长期免登录）。 */
export const MANAGEMENT_SESSION_TTL_SECONDS = 12 * 60 * 60

export interface ManagementSession {
  token: string
  /** 过期时刻（epoch ms），前端可直接展示/倒计时。 */
  expiresAt: number
}

/**
 * 用 `SETUP_SECRET` 换一枚管理面会话 JWT。
 *
 * `SETUP_SECRET` 校验失败返回 null（路由统一回 401，不区分「没配」与「填错」）。
 */
export async function issueManagementSession(
  env: Env,
  presentedSetupSecret: string,
): Promise<ManagementSession | null> {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length === 0) return null
  if (presentedSetupSecret.length === 0) return null

  const matched = await constantTimeEquals(presentedSetupSecret, env.SETUP_SECRET, env.JWT_SECRET)
  if (!matched) return null

  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + MANAGEMENT_SESSION_TTL_SECONDS
  const token = await sign(
    { sub: 'owner', iss: 'waker', iat: issuedAt, exp: expiresAt },
    env.JWT_SECRET,
    'HS256',
  )

  return { token, expiresAt: expiresAt * 1000 }
}

/** 管理面鉴权：校验会话 JWT（Hono 原生 `jwt` 中间件），失败回统一错误体。 */
export function managementAuth(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    try {
      await jwt({ secret: c.env.JWT_SECRET, alg: 'HS256', realm: 'waker-management' })(c, next)
    } catch (error) {
      // jwt 中间件抛 HTTPException(401) 默认回纯文本；这里统一成冻结的 JSON 错误体。
      if (error instanceof HTTPException && error.status === 401) {
        return jsonError(c, 'unauthorized', '管理面需要有效的会话令牌（先 POST /api/auth/setup）')
      }
      throw error
    }
  }
}
