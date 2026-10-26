import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  DeadLetterView,
  ExecutionView,
  ListDeadLettersResult,
  ListExecutionsResult,
  ReplayDeadLetterResult,
} from '../src/do/types'
import {
  createJob,
  http,
  managementToken,
  seedProject,
  startDownstream,
  startHarness,
  unwrapResult,
  waitFor,
  type Downstream,
  type TestContext,
} from './support/harness'

/**
 * B7 集成测试：三条管理面 HTTP 薄映射，**全走真 workerd 的 HTTP 入口**
 * （真 DO / 真 SQLite / 真 Queue / 真鉴权中间件，不 mock 内部任何一环）。
 *
 *   GET  /api/executions                        → `{ executions, nextCursor }`
 *   GET  /api/dead-letters                      → `{ deadLetters, nextCursor }`
 *   POST /api/dead-letters/{id}/replay          → 202 `ReplayDeadLetterResult`
 *
 * 语义（筛选 / 排序 / 游标 / 校验）已由 B6、B3 各自冻结，本单只验「HTTP 面把契约原样端出来」：
 * 成功路径看应答形状与业务事实，负路径看状态码 + 冻结错误码（不解析文案）。
 */

interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

let ctx: TestContext
let token: string

beforeAll(async () => {
  ctx = await startHarness()
  token = await managementToken(ctx)
})

afterAll(async () => {
  await ctx.harness.close()
})

interface SeedExecutionOptions {
  id: string
  jobId: string
  projectId: string
  scheduledFor: number
  status?: string
  trigger?: 'schedule' | 'manual'
  createdAt?: number
  finishedAt?: number | null
  durationMs?: number | null
  responseStatus?: number | null
}

/** 直接落一条执行记录（列与 B3 写入形态一致，跳过调度器让数据确定）。 */
async function seedExecution(options: SeedExecutionOptions): Promise<void> {
  await ctx.sql.exec(
    `INSERT INTO executions (
       id, job_id, project_id, scheduled_for, dispatch_at, trigger, misfire, status,
       attempt, started_at, finished_at, duration_ms, response_status, error, created_at,
       renewal_at, renewal_error
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, ?, ?, ?, NULL, ?, NULL, NULL)`,
    options.id,
    options.jobId,
    options.projectId,
    options.scheduledFor,
    options.scheduledFor,
    options.trigger ?? 'schedule',
    options.status ?? 'succeeded',
    options.finishedAt ?? null,
    options.durationMs ?? null,
    options.responseStatus ?? null,
    options.createdAt ?? options.scheduledFor,
  )
}

interface SeedDeadLetterOptions {
  id: string
  executionId: string
  jobId: string
  projectId: string
  createdAt: number
  attempts?: number
  error?: string
  replayedAt?: number | null
  replayedExecutionId?: string | null
  payload?: string
}

