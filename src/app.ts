import { Hono } from 'hono'

import type { ApiEnv } from './api/auth'
import { managementRoutes } from './api/management'
import { registrationRoutes } from './api/registration'

/**
 * HTTP 路由表。
 *
 *   GET  /healthz   健康检查（无鉴权）
 *   ANY  /v1/*      注册 API：项目令牌鉴权（Bearer <项目令牌>），见 `api/registration.ts`
 *   ANY  /api/*     管理面 API：会话 JWT 鉴权（`POST /api/auth/setup` 换取），见 `api/management.ts`
 *
 * 尚未实现的子路由仍回 501 + `not_implemented`：给前端一个明确信号，
 * 而不是让「路径不存在」和「还没做」混成同一个 404。
 */
export const app = new Hono<ApiEnv>()

app.get('/healthz', (c) => c.json({ ok: true, service: 'waker' }))

app.route('/v1', registrationRoutes)
app.route('/api', managementRoutes)

/** 兜底：已挂载路由之外的管理面 / 注册面路径（如执行记录、死信列表，等 B6 的查询 RPC）。 */
app.all('/api/*', (c) => c.json({ error: 'not_implemented', scope: 'management-api' }, 501))
app.all('/v1/*', (c) => c.json({ error: 'not_implemented', scope: 'registration-api' }, 501))

app.notFound((c) => c.json({ error: 'not_found' }, 404))
