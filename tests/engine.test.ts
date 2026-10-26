import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MAX_SELF_RENEWAL_HORIZON_MS } from '../src/callback/protocol'
import {
  createJob,
  executionRows,
  jobRow,
  seedExecution,
  seedProject,
  startDownstream,
  startHarness,
  unwrapResult,
  waitFor,
  type Downstream,
  type DownstreamHandler,
  type TestContext,
} from './support/harness'

/**
 * 执行引擎集成测试：**全链路真跑**。
 *
 * 真 workerd + 真 WakerDO(SQLite) + 真 Queue（主队列与 DLQ）+ 真 queue consumer +
 * 真 HTTP 下游（127.0.0.1 上真监听的服务）——平台内部零 mock。
 * 下游侧用项目 signing key **独立验签**，所以「签名可用」是被第三方视角证明过的。
 */

let ctx: TestContext
let downstream: Downstream
const SECRET = 'unit-test-signing-secret-b3'

const okHandler: DownstreamHandler = (request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, echo: request.parsed.executionId }))
}

beforeAll(async () => {
  ctx = await startHarness()
  downstream = await startDownstream(SECRET)
})

beforeEach(() => {
  downstream.setHandler(okHandler)
})

afterAll(async () => {
  await downstream?.close()
  await ctx?.harness.close()
})

async function project(): Promise<{ projectId: string }> {
  return seedProject(ctx, { callbackUrl: downstream.url, secret: SECRET })
}