/** 直接落一条死信（B3 写入形态）。 */
async function seedDeadLetter(options: SeedDeadLetterOptions): Promise<void> {
  await ctx.sql.exec(
    `INSERT INTO dead_letters (
       id, execution_id, job_id, project_id, attempts, error, payload, created_at,
       replayed_at, replayed_execution_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    options.id,
    options.executionId,
    options.jobId,
    options.projectId,
    options.attempts ?? 1,
    options.error ?? 'boom',
    options.payload ?? 'null',
    options.createdAt,
    options.replayedAt ?? null,
    options.replayedExecutionId ?? null,
  )
}

/** 一个暂停任务（enabled: false → 不进调度，测试数据保持确定）。 */
async function seedJob(projectId: string, name: string): Promise<string> {
  const job = unwrapResult(
    await ctx.stub.createJob({ projectId, name, kind: 'cron', cron: '0 3 * * *', enabled: false }),
  )
  return job.id
}

/** 打一次 HTTP，断言状态码并返回解析后的 body（失败时把 body 打进断言消息）。 */
async function call<T>(path: string, init: Parameters<typeof http>[2] = {}): Promise<{ status: number; body: T }> {
  const response = await http<T>(ctx, path, { token, ...init })
  return response
}

async function expectApiError(
  path: string,
  status: number,
  code: string,
  init: Parameters<typeof http>[2] = {},
): Promise<void> {
  const response = await call<ErrorBody>(path, init)
  expect(response.status, `${path} → ${JSON.stringify(response.body)}`).toBe(status)
  expect(response.body.error.code, `${path} 的错误码`).toBe(code)
  expect(typeof response.body.error.message).toBe('string')
}

// ───────────────────────── GET /api/executions ─────────────────────────

describe('GET /api/executions', () => {
  it('应答形状与冻结契约逐字一致：{ executions, nextCursor }，带任务名、不含 payload / signingKeyId', async () => {
    const { projectId, projectName } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'exec-shape-secret',
    })
    const jobId = await seedJob(projectId, 'exec-shape-job')
    const base = 1_700_000_000_000

    await seedExecution({ id: 'shape-a', jobId, projectId, scheduledFor: base, finishedAt: base + 40, durationMs: 40, responseStatus: 200 })
    await seedExecution({ id: 'shape-c', jobId, projectId, scheduledFor: base + 60_000, trigger: 'manual' })
    await seedExecution({ id: 'shape-b', jobId, projectId, scheduledFor: base + 60_000, status: 'failed' })

    const response = await call<ListExecutionsResult>(`/api/executions?projectId=${projectId}`)
    expect(response.status).toBe(200)

    // 顶层只有契约里的两个字段（没有 `{ data }` 一类包装）。
    expect(Object.keys(response.body).sort()).toEqual(['executions', 'nextCursor'])
    expect(response.body.nextCursor).toBeNull()

    // 排序定死：scheduledFor DESC, id DESC。
    expect(response.body.executions.map((execution) => execution.id)).toEqual([
      'shape-c',
      'shape-b',
      'shape-a',
    ])

    const oldest = response.body.executions[2] as ExecutionView
    expect(oldest.jobId).toBe(jobId)
    expect(oldest.jobName).toBe('exec-shape-job')
    expect(oldest.projectId).toBe(projectId)
    expect(oldest.status).toBe('succeeded')
    expect(oldest.durationMs).toBe(40)
    expect(oldest.responseStatus).toBe(200)
    // 列表刻意不带 payload / signingKeyId（B6 契约，前端也不展示）。
    expect(oldest).not.toHaveProperty('payload')
    expect(oldest).not.toHaveProperty('signingKeyId')

    // 项目名在库里（避免 seedProject 返回值被误当成执行记录字段用）。
    const projectRows = await ctx.sql.exec('SELECT name FROM projects WHERE id = ?', projectId)
    expect(projectRows[0]?.name).toBe(projectName)
  })

  it('筛选参数（jobId / status / trigger）原样下推给 B6 RPC', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'exec-filter-secret',
    })
    const jobA = await seedJob(projectId, 'filter-job-a')
    const jobB = await seedJob(projectId, 'filter-job-b')
    const base = 1_700_100_000_000

    await seedExecution({ id: 'f-a-sched', jobId: jobA, projectId, scheduledFor: base })
    await seedExecution({ id: 'f-a-manual', jobId: jobA, projectId, scheduledFor: base + 1, trigger: 'manual' })
    await seedExecution({ id: 'f-a-failed', jobId: jobA, projectId, scheduledFor: base + 2, status: 'failed' })
    await seedExecution({ id: 'f-b', jobId: jobB, projectId, scheduledFor: base + 3 })

    const byJob = await call<ListExecutionsResult>(`/api/executions?jobId=${jobA}`)
    expect(byJob.status).toBe(200)
    expect(byJob.body.executions.map((item) => item.id).sort()).toEqual([
      'f-a-failed',
      'f-a-manual',
      'f-a-sched',
    ])

    const byJobAndStatus = await call<ListExecutionsResult>(
      `/api/executions?jobId=${jobA}&status=failed`,
    )
    expect(byJobAndStatus.status).toBe(200)
    expect(byJobAndStatus.body.executions.map((item) => item.id)).toEqual(['f-a-failed'])

    const byTrigger = await call<ListExecutionsResult>(
      `/api/executions?projectId=${projectId}&trigger=manual`,
    )
    expect(byTrigger.status).toBe(200)
    expect(byTrigger.body.executions.map((item) => item.id)).toEqual(['f-a-manual'])
  })

  it('半开区间 [from, to) + limit / cursor keyset 翻页：不重不漏，nextCursor 原样回传', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'exec-page-secret',
    })
    const jobId = await seedJob(projectId, 'page-job')
    const base = 1_700_200_000_000

    await seedExecution({ id: 'p-1', jobId, projectId, scheduledFor: base })
    await seedExecution({ id: 'p-2', jobId, projectId, scheduledFor: base + 1_000 })
    await seedExecution({ id: 'p-3', jobId, projectId, scheduledFor: base + 2_000 })
    // 正好落在区间上界 → 半开区间不该返回它。
    await seedExecution({ id: 'p-upper', jobId, projectId, scheduledFor: base + 3_000 })

    const first = await call<ListExecutionsResult>(
      `/api/executions?projectId=${projectId}&scheduledFrom=${base}&scheduledTo=${base + 3_000}&limit=2`,
    )
    expect(first.status).toBe(200)
    expect(first.body.executions.map((item) => item.id)).toEqual(['p-3', 'p-2'])
    expect(first.body.nextCursor).toBeTruthy()

    const second = await call<ListExecutionsResult>(
      `/api/executions?projectId=${projectId}&scheduledFrom=${base}&scheduledTo=${base + 3_000}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    )
    expect(second.status).toBe(200)
    expect(second.body.executions.map((item) => item.id)).toEqual(['p-1'])
    expect(second.body.nextCursor).toBeNull()
  })

  it('非法参数一律 400 invalid_argument（区间倒置 / 非法枚举 / 非法 limit / 非法 cursor）', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'exec-invalid-secret',
    })

    await expectApiError('/api/executions?scheduledFrom=2000&scheduledTo=1000', 400, 'invalid_argument')
    await expectApiError('/api/executions?status=bogus', 400, 'invalid_argument')
    await expectApiError('/api/executions?trigger=bogus', 400, 'invalid_argument')
    await expectApiError('/api/executions?limit=0', 400, 'invalid_argument')
    await expectApiError('/api/executions?limit=abc', 400, 'invalid_argument')
    await expectApiError('/api/executions?scheduledFrom=abc', 400, 'invalid_argument')
    await expectApiError('/api/executions?cursor=not-a-cursor', 400, 'invalid_argument')
    // 跨接口游标（死信游标喂给执行记录）也当场拒绝，而不是静默返回乱序页。
    await expectApiError('/api/executions?cursor=d1%7Cp%7C1%7Cx', 400, 'invalid_argument')

    // 空结果不等于错误：同一个区间端点（相等）是合法的空区间。
    const empty = await call<ListExecutionsResult>(
      `/api/executions?projectId=${projectId}&scheduledFrom=1000&scheduledTo=1000`,
    )
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ executions: [], nextCursor: null })
  })
})

