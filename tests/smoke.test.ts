import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import { app } from '../src/app'

describe('worker 骨架', () => {
  it('/healthz 返回 ok', async () => {
    const response = await app.request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'workers-scheduler' })
  })

  it('未实现的管理面 / 注册 API 返回 501 占位', async () => {
    for (const path of ['/api/jobs', '/v1/jobs']) {
      const response = await app.request(path)
      expect(response.status).toBe(501)
      expect(await response.json()).toMatchObject({ error: 'not_implemented' })
    }
  })

  it('未知路由返回 404', async () => {
    const response = await app.request('/nope')
    expect(response.status).toBe(404)
  })

  it('wrangler.toml 绑定契约未被改坏（DO + 两条队列）', () => {
    const config = readFileSync(`${import.meta.dirname}/../wrangler.toml`, 'utf8')
    expect(config).toContain('class_name = "SchedulerDO"')
    expect(config).toContain('name = "SCHEDULER_DO"')
    expect(config).toContain('binding = "JOB_QUEUE"')
    expect(config).toContain('binding = "JOB_DLQ"')
    expect(config).toContain('dead_letter_queue = "workers-scheduler-dlq"')
  })
})