describe('正常执行', () => {
  it('同步回调下游 → 2xx → 执行记录 succeeded（签名在下游侧验签通过）', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      payload: { letter: 'hello' },
      policies: { timeoutSeconds: 5 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    const request = await waitFor(
      () => downstream.requestsFor({ executionId: trigger.executionId })[0],
      { label: '下游收到回调' },
    )

    // 协议 v2：路径 / 请求体 / 头 / 签名全部按冻结契约。
    expect(request.url).toBe('/_waker/execute')
    expect(request.signature).toEqual({ ok: true })
    expect(request.headers['x-waker-protocol-version']).toBe('2')
    expect(request.headers['x-waker-attempt']).toBe('0')
    expect(request.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(request.parsed).toMatchObject({
      protocolVersion: 2,
      executionId: trigger.executionId,
      jobId: job.id,
      projectId,
      jobName: job.name,
      kind: 'cron',
      trigger: 'manual',
      misfire: false,
      attempt: 0,
      timeoutSeconds: 5,
      payload: { letter: 'hello' },
    })
    expect(request.parsed.scheduledFor).toBe(trigger.scheduledFor)
    expect(request.parsed.dispatchedAt).toBeGreaterThanOrEqual(trigger.dispatchAt)

    const row = await waitFor(async () => {
      const rows = await executionRows(ctx, job.id)
      return rows.find((item) => item.id === trigger.executionId && item.status === 'succeeded')
    })
    expect(row.attempt).toBe(0)
    expect(row.response_status).toBe(200)
    expect(row.error).toBeNull()
    // cron 任务不参与自续：下游没带 nextRunAt，也不会被当作续期。
    expect(row.renewal_at).toBeNull()
    expect(row.renewal_error).toBeNull()
  })

  /**
   * 并发策略是**认领期**判定（`prepareExecution`），不依赖两个 consumer 真的并行跑：
   * 这里的执行记录直接落库，两次认领都在 DO 里原子完成，断言因此是确定性的。
   * （真 Queue 的串行消费在集成测试里另有覆盖，见「正常执行」第一条。）
   */
  it('manualTrigger 的 payload 覆盖随本次执行下发（不串用任务默认载荷）', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      payload: { default: true },
    })

    const trigger = unwrapResult(
      await ctx.stub.manualTrigger({ jobId: job.id, payload: { override: 'this-run' } }),
    )

    const request = await waitFor(
      () => downstream.requestsFor({ executionId: trigger.executionId })[0],
      { label: '下游收到回调' },
    )
    expect(request.parsed.payload).toEqual({ override: 'this-run' })

    // 下一条执行（不带覆盖）仍用任务默认载荷。
    const second = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const secondRequest = await waitFor(
      () => downstream.requestsFor({ executionId: second.executionId })[0],
      { label: '第二次回调到达' },
    )
    expect(secondRequest.parsed.payload).toEqual({ default: true })
  })

  it('执行前判断 concurrencyPolicy：forbid 时第二条执行记 skipped 且不打下游', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { concurrency: 'forbid', timeoutSeconds: 10 },
    })

    const now = Date.now()
    const first = await seedExecution(ctx, { jobId: job.id, projectId, scheduledFor: now })
    const second = await seedExecution(ctx, { jobId: job.id, projectId, scheduledFor: now })

    const claimed = unwrapResult(await ctx.engine.prepareExecution({ executionId: first, attempt: 0 }))
    expect(claimed.outcome).toBe('run')

    const blocked = unwrapResult(
      await ctx.engine.prepareExecution({ executionId: second, attempt: 0 }),
    )
    expect(blocked.outcome).toBe('skip')
    expect(blocked.reason).toBe('concurrency_policy_forbid')

    const rows = await executionRows(ctx, job.id)
    const skippedRow = rows.find((row) => row.id === second)
    expect(skippedRow?.status).toBe('skipped')
    expect(skippedRow?.skip_reason).toBe('concurrency_policy_forbid')
    // 被跳过的那次绝不能打下游。
    expect(downstream.requestsFor({ jobId: job.id })).toHaveLength(0)

    // 收尾：第一条记成功，避免残留 running 记录。
    unwrapResult(
      await ctx.engine.recordExecutionResult({
        executionId: first,
        attempt: 0,
        ok: true,
        httpStatus: 200,
        startedAt: now,
        finishedAt: now,
        durationMs: 1,
      }),
    )
  })

  it('concurrencyPolicy: allow 时两条执行都放行并各自成功', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { concurrency: 'allow', timeoutSeconds: 10 },
    })

    const now = Date.now()
    const first = await seedExecution(ctx, { jobId: job.id, projectId, scheduledFor: now })
    const second = await seedExecution(ctx, { jobId: job.id, projectId, scheduledFor: now })

    expect(
      unwrapResult(await ctx.engine.prepareExecution({ executionId: first, attempt: 0 })).outcome,
    ).toBe('run')
    expect(
      unwrapResult(await ctx.engine.prepareExecution({ executionId: second, attempt: 0 })).outcome,
    ).toBe('run')

    for (const executionId of [first, second]) {
      const recorded = unwrapResult(
        await ctx.engine.recordExecutionResult({
          executionId,
          attempt: 0,
          ok: true,
          httpStatus: 200,
          startedAt: now,
          finishedAt: now,
          durationMs: 1,
        }),
      )
      expect(recorded.status).toBe('succeeded')
    }

    const rows = await executionRows(ctx, job.id)
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(2)
  })
})

describe('分发与抖动（Queue delaySeconds）', () => {
  it('按 dispatchAt 折算 Queue delaySeconds：抖动之后才真正回调下游', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, { projectId, kind: 'cron', cron: '0 3 * * *' })

    // 直接落一条「待投递」的执行，distpatchAt = 现在 + 1.5s（模拟抖动把同分钟任务打散）。
    const now = Date.now()
    const dispatchAt = now + 1500
    const executionId = crypto.randomUUID()
    await ctx.sql.exec(
      `INSERT INTO executions (
         id, job_id, project_id, scheduled_for, dispatch_at, trigger, misfire, status, attempt, created_at
       ) VALUES (?, ?, ?, ?, ?, 'schedule', 0, 'pending', 0, ?)`,
      executionId,
      job.id,
      projectId,
      now,
      dispatchAt,
      now,
    )

    // watchdog 的 syncAlarm 会扫出 pending 执行并投递（同时也是「崩溃后补投」的自愈路径）。
    unwrapResult(await ctx.stub.syncAlarm())

    const dispatched = (await executionRows(ctx, job.id)).find((row) => row.id === executionId)
    expect(dispatched?.status).toBe('dispatched')

    const request = await waitFor(
      () => downstream.requestsFor({ executionId })[0],
      { label: '延迟后才回调', timeoutMs: 20_000 },
    )
    // Queue 原生 delaySeconds 生效：回调时刻不早于 dispatchAt（留 100ms 容差给时钟粒度）。
    expect(request.receivedAt - now).toBeGreaterThanOrEqual(1400)
  })
})