// ───────────────────────── GET /api/dead-letters ─────────────────────────

describe('GET /api/dead-letters', () => {
  it('应答形状 { deadLetters, nextCursor }，排序「未重放优先 → createdAt DESC → id DESC」', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'dl-shape-secret',
    })
    const jobId = await seedJob(projectId, 'dl-shape-job')
    const base = 1_700_300_000_000

    await seedDeadLetter({ id: 'dl-pending-old', executionId: 'dl-ex-1', jobId, projectId, createdAt: base, payload: '{"k":1}' })
    await seedDeadLetter({ id: 'dl-pending-new', executionId: 'dl-ex-2', jobId, projectId, createdAt: base + 10, attempts: 3, error: 'HTTP 503' })
    await seedDeadLetter({
      id: 'dl-replayed',
      executionId: 'dl-ex-3',
      jobId,
      projectId,
      createdAt: base + 20,
      replayedAt: base + 30,
      replayedExecutionId: 'dl-ex-replayed',
    })

    const response = await call<ListDeadLettersResult>(`/api/dead-letters?projectId=${projectId}`)
    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual(['deadLetters', 'nextCursor'])
    expect(response.body.nextCursor).toBeNull()
    expect(response.body.deadLetters.map((item) => item.id)).toEqual([
      'dl-pending-new',
      'dl-pending-old',
      'dl-replayed',
    ])

    const newest = response.body.deadLetters[0] as DeadLetterView
    expect(newest.jobId).toBe(jobId)
    expect(newest.attempts).toBe(3)
    expect(newest.error).toBe('HTTP 503')
    expect(newest.replayedAt).toBeNull()
    // 死信条目复用 B3 DeadLetterView：payload 是重放详情要展示的，必须在。
    expect(response.body.deadLetters[1]).toHaveProperty('payload')
    expect(response.body.deadLetters[1]?.payload).toEqual({ k: 1 })
    expect(response.body.deadLetters[2]?.replayedExecutionId).toBe('dl-ex-replayed')
  })

  it('replayState / createdFrom~createdTo 筛选 + limit / cursor 翻页', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: 'https://downstream.example.com',
      secret: 'dl-filter-secret',
    })
    const jobId = await seedJob(projectId, 'dl-filter-job')
    const base = 1_700_400_000_000

    await seedDeadLetter({ id: 'df-1', executionId: 'df-ex-1', jobId, projectId, createdAt: base })
    await seedDeadLetter({ id: 'df-2', executionId: 'df-ex-2', jobId, projectId, createdAt: base + 10 })
    await seedDeadLetter({ id: 'df-3', executionId: 'df-ex-3', jobId, projectId, createdAt: base + 20 })
    await seedDeadLetter({
      id: 'df-replayed',
      executionId: 'df-ex-4',
      jobId,
      projectId,
      createdAt: base + 30,
      replayedAt: base + 40,
      replayedExecutionId: 'df-ex-new',
    })
    // 区间外（正好落在上界）→ 半开区间不该返回它。
    await seedDeadLetter({ id: 'df-upper', executionId: 'df-ex-5', jobId, projectId, createdAt: base + 30 })

    const all = await call<ListDeadLettersResult>(`/api/dead-letters?jobId=${jobId}`)
    expect(all.body.deadLetters.map((item) => item.id)).toEqual(['df-upper', 'df-3', 'df-2', 'df-1', 'df-replayed'])

    const replayed = await call<ListDeadLettersResult>(
      `/api/dead-letters?jobId=${jobId}&replayState=replayed`,
    )
    expect(replayed.status).toBe(200)
    expect(replayed.body.deadLetters.map((item) => item.id)).toEqual(['df-replayed'])

    const pendingInRange = await call<ListDeadLettersResult>(
      `/api/dead-letters?jobId=${jobId}&replayState=pending&createdFrom=${base}&createdTo=${base + 30}`,
    )
    expect(pendingInRange.status).toBe(200)
    expect(pendingInRange.body.deadLetters.map((item) => item.id)).toEqual(['df-3', 'df-2', 'df-1'])

    const firstPage = await call<ListDeadLettersResult>(
      `/api/dead-letters?jobId=${jobId}&createdFrom=${base}&createdTo=${base + 30}&limit=2`,
    )
    expect(firstPage.status).toBe(200)
    expect(firstPage.body.deadLetters.map((item) => item.id)).toEqual(['df-3', 'df-2'])
    expect(firstPage.body.nextCursor).toBeTruthy()

    const secondPage = await call<ListDeadLettersResult>(
      `/api/dead-letters?jobId=${jobId}&createdFrom=${base}&createdTo=${base + 30}&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor as string)}`,
    )
    expect(secondPage.status).toBe(200)
    expect(secondPage.body.deadLetters.map((item) => item.id)).toEqual(['df-1'])
    expect(secondPage.body.nextCursor).toBeNull()
  })

  it('非法参数一律 400 invalid_argument（区间倒置 / 非法 replayState / 非法 limit / 非法 cursor）', async () => {
    await expectApiError('/api/dead-letters?createdFrom=2000&createdTo=1000', 400, 'invalid_argument')
    await expectApiError('/api/dead-letters?replayState=bogus', 400, 'invalid_argument')
    await expectApiError('/api/dead-letters?limit=0', 400, 'invalid_argument')
    await expectApiError('/api/dead-letters?limit=abc', 400, 'invalid_argument')
    await expectApiError('/api/dead-letters?createdTo=abc', 400, 'invalid_argument')
    await expectApiError('/api/dead-letters?cursor=not-a-cursor', 400, 'invalid_argument')
    // 跨接口游标（执行记录游标喂给死信）同样拒绝。
    await expectApiError('/api/dead-letters?cursor=e1%7C1%7Cex-1', 400, 'invalid_argument')
  })
})

