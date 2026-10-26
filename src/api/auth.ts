import { HTTPException } from 'hono/http-exception'
import { bearerAuth } from 'hono/bearer-auth'
import type { Context, MiddlewareHandler } from 'hono'

import type { UserView } from '../do/auth-types'
import type { ProjectAuthView } from '../do/types'
import { getApiStub } from '../do/http-rpc'
import { getWakerStub } from '../do/instance'
import type { Env } from '../env'
import { verifySession } from '../auth/session'
import { jsonError } from './errors'

export { constantTimeEquals } from '../auth/compare'

/**
 * 两套互相独立的鉴权：
 *
 *   - **注册 API**（`/v1/*`）：每项目一个令牌，`Authorization: Bearer <项目令牌>`。
 *     校验在 WakerDO 内部完成（令牌只存哈希，`sha256(token)` 直查唯一索引）。
 *     解析与判定都用 Hono 原生 `bearerAuth` 中间件，不自研头解析。
 *
 *   - **管理面 API**（`/api/*`）：用户体系（ONE-462 起）。`POST /api/auth/login` 用邮箱 + 密码
 *     换 12 小时会话 JWT（启用了 2FA 的用户还要过第二因素），后续请求带
 *     `Authorization: Bearer <JWT>`；签发与校验都用 Hono 原生 `hono/jwt`，不自研 JWT/签名。
 *
 *     **现行 `SETUP_SECRET` 换 `sub:'owner'` 会话已删除**（SPEC §5.2）：`SETUP_SECRET` 只在
 *     初始化阶段签发一次性 bootstrap 令牌，首个管理员建成后彻底失效（SPEC §3.2）。
 *
 * 权限矩阵（SPEC §4.2）在**接口层**强制：`admin` 全部能力；`viewer` 只读 GET + 本人设置，
 * 其余写接口一律 403 —— 不靠前端隐藏。角色/启用状态每次请求都从 DO 读，改角色立即生效。
 */

/** 路由上下文变量：注册 API 的项目身份、管理面的当前用户。 */
export interface ApiEnv {
  Bindings: Env
  Variables: {
    project: ProjectAuthView
    user: UserView
  }
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

/**
 * 管理面鉴权：会话 JWT（Hono 原生 `bearerAuth` 解析头 + `hono/jwt` 验签）→ `c.get('user')`。
 *
 * 每次请求都回 DO 读一次用户（`authGetSessionUser`），因此「降级 / 禁用」立即生效，
 * 不会出现「JWT 里还写着 admin，过期前一直有权限」的窗口。
 */
export function sessionAuth(): MiddlewareHandler<ApiEnv> {
  return bearerAuth<ApiEnv>({
    realm: 'waker-management',
    verifyToken: async (token, c) => {
      const claims = await verifySession(c.env, token)
      if (claims === null) return false

      const result = await getApiStub(c.env).authGetSessionUser({ userId: claims.sub })
      if (!result.ok) return false
      c.set('user', result.value)
      return true
    },
    noAuthenticationHeader: {
      message: (c) => jsonError(c, 'unauthorized', '管理面需要有效的会话令牌（先 POST /api/auth/login）'),
      wwwAuthenticateHeader: 'Bearer realm="waker-management"',
    },
    invalidToken: {
      message: (c) => jsonError(c, 'unauthorized', '会话令牌无效或已过期，请重新登录'),
      wwwAuthenticateHeader: 'Bearer error="invalid_token"',
    },
  })
}

/** 当前会话用户（`sessionAuth` 之后一定存在）。 */
export function currentUser<E extends { Variables: { user: UserView } }>(c: Context<E>): UserView {
  return c.get('user')
}

/** 仅管理员（挂在 admin 专属路由上，比「按方法判定」更难漏）。 */
export function requireAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (currentUser(c).role !== 'admin') {
      return jsonError(c, 'forbidden', '需要管理员权限')
    }
    await next()
  }
}

/**
 * 权限矩阵的兜底闸（SPEC §4.2）：**非 GET 且不在 `/api/me` 下的一律要求 admin**。
 *
 * 白名单只有「本人设置」（改昵称 / 改密码 / 自己的 2FA），viewer 也能用；
 * 其余写接口（任务、项目、用户管理、注册开关、邮件配置）只有 admin 能过。
 */
export function viewerWriteGuard(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    const path = new URL(c.req.url).pathname
    const isPersonalSettings = path === '/api/me' || path.startsWith('/api/me/')
    const readOnly = method === 'GET' || method === 'HEAD'

    if (!readOnly && !isPersonalSettings && currentUser(c).role !== 'admin') {
      return jsonError(c, 'forbidden', '只读账号不能调用写接口')
    }
    await next()
  }
}

/** 客户端 IP（CF 头优先，其次 XFF 第一段）；拿不到就落到 `unknown`（限流照常生效）。 */
export function clientIp(c: Context<ApiEnv>): string {
  const direct = c.req.header('cf-connecting-ip')
  if (typeof direct === 'string' && direct.length > 0) return direct
  const forwarded = c.req.header('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  return first !== undefined && first.length > 0 ? first : 'unknown'
}

/** 请求的 rpID / origin（WebAuthn 用；线上由 `waker.oneboy.app` 决定，测试由 harness 决定）。 */
export function requestOrigin(c: Context<ApiEnv>): { rpId: string; origin: string } {
  const url = new URL(c.req.url)
  return { rpId: url.hostname, origin: url.origin }
}

/** 兼容：把 `HTTPException(401)` 折成统一 JSON 错误体（供其他中间件复用）。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof HTTPException && error.status === 401
}