describe('失败路径：重试 → DLQ → 死信表 → 重放', () => {
  it('非 2xx 按 maxRetries 重试，用尽后进 DLQ 并转存死信表，可重放', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('downstream unavailable')
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      // backoff 0 = 立即重试，测试跑得快；退避折算另有单测钉死。
      policies: { maxRetries: 2, backoffSeconds: 0, timeoutSeconds: 5 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    const dead = await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'dead'),
      { label: '执行判死', timeoutMs: 20_000 },
    )
    expect(dead.attempt).toBe(2)
    expect(String(dead.error)).toContain('HTTP 503')

    // 首次 + 2 次重试 = 下游一共被打 3 次，且 attempt 递增。
    const attempts = downstream
      .requestsFor({ executionId: trigger.executionId })
      .map((request) => request.parsed.attempt)
    expect(attempts).toEqual([0, 1, 2])

    // DLQ consumer 把消息转存进了 dead_letters。
    const deadLetter = await waitFor(
      async () =>
        (
          await ctx.sql.exec('SELECT * FROM dead_letters WHERE execution_id = ?', trigger.executionId)
        )[0],
      { label: '死信落库' },
    )
    expect(deadLetter.job_id).toBe(job.id)
    expect(deadLetter.project_id).toBe(projectId)
    expect(Number(deadLetter.attempts)).toBe(3)
    expect(String(deadLetter.error)).toContain('HTTP 503')
    expect(deadLetter.replayed_at).toBeNull()

    // 重放：下游恢复正常 → 新建一条 manual 执行并成功。
    downstream.setHandler(okHandler)
    const replay = unwrapResult(
      await ctx.engine.replayDeadLetter({ deadLetterId: String(deadLetter.id) }),
    )
    expect(replay.jobId).toBe(job.id)

    const replayed = await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === replay.executionId && row.status === 'succeeded'),
      { label: '重放执行成功' },
    )
    expect(replayed.trigger).toBe('manual')
    expect(downstream.requestsFor({ executionId: replay.executionId })).toHaveLength(1)

    const replayedDeadLetter = (
      await ctx.sql.exec('SELECT * FROM dead_letters WHERE execution_id = ?', trigger.executionId)
    )[0]
    expect(String(replayedDeadLetter!.replayed_execution_id)).toBe(replay.executionId)
    expect(replayedDeadLetter!.replayed_at).not.toBeNull()
  })

  it('重试等待按 backoffSeconds 经 Queue delaySeconds 生效（不是立即重打）', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(500)
      response.end('boom')
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { maxRetries: 1, backoffSeconds: 1, timeoutSeconds: 5 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    await waitFor(
      () => (downstream.requestsFor({ executionId: trigger.executionId }).length === 2 ? true : null),
      { label: '两次投递', timeoutMs: 20_000 },
    )

    const [first, second] = downstream.requestsFor({ executionId: trigger.executionId })
    expect(first!.parsed.attempt).toBe(0)
    expect(second!.parsed.attempt).toBe(1)
    // backoff = 1s → 第二次投递至少晚约 1 秒（留 100ms 容差）。
    expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(900)
  })

  it('下游超时（timeoutSeconds）按失败处理并进死信', async () => {
    const { projectId } = await project()
    downstream.setHandler(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      response.writeHead(200)
      response.end('{"ok":true}')
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { maxRetries: 0, timeoutSeconds: 1 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    const dead = await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'dead'),
      { label: '超时判死', timeoutMs: 20_000 },
    )
    expect(dead.error).toBe('timeout')
    expect(dead.response_status).toBeNull()
  })
})

