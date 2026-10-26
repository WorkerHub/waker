import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createWakerClient, WakerApiError, createD1ExecutionLedger, type WakerClient } from '../client/src/index'
import type { ProjectSigningKeyView, ProjectView } from '../src/do/types'
import { http, managementToken, startHarness, type TestContext } from './support/harness'

/**
 * 注册客户端（B4 注册 API）的集成测试：**SDK 打真平台**。
 *
 * 平台侧是真 workerd（真路由、真中间件、真令牌鉴权、真 WakerDO），SDK 侧走真全局 `fetch` 到
 * harness 的真实监听地址——所以「SDK 与注册 API 对得上」是被端到端证明的，不是对着 mock 断言。
 */

let ctx: TestContext
let client: WakerClient
let project: ProjectView

interface IssuedProject {
  project: ProjectView
  token: string
  signingKey: ProjectSigningKeyView & { secret: string }
}

beforeAll(async () => {
  ctx = await startHarness()
  const mgmtToken = await managementToken(ctx)
  const created = await http<IssuedProject>(ctx, '/api/projects', {
    method: 'POST',
    token: mgmtToken,
    body: { name: 'SDK 集成项目', callbackUrl: 'https://downstream.example.com' },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  project = created.body.project

  const { url } = await ctx.harness.listen()
  client = createWakerClient({ baseUrl: url.href, token: created.body.token })
})

afterAll(async () => {
  await ctx.harness.close()
})

describe('注册客户端', () => {
  it('whoami：令牌自检（项目身份只来自令牌）', async () => {
    const identity = await client.whoami()
    expect(identity.id).toBe(project.id)
    expect(identity.name).toBe(project.name)
  })

  it('createOneShot：运行时创建一次性任务（Date / 毫秒都接受）', async () => {
    const runAt = new Date(Date.now() + 3600_000)
    const job = await client.createOneShot({
      name: 'letter-42',
      runAt,
      payload: { letterId: 'letter-42' },
      policies: { maxRetries: 2, backoffSeconds: 5 },
    })

    expect(job).toMatchObject({
      projectId: project.id,
      name: 'letter-42',
      kind: 'one_shot',
      runAt: runAt.getTime(),
      status: 'active',
    })
    expect(job.nextRunAt).toBe(runAt.getTime())
    expect(job.policies).toMatchObject({ maxRetries: 2, backoffSeconds: 5 })

    const listed = await client.listJobs({ kind: 'one_shot' })
    expect(listed.jobs.map((entry) => entry.name)).toContain('letter-42')
  })

  it('cancelJob：取消一次性任务（幂等），未知名字映射成契约错误码', async () => {
    const cancelled = await client.cancelJob('letter-42')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nextRunAt).toBeNull()

    await expect(client.cancelJob('no-such-job')).rejects.toMatchObject({
      code: 'job_not_found',
      status: 404,
    })
  })

  it('syncManifest：声明式清单幂等对账（created → unchanged → paused）', async () => {
    const first = await client.syncManifest([
      { name: 'daily-cleanup', cron: '0 3 * * *', timezone: 'Asia/Shanghai' },
    ])
    expect(first.created).toContain('daily-cleanup')
    expect(first.jobs.find((job) => job.name === 'daily-cleanup')?.cron).toBe('0 3 * * *')

    const second = await client.syncManifest([
      { name: 'daily-cleanup', cron: '0 3 * * *', timezone: 'Asia/Shanghai' },
    ])
    expect(second.created).toHaveLength(0)
    expect(second.updated).toHaveLength(0)
    expect(second.unchanged).toContain('daily-cleanup')

    const emptied = await client.syncManifest([])
    expect(emptied.paused).toContain('daily-cleanup')
  })

  it('cron 表达式原样透传给平台方言解析器（CF 扩展形被接受、6 字段被拒）', async () => {
    // CF 官方方言的扩展形 `LW`（当月最后一个工作日）：SDK 不做任何改写，平台解析器认它。
    const extended = await client.syncManifest([
      { name: 'monthly-report', cron: '0 9 LW * *', timezone: 'Asia/Shanghai' },
    ])
    expect(extended.created).toContain('monthly-report')
    expect(extended.jobs.find((job) => job.name === 'monthly-report')?.cron).toBe('0 9 LW * *')

    // 6 字段（带秒）不是 CF 方言：平台的冻结错误码原样透出。
    await expect(
      client.syncManifest([{ name: 'bad', cron: '0 0 3 * * *' }]),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_cron' })

    await client.syncManifest([])
  })

  it('错误映射：令牌不对 → 401 unauthorized（契约错误码，不看文案）', async () => {
    const { url } = await ctx.harness.listen()
    const badClient = createWakerClient({ baseUrl: url.href, token: 'not-a-real-token' })
    const error = await badClient.whoami().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WakerApiError)
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('平台不可达时如实失败（不吞错、不假装成功）', async () => {
    const deadClient = createWakerClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'whatever',
      timeoutMs: 2000,
    })
    await expect(deadClient.whoami()).rejects.toThrow()
  })
})

describe('D1 幂等账本（SQL 路径）', () => {
  /** 极简 D1 替身：只记录 SQL 并回放固定结果，用来断言适配器的判定逻辑。 */
  function fakeD1(responses: { run: number[]; row: Record<string, unknown> | null }) {
    const statements: { sql: string; values: unknown[] }[] = []
    let runIndex = 0
    return {
      statements,
      prepare(sql: string) {
        const entry = { sql, values: [] as unknown[] }
        statements.push(entry)
        const statement = {
          bind(...values: unknown[]) {
            entry.values = values
            return statement
          },
          async run() {
            const changes = responses.run[runIndex] ?? 0
            runIndex += 1
            return { success: true, meta: { changes } }
          },
          async first<T = unknown>() {
            return responses.row as T | null
          },
        }
        return statement
      },
    }
  }

  it('认领用 INSERT … ON CONFLICT DO NOTHING，changes=0 视为重复投递', async () => {
    const db = fakeD1({
      run: [0],
      row: {
        execution_id: 'e1',
        job_id: 'j1',
        job_name: 'daily-cleanup',
        scheduled_for: 1,
        status: 'succeeded',
        response_json: '{"ok":true,"nextRunAt":99}',
        claimed_at: 1,
        completed_at: 2,
      },
    })
    const ledger = createD1ExecutionLedger(db)
    const claim = await ledger.claim({
      executionId: 'e1',
      jobId: 'j1',
      jobName: 'daily-cleanup',
      scheduledFor: 1,
    })

    expect(claim.claimed).toBe(false)
    expect(claim.existing?.response).toEqual({ ok: true, nextRunAt: 99 })
    expect(db.statements[0]?.sql).toContain('ON CONFLICT(execution_id) DO NOTHING')
    expect(db.statements[0]?.values).toEqual(['e1', 'j1', 'daily-cleanup', 1, expect.any(Number)])

    // changes=1 → 本次真的认领到
    const freshDb = fakeD1({ run: [1], row: null })
    const fresh = await createD1ExecutionLedger(freshDb).claim({
      executionId: 'e2',
      jobId: 'j1',
      jobName: 'daily-cleanup',
      scheduledFor: 1,
    })
    expect(fresh.claimed).toBe(true)
    expect(fresh.existing).toBeNull()
  })

  it('complete / release 只动自己那一行', async () => {
    const db = fakeD1({ run: [1, 1], row: null })
    const ledger = createD1ExecutionLedger(db)
    await ledger.claim({ executionId: 'e1', jobId: 'j1', jobName: 'daily-cleanup', scheduledFor: 1 })
    await ledger.complete('e1', { ok: true })
    await ledger.release('e1')

    expect(db.statements[1]?.sql).toContain("SET status = 'succeeded'")
    expect(db.statements[2]?.sql).toContain("status = 'claimed'")
  })
})
