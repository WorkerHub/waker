import { Hono } from 'hono'

import type { Env } from './env'

/**
 * HTTP 路由骨架。
 *
 * 本单只提供空壳：健康检查 + 后续子单要挂载的路由占位（一律 501）。
 * 管理面 API、注册 API、回调 endpoint 均不在 B1 范围。
 */
export const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.json({ ok: true, service: 'workers-scheduler' }))

/** 管理面 API（任务 / 执行日志 / 死信 / 项目 / 设置 / 系统管理）：后续单实现。 */
app.all('/api/*', (c) => c.json({ error: 'not_implemented', scope: 'management-api' }, 501))

/** 下游注册 API（声明式 cron 同步 + one-shot 创建/取消）：后续单实现。 */
app.all('/v1/*', (c) => c.json({ error: 'not_implemented', scope: 'registration-api' }, 501))

app.notFound((c) => c.json({ error: 'not_found' }, 404))