describe('自续协议（one-shot）', () => {
  it('响应携带合法 nextRunAt → 同一 job 系列续期（run_at/next_run_at/status 全部推进）', async () => {
    const { projectId } = await project()
    const nextRunAt = Date.now() + 3_600_000
    downstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, nextRunAt }))
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'one_shot',
      runAt: Date.now() + 600_000,
      policies: { timeoutSeconds: 5 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'succeeded'),
      { label: '执行成功' },
    )

    const row = await waitFor(
      async () => (await executionRows(ctx, job.id)).find((item) => item.id === trigger.executionId && item.renewal_at !== null),
      { label: '续期落库' },
    )
    expect(Number(row.renewal_at)).toBe(nextRunAt)
    expect(row.renewal_error).toBeNull()

    const renewed = await waitFor(async () => {
      const current = await jobRow(ctx, job.id)
      return current.next_run_at === nextRunAt ? current : null
    })
    expect(renewed.run_at).toBe(nextRunAt)
    expect(renewed.status).toBe('active')
    // 同一个 job 系列：id 不变。
    expect(renewed.id).toBe(job.id)
  })

  it('不带 nextRunAt → 任务完结，不产生续期', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(204)
      response.end()
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'one_shot',
      runAt: Date.now() + 600_000,
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const row = await waitFor(
      async () => (await executionRows(ctx, job.id)).find((item) => item.id === trigger.executionId && item.status === 'succeeded'),
      { label: '执行成功' },
    )
    expect(row.renewal_at).toBeNull()
    expect(row.renewal_error).toBeNull()
  })

  it('nextRunAt 早于本次执行时刻 → 拒绝续期（执行仍算成功）', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ nextRunAt: Date.now() - 1000 }))
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'one_shot',
      runAt: Date.now() + 600_000,
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const row = await waitFor(
      async () =>
        (await executionRows(ctx, job.id)).find(
          (item) => item.id === trigger.executionId && item.renewal_error !== null,
        ),
      { label: '续期被拒' },
    )
    expect(row.status).toBe('succeeded')
    expect(row.renewal_error).toBe('next_run_at_not_future')
    expect(row.renewal_at).toBeNull()

    const unchanged = await jobRow(ctx, job.id)
    expect(unchanged.next_run_at).toBe(job.runAt)
  })

  it('nextRunAt 超出 366 天上限 → 拒绝续期（防失控）', async () => {
    const { projectId } = await project()
    const tooFar = Date.now() + MAX_SELF_RENEWAL_HORIZON_MS + 86_400_000
    downstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ nextRunAt: tooFar }))
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'one_shot',
      runAt: Date.now() + 600_000,
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const row = await waitFor(
      async () =>
        (await executionRows(ctx, job.id)).find(
          (item) => item.id === trigger.executionId && item.renewal_error !== null,
        ),
      { label: '续期被拒' },
    )
    expect(row.renewal_error).toBe('next_run_at_too_far')
    expect(row.status).toBe('succeeded')
  })

  it('非法 nextRunAt（不可解析）→ 拒绝续期且不影响成功判定', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ nextRunAt: 'not-a-timestamp' }))
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'one_shot',
      runAt: Date.now() + 600_000,
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const row = await waitFor(
      async () =>
        (await executionRows(ctx, job.id)).find(
          (item) => item.id === trigger.executionId && item.renewal_error !== null,
        ),
      { label: '续期被拒' },
    )
    expect(row.renewal_error).toBe('invalid_next_run_at')
    expect(row.status).toBe('succeeded')
  })

  it('cron 任务声明 nextRunAt 也不续期（自续只对 one-shot 生效）', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ nextRunAt: Date.now() + 3_600_000 }))
    })

    const job = await createJob(ctx, { projectId, kind: 'cron', cron: '0 3 * * *' })
    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    const row = await waitFor(
      async () =>
        (await executionRows(ctx, job.id)).find(
          (item) => item.id === trigger.executionId && item.status === 'succeeded',
        ),
      { label: '执行成功' },
    )
    expect(row.renewal_at).toBeNull()
    expect(row.renewal_error).toBe('job_not_self_renewable')
  })
})

