import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_SETUP_SECRET, http, startHarness, type TestContext } from './support/harness'

/**
 * SPEC §8.1 初始化验收（真 workerd + 真 DO SQLite，全走 HTTP 入口）。
 *
 *   - 空库输对 SETUP_SECRET 得 bootstrap 令牌、建首管成功；
 *   - 错密钥被限流与拒绝；
 *   - 建首管后 `/api/setup` 与旧 `/api/auth/setup` 均 403、SETUP_SECRET 彻底失效；
 *   - 并发建首管只有一个 admin。
 */

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

interface SetupState {
  schemaVersion: number
  initialized: boolean
  adminExists: boolean
  registrationEnabled: boolean
  emailProvider: string
}

let ctx: TestContext

beforeAll(async () => {
  ctx = await startHarness()
})

afterAll(async () => {
  await ctx.harness.close()
})

/** 每个用例用自己的源 IP：限流是「按 IP 3 次/10 分钟」，共用 IP 会互相踩。 */
function ipHeaders(ip: string): Record<string, string> {
  return { 'cf-connecting-ip': ip }
}

describe('初始化（SPEC §8.1）', () => {
  it('空库：state 报未初始化、schemaVersion=4、注册默认关、邮件通道默认 none', async () => {
    const response = await http<SetupState>(ctx, '/api/setup/state')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      schemaVersion: 4,
      initialized: false,
      adminExists: false,
      registrationEnabled: false,
      emailProvider: 'none',
    })
  })

  it('错 SETUP_SECRET → 401 invalid_credentials，且不签发任何令牌', async () => {
    const response = await http<ErrorBody>(ctx, '/api/setup', {
      method: 'POST',
      body: { setupSecret: 'wrong-secret' },
      headers: ipHeaders('10.1.0.1'),
    })
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('invalid_credentials')
    expect(JSON.stringify(response.body)).not.toContain('bootstrapToken')
  })

  it('同一 IP 连续试错 → 3 次后限流（429 rate_limited）', async () => {
    const headers = ipHeaders('10.1.0.2')
    const codes: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await http<ErrorBody>(ctx, '/api/setup', {
        method: 'POST',
        body: { setupSecret: 'wrong-secret' },
        headers,
      })
      codes.push(response.status)
      if (response.status === 429) {
        expect(response.body.error.code).toBe('rate_limited')
      }
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401])
    expect(codes[3]).toBe(429)
  })

  it('对 SETUP_SECRET → 200 + 一次性 bootstrap 令牌（≤10 分钟、不回会话）', async () => {
    const response = await http<{ bootstrapToken: string; expiresAt: number; adminExists: boolean }>(
      ctx,
      '/api/setup',
      { method: 'POST', body: { setupSecret: TEST_SETUP_SECRET }, headers: ipHeaders('10.1.0.3') },
    )
    expect(response.status).toBe(200)
    expect(response.body.bootstrapToken).toMatch(/^[0-9a-f]{64}$/)
    expect(response.body.adminExists).toBe(false)
    expect(response.body.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000)
    // 关键：SETUP_SECRET 不再能换会话（SPEC §5.2 删除 sub:'owner' 会话签发）
    expect(response.body).not.toHaveProperty('session')
  })

  it('并发用同一枚 bootstrap 令牌建首管 → 只有一个 admin 落库', async () => {
    const setup = await http<{ bootstrapToken: string }>(ctx, '/api/setup', {
      method: 'POST',
      body: { setupSecret: TEST_SETUP_SECRET },
      headers: ipHeaders('10.1.0.4'),
    })
    expect(setup.status).toBe(200)

    const bodies = [1, 2].map((index) => ({
      bootstrapToken: setup.body.bootstrapToken,
      email: `race-${index}@waker.test`,
      password: 'admin-password-123',
      displayName: `并发 ${index}`,
    }))

    const results = await Promise.all(
      bodies.map((body) =>
        http<{ user: { id: string; role: string }; session: { token: string } }>(ctx, '/api/setup/admin', {
          method: 'POST',
          body,
          headers: ipHeaders('10.1.0.4'),
        }),
      ),
    )

    const created = results.filter((result) => result.status === 201)
    expect(created).toHaveLength(1)
    expect(created[0]!.body.user.role).toBe('admin')

    const rows = await ctx.sql.exec(`SELECT id, role FROM users ORDER BY created_at`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('admin')
  })

  it('首个管理员存在后：/api/setup 与 /api/auth/setup 一律 403 already_initialized', async () => {
    // 上一用例已建出唯一管理员；这里确认状态并验双入口锁死。
    const state = await http<SetupState>(ctx, '/api/setup/state')
    expect(state.body.initialized).toBe(true)
    expect(state.body.adminExists).toBe(true)

    for (const path of ['/api/setup', '/api/auth/setup']) {
      const response = await http<ErrorBody>(ctx, path, {
        method: 'POST',
        body: { setupSecret: TEST_SETUP_SECRET },
        headers: ipHeaders('10.1.0.5'),
      })
      expect(response.status, path).toBe(403)
      expect(response.body.error.code).toBe('already_initialized')
    }
  })

  it('SETUP_SECRET 不能绕过密码换取任何可用会话（旧后门已删除）', async () => {
    const response = await http<ErrorBody>(ctx, '/api/auth/setup', {
      method: 'POST',
      body: { setupSecret: TEST_SETUP_SECRET },
      headers: ipHeaders('10.1.0.6'),
    })
    expect(response.status).toBe(403)

    // 就算有人把应答里的任意字符串当令牌用，也进不了管理面。
    const probe = await http(ctx, '/api/projects', { token: 'owner' })
    expect(probe.status).toBe(401)
  })
})
