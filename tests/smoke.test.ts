import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import { app } from '../src/app'
import type { Env } from '../src/env'

/**
 * 仅用于「不碰 DO」的鉴权失败路径：没有 Authorization 头时中间件直接 401，
 * 不会走到 DO 存根，所以这里给一个最小 env 就够了。
 * 需要真 DO / 真 SQLite 的行为一律在 tests/api.test.ts 里用真 workerd 跑。
 */
const MINIMAL_ENV = {
  SETUP_SECRET: 'unit-test-placeholder',
  JWT_SECRET: 'unit-test-placeholder',
} as unknown as Env

describe('worker 骨架', () => {
  it('/healthz 返回 ok', async () => {
    const response = await app.request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'waker' })
  })

  it('B4 已挂载的管理面 / 注册 API 一律要求鉴权（无令牌 → 401，不再是 501 占位）', async () => {
    for (const path of [
      '/api/jobs',
      '/api/projects',
      '/api/executions',
      '/api/dead-letters',
      '/v1/jobs',
      '/v1/manifest',
      '/v1/whoami',
    ]) {
      const response = await app.request(path, {}, MINIMAL_ENV)
      expect(response.status, path).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
    }
  })

  it('未知路由返回 404', async () => {
    const response = await app.request('/nope')
    expect(response.status).toBe(404)
  })

  it('wrangler.toml 绑定契约未被改坏（DO + 两条队列）', () => {
    const config = readFileSync(`${import.meta.dirname}/../wrangler.toml`, 'utf8')
    expect(config).toContain('class_name = "WakerDO"')
    expect(config).toContain('name = "WAKER_DO"')
    expect(config).toContain('binding = "WAKER_QUEUE"')
    expect(config).toContain('binding = "WAKER_DLQ"')
    expect(config).toContain('dead_letter_queue = "waker-dlq"')
  })
})