describe('幂等与租约', () => {
  it('同一执行重复投递只打一次下游（第二次判 in_flight / already_handled）', async () => {
    const { projectId } = await project()
    let release: (() => void) | null = null
    downstream.setHandler(async (_request, response) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { timeoutSeconds: 10 },
    })

    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'running'),
      { label: '执行进入 running' },
    )

    // 重复投递：同一个 executionId + attempt → 平台必须拒绝二次执行。
    const duplicate = unwrapResult(
      await ctx.engine.prepareExecution({
        executionId: trigger.executionId,
        attempt: 0,
      }),
    )
    expect(duplicate.outcome).toBe('skip')
    expect(duplicate.reason).toBe('in_flight')

    await waitFor(() => (release === null ? null : true), { label: '下游请求到达' })
    release!()

    await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'succeeded'),
      { label: '执行成功' },
    )

    // 成功后再来一次更晚的投递：already_handled，绝不再打下游。
    const late = unwrapResult(
      await ctx.engine.prepareExecution({ executionId: trigger.executionId, attempt: 0 }),
    )
    expect(late.outcome).toBe('skip')
    expect(late.reason).toBe('already_handled')

    expect(downstream.requestsFor({ executionId: trigger.executionId })).toHaveLength(1)
  })

  it('过期 attempt 的消息被判 stale_attempt（不会用旧消息重跑）', async () => {
    const { projectId } = await project()
    const job = await createJob(ctx, { projectId, kind: 'cron', cron: '0 3 * * *' })
    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    await waitFor(
      async () => (await executionRows(ctx, job.id)).find((row) => row.id === trigger.executionId && row.status === 'succeeded'),
      { label: '执行成功' },
    )

    const stale = unwrapResult(
      await ctx.engine.prepareExecution({ executionId: trigger.executionId, attempt: 5 }),
    )
    expect(stale.outcome).toBe('skip')
    expect(stale.reason).toBe('stale_attempt')
  })

  it('缺 signing key / 缺 callback_url 的项目：执行直接判死进死信（不刷重试）', async () => {
    // 项目存在但没有 signing key 行。
    const now = Date.now()
    await ctx.sql.exec(
      `INSERT INTO projects (id, name, callback_url, status, created_at, updated_at)
       VALUES ('proj-no-key', '无签名密钥项目', ?, 'active', ?, ?)`,
      downstream.url,
      now,
      now,
    )
    const job = await createJob(ctx, { projectId: 'proj-no-key', kind: 'cron', cron: '0 3 * * *' })
    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))

    const deadLetter = await waitFor(
      async () =>
        (
          await ctx.sql.exec('SELECT * FROM dead_letters WHERE execution_id = ?', trigger.executionId)
        )[0],
      { label: '缺密钥进死信', timeoutMs: 20_000 },
    )
    expect(String(deadLetter.error)).toContain('signing_key_missing')

    const row = (await executionRows(ctx, job.id)).find((item) => item.id === trigger.executionId)
    expect(row?.status).toBe('dead')
    expect(downstream.requestsFor({ jobId: job.id })).toHaveLength(0)
  })
})

describe('死信重放边界', () => {
  it('不存在的死信 id → dead_letter_not_found', async () => {
    const result = await ctx.engine.replayDeadLetter({ deadLetterId: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('dead_letter_not_found')
  })

  it('已取消任务的死信不可重放（job_cancelled）', async () => {
    const { projectId } = await project()
    downstream.setHandler((_request, response) => {
      response.writeHead(500)
      response.end('boom')
    })

    const job = await createJob(ctx, {
      projectId,
      kind: 'cron',
      cron: '0 3 * * *',
      policies: { maxRetries: 0 },
    })
    const trigger = unwrapResult(await ctx.stub.manualTrigger({ jobId: job.id }))
    const deadLetter = await waitFor(
      async () =>
        (
          await ctx.sql.exec('SELECT * FROM dead_letters WHERE execution_id = ?', trigger.executionId)
        )[0],
      { label: '死信落库', timeoutMs: 20_000 },
    )

    unwrapResult(await ctx.stub.cancelJob({ jobId: job.id }))
    const result = await ctx.engine.replayDeadLetter({ deadLetterId: String(deadLetter.id) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('job_cancelled')
  })
})
