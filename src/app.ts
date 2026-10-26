import { Hono } from 'hono'

import { systemSettingsRoutes, usersRoutes } from './api/admin'
import type { ApiEnv } from './api/auth'
import { authRoutes } from './api/auth-routes'
import { managementRoutes } from './api/management'
import { meRoutes } from './api/me'
import { registrationRoutes } from './api/registration'

/**
 * HTTP 路由表。
 *
 *   GET  /healthz       健康检查（无鉴权）
 *   ANY  /v1/*          注册 API：项目令牌鉴权（Bearer <项目令牌>），见 `api/registration.ts`
 *   POST /api/setup...  初始化：SETUP_SECRET → bootstrap 令牌 → 首个管理员，见 `api/auth-routes.ts`
 *   POST /api/auth/...  注册 / 两步登录（公开），见 `api/auth-routes.ts`
 *   ANY  /api/me...     本人设置（会话 + viewer 可用），见 `api/me.ts`
 *   ANY  /api/users...  用户管理（会话 + admin），见 `api/admin.ts`
 *   ANY  /api/system/...系统设置 / 邮件服务（会话 + admin；`GET /api/system/status` 只读），见 `api/admin.ts`
 *   ANY  /api/*         其余管理面（任务 / 项目 / 执行 / 死信），见 `api/management.ts`
 *
 * 顺序有意义：公开鉴权路由与更具体的 admin/me 路由先挂，后面的 `managementRoutes` 才吃掉剩余
 * `/api/*`。尚未实现的子路由仍回 501 + `not_implemented`：给前端一个明确信号，
 * 而不是让「路径不存在」和「还没做」混成同一个 404。
 */
export const app = new Hono<ApiEnv>()

app.get('/healthz', (c) => c.json({ ok: true, service: 'waker' }))

app.route('/v1', registrationRoutes)

// 公开鉴权面（初始化 / 注册 / 登录 / 2FA 验证）
app.route('/api', authRoutes)
// 本人设置（会话 + viewer 白名单）
app.route('/api/me', meRoutes)
// 用户管理（会话 + admin）
app.route('/api/users', usersRoutes)
// 系统设置 / 邮件服务（会话 + admin）
app.route('/api/system/settings', systemSettingsRoutes)
// 其余管理面（会话 + 权限矩阵）
app.route('/api', managementRoutes)

/** 兜底：已挂载路由之外的管理面 / 注册面路径。 */
app.all('/api/*', (c) => c.json({ error: 'not_implemented', scope: 'management-api' }, 501))
app.all('/v1/*', (c) => c.json({ error: 'not_implemented', scope: 'registration-api' }, 501))

app.notFound((c) => c.json({ error: 'not_found' }, 404))