// ───────────────────── POST /api/dead-letters/{id}/replay ─────────────────────

describe('POST /api/dead-letters/{id}/replay', () => {
  let downstream: Downstream

  beforeAll(async () => {
    downstream = await startDownstream('replay-http-secret')
  })

  afterAll(async () => {
    await downstream.close()
  })

  it('202 + ReplayDeadLetterResult：新建 manual 执行并标记死信已重放', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: downstream.url,
      secret: 'replay-http-secret',
    })
    const job = await createJob(ctx, { projectId, kind: 'cron', cron: '0 3 * * *' })
    const { executionId } = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const createdAt = Date.now()
    await seedDeadLetter({
      id: 'replay-ok',
      executionId,
      jobId: job.id,
      projectId,
      createdAt,
      payload: '{"hello":"replay"}',
    })

    // 空 body（前端就是不带 body 的 POST）。
    const response = await call<ReplayDeadLetterResult>(
      `/api/dead-letters/${encodeURIComponent('replay-ok')}/replay`,
      { method: 'POST' },
    )
    expect(response.status, JSON.stringify(response.body)).toBe(202)

    const result = response.body
    expect(Object.keys(result).sort()).toEqual([
      'deadLetterId',
      'dispatchAt',
      'executionId',
      'jobId',
      'scheduledFor',
    ])
    expect(result.deadLetterId).toBe('replay-ok')
    expect(result.jobId).toBe(job.id)
    expect(result.executionId).not.toBe(executionId)
    expect(result.dispatchAt).toBeGreaterThanOrEqual(result.scheduledFor)

    // 库里的真实形态：新执行是 manual，死信被标记重放并指向新执行。
    const executionRows = await ctx.sql.exec(
      'SELECT * FROM executions WHERE id = ?',
      result.executionId,
    )
    expect(executionRows).toHaveLength(1)
    expect(executionRows[0]?.trigger).toBe('manual')
    expect(executionRows[0]?.job_id).toBe(job.id)

    const deadLetterRows = await ctx.sql.exec(
      'SELECT * FROM dead_letters WHERE id = ?',
      'replay-ok',
    )
    expect(deadLetterRows[0]?.replayed_at).not.toBeNull()
    expect(deadLetterRows[0]?.replayed_execution_id).toBe(result.executionId)

    // 再次走 HTTP 查列表：重放状态与留痕从同一契约读得到。
    const replayed = await call<ListDeadLettersResult>(
      `/api/dead-letters?jobId=${job.id}&replayState=replayed`,
    )
    expect(replayed.status).toBe(200)
    expect(replayed.body.deadLetters.map((item) => item.id)).toEqual(['replay-ok'])

    // 重放确实走了 Queue → 下游回调（payload 沿用死信里的那份，签名可验）。
    const callback = await waitFor(
      () => downstream.requestsFor({ executionId: result.executionId })[0],
      { label: '重放回调', timeoutMs: 20_000 },
    )
    expect(callback.signature.ok, JSON.stringify(callback.signature)).toBe(true)
    expect(callback.parsed.payload).toEqual({ hello: 'replay' })
  })

  it('死信不存在 → 404 dead_letter_not_found', async () => {
    await expectApiError('/api/dead-letters/nope/replay', 404, 'dead_letter_not_found', {
      method: 'POST',
    })
  })

  it('任务已取消 → 409 job_cancelled', async () => {
    const { projectId } = await seedProject(ctx, {
      callbackUrl: downstream.url,
      secret: 'replay-http-secret',
    })
    const job = await createJob(ctx, { projectId, kind: 'cron', cron: '0 3 * * *' })
    const { executionId } = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    await seedDeadLetter({
      id: 'replay-cancelled',
      executionId,
      jobId: job.id,
      projectId,
      createdAt: Date.now(),
    })
    unwrapResult(await ctx.stub.cancelJob({ jobId: job.id }))

    await expectApiError('/api/dead-letters/replay-cancelled/replay', 409, 'job_cancelled', {
      method: 'POST',
    })
  })

  it('三条路由都要求会话令牌（无令牌 → 401，不再是 501 占位）', async () => {
    for (const [path, init] of [
      ['/api/executions', {}],
      ['/api/dead-letters', {}],
      ['/api/dead-letters/whatever/replay', { method: 'POST' }],
    ] as const) {
      const response = await http<ErrorBody>(ctx, path, init)
      expect(response.status, path).toBe(401)
      expect(response.body.error.code).toBe('unauthorized')
    }
  })
})
