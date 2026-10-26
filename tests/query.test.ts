import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  DeadLetterView,
  ExecutionView,
  ListDeadLettersQuery,
  ListDeadLettersResult,
  ListExecutionsQuery,
  ListExecutionsResult,
  WakerErrorPayload,
  WakerResult,
} from '../src/do/types'
import { startHarness, unwrapResult, type TestContext } from './support/harness'
import type { WakerDO } from '../src/do/waker-do'

/**
 * B6 查询 RPC 集成测试（真 workerd + 真 SQLite，不 mock）：
 * `listExecutions` / `listDeadLetters` 的筛选、排序、keyset 游标翻页（含 NULL 区间）与空结果。
 *
 * 为什么直接写 SQL 播种而不是走调度/执行链路：本单验的是**只读查询的语义**
 * （筛选条件、排序键、游标边界），用确定性数据才能固定住「同一 scheduled_for 的 tiebreak」
 * 「待重放优先的桶边界」这类断言；队列/回调链路已由 engine.test.ts 覆盖。
 */

interface QueryRpc {
  listExecutions(query?: ListExecutionsQuery): Promise<WakerResult<ListExecutionsResult>>
  listDeadLetters(query?: ListDeadLettersQuery): Promise<WakerResult<ListDeadLettersResult>>
}

/** 编译期断言：WakerDO 真的实现了 B6 冻结契约（任一边改签名都会让 `tsc` 报错）。 */
const _contractCompatible: QueryRpc = {} as WakerDO
void _contractCompatible

let ctx: TestContext
let stub: QueryRpc

beforeAll(async () => {
  ctx = await startHarness()
  stub = ctx.stub as unknown as QueryRpc
})

afterAll(async () => {
  await ctx.harness.close()
})

async function expectFailure(
  promise: Promise<WakerResult<unknown>>,
  code: string,
): Promise<WakerErrorPayload> {
  const result = await promise
  expect(result.ok, `期望失败信封，实际成功：${JSON.stringify(result)}`).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code, `期望 ${code}，实际 ${result.error.code}：${result.error.message}`).toBe(
    code,
  )
  return result.error
}

/** 建一个暂停任务（enabled: false → 不进调度、不会插执行记录，测试数据保持确定）。 */
async function seedJob(projectId: string, name: string): Promise<string> {
  const job = unwrapResult(
    await ctx.stub.createJob({
      projectId,
      name,
      kind: 'cron',
      cron: '0 3 * * *',
      enabled: false,
    }),
  )
  return job.id
}

interface SeedExecutionOptions {
  id: string
  jobId: string
  projectId: string
  scheduledFor: number
  status?: string
  trigger?: 'schedule' | 'manual'
  createdAt?: number
  attempt?: number
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  responseStatus?: number | null
  error?: string | null
  skipReason?: string | null
  renewalAt?: number | null
  renewalError?: string | null
}

/** 直接落一条执行记录（列与 B3 写入形态一致）。 */
async function seedExecution(options: SeedExecutionOptions): Promise<void> {
  await ctx.sql.exec(
    `INSERT INTO executions (
       id, job_id, project_id, scheduled_for, dispatch_at, trigger, misfire, status,
       skip_reason, attempt, started_at, finished_at, duration_ms, response_status, error,
       created_at, renewal_at, renewal_error
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    options.id,
    options.jobId,
    options.projectId,
    options.scheduledFor,
    options.scheduledFor,
    options.trigger ?? 'schedule',
    options.status ?? 'succeeded',
    options.skipReason ?? null,
    options.attempt ?? 0,
    options.startedAt ?? null,
    options.finishedAt ?? null,
    options.durationMs ?? null,
    options.responseStatus ?? null,
    options.error ?? null,
    options.createdAt ?? options.scheduledFor,
    options.renewalAt ?? null,
    options.renewalError ?? null,
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
}

async function seedDeadLetter(options: SeedDeadLetterOptions): Promise<void> {
  await ctx.sql.exec(
    `INSERT INTO dead_letters (
       id, execution_id, job_id, project_id, attempts, error, payload, created_at,
       replayed_at, replayed_execution_id
     ) VALUES (?, ?, ?, ?, ?, ?, 'null', ?, ?, ?)`,
    options.id,
    options.executionId,
    options.jobId,
    options.projectId,
    options.attempts ?? 1,
    options.error ?? 'boom',
    options.createdAt,
    options.replayedAt ?? null,
    options.replayedExecutionId ?? null,
  )
}

/** 一路翻页到末尾，返回全量条目与页数；顺带断言每页非空、页数不超预期（防翻页死循环）。 */
async function drainExecutions(
  query: ListExecutionsQuery,
  expectedMaxPages: number,
): Promise<{ items: ExecutionView[]; pages: number }> {
  const items: ExecutionView[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page: ListExecutionsResult = unwrapResult(
      await stub.listExecutions({ ...query, cursor }),
    )
    pages += 1
    expect(page.executions.length, `第 ${pages} 页不该为空（否则游标会无限翻页）`).toBeGreaterThan(0)
    items.push(...page.executions)
    cursor = page.nextCursor
    expect(pages, `翻页次数超过预期上限 ${expectedMaxPages}（疑似死循环）`).toBeLessThanOrEqual(
      expectedMaxPages,
    )
  } while (cursor !== null)

  return { items, pages }
}

async function drainDeadLetters(
  query: ListDeadLettersQuery,
  expectedMaxPages: number,
): Promise<{ items: DeadLetterView[]; pages: number }> {
  const items: DeadLetterView[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page: ListDeadLettersResult = unwrapResult(
      await stub.listDeadLetters({ ...query, cursor }),
    )
    pages += 1
    expect(page.deadLetters.length, `第 ${pages} 页不该为空（否则游标会无限翻页）`).toBeGreaterThan(
      0,
    )
    items.push(...page.deadLetters)
    cursor = page.nextCursor
    expect(pages, `翻页次数超过预期上限 ${expectedMaxPages}（疑似死循环）`).toBeLessThanOrEqual(
      expectedMaxPages,
    )
  } while (cursor !== null)

  return { items, pages }
}

describe('listExecutions', () => {
  it('按 scheduledFor 降序排列，同一时刻按 id 降序稳定排序，并带上任务名', async () => {
    const projectId = 'proj-exec-order'
    const jobId = await seedJob(projectId, 'order-job')
    const base = 1_700_000_000_000
    const finishedAt = base + 5_000

    await seedExecution({
      id: 'ex-a',
      jobId,
      projectId,
      scheduledFor: base,
      finishedAt,
      durationMs: 120,
      responseStatus: 200,
    })
    await seedExecution({ id: 'ex-c', jobId, projectId, scheduledFor: base + 60_000 })
    await seedExecution({ id: 'ex-b', jobId, projectId, scheduledFor: base + 60_000 })

    const result = unwrapResult(await stub.listExecutions({ projectId }))

    expect(result.executions.map((execution) => execution.id)).toEqual(['ex-c', 'ex-b', 'ex-a'])
    expect(result.nextCursor).toBeNull()

    const oldest = result.executions[2]!
    expect(oldest.jobId).toBe(jobId)
    expect(oldest.jobName).toBe('order-job')
    expect(oldest.scheduledFor).toBe(base)
    expect(oldest.dispatchAt).toBe(base)
    expect(oldest.status).toBe('succeeded')
    expect(oldest.trigger).toBe('schedule')
    expect(oldest.misfire).toBe(false)
    expect(oldest.finishedAt).toBe(finishedAt)
    expect(oldest.durationMs).toBe(120)
    expect(oldest.responseStatus).toBe(200)
    expect(oldest.error).toBeNull()
  })

  it('支持按 jobId / status / trigger 过滤', async () => {
    const projectId = 'proj-exec-filter'
    const jobA = await seedJob(projectId, 'filter-a')
    const jobB = await seedJob(projectId, 'filter-b')
    const base = 1_700_100_000_000

    await seedExecution({ id: 'f-1', jobId: jobA, projectId, scheduledFor: base, status: 'succeeded' })
    await seedExecution({
      id: 'f-2',
      jobId: jobA,
      projectId,
      scheduledFor: base + 1_000,
      status: 'failed',
      trigger: 'manual',
      attempt: 2,
      error: 'downstream 500',
    })
    await seedExecution({
      id: 'f-3',
      jobId: jobB,
      projectId,
      scheduledFor: base + 2_000,
      status: 'skipped',
      skipReason: 'concurrency_policy_forbid',
    })

    const byJob = unwrapResult(await stub.listExecutions({ jobId: jobA }))
    expect(byJob.executions.map((execution) => execution.id)).toEqual(['f-2', 'f-1'])
    expect(byJob.executions[0]!.attempt).toBe(2)
    expect(byJob.executions[0]!.error).toBe('downstream 500')

    const failed = unwrapResult(await stub.listExecutions({ projectId, status: 'failed' }))
    expect(failed.executions.map((execution) => execution.id)).toEqual(['f-2'])

    const manual = unwrapResult(await stub.listExecutions({ projectId, trigger: 'manual' }))
    expect(manual.executions.map((execution) => execution.id)).toEqual(['f-2'])

    const skipped = unwrapResult(await stub.listExecutions({ projectId, status: 'skipped' }))
    expect(skipped.executions[0]!.skipReason).toBe('concurrency_policy_forbid')

    // 过滤条件之间是 AND：同一任务 + 另一状态 → 空
    const contradiction = unwrapResult(
      await stub.listExecutions({ jobId: jobA, status: 'skipped' }),
    )
    expect(contradiction.executions).toEqual([])
    expect(contradiction.nextCursor).toBeNull()
  })

  it('时间区间是半开区间 [scheduledFrom, scheduledTo)', async () => {
    const projectId = 'proj-exec-range'
    const jobId = await seedJob(projectId, 'range-job')
    const base = 1_700_200_000_000

    for (const [id, offset] of [
      ['r-0', 0],
      ['r-1', 1_000],
      ['r-2', 2_000],
      ['r-3', 3_000],
    ] as const) {
      await seedExecution({ id, jobId, projectId, scheduledFor: base + offset })
    }

    const window = unwrapResult(
      await stub.listExecutions({
        projectId,
        scheduledFrom: base + 1_000,
        scheduledTo: base + 3_000,
      }),
    )
    // from 含、to 不含：只剩 r-2 与 r-1，且降序
    expect(window.executions.map((execution) => execution.id)).toEqual(['r-2', 'r-1'])

    const openEnded = unwrapResult(
      await stub.listExecutions({ projectId, scheduledFrom: base + 2_000 }),
    )
    expect(openEnded.executions.map((execution) => execution.id)).toEqual(['r-3', 'r-2'])

    // from === to 是合法的空区间（不是错误）
    const empty = unwrapResult(
      await stub.listExecutions({ projectId, scheduledFrom: base + 1_000, scheduledTo: base + 1_000 }),
    )
    expect(empty.executions).toEqual([])
  })

  it('游标翻页：每页 limit+1 探测，跨页不重不漏，翻到末尾 nextCursor 为 null', async () => {
    const projectId = 'proj-exec-page'
    const jobId = await seedJob(projectId, 'page-job')
    const base = 1_700_300_000_000

    // 5 条，其中 p-2 / p-3 同一 scheduledFor（验 tiebreak）
    const offsets: Record<string, number> = {
      'p-1': 0,
      'p-2': 1_000,
      'p-3': 1_000,
      'p-4': 2_000,
      'p-5': 3_000,
    }
    for (const [id, offset] of Object.entries(offsets)) {
      await seedExecution({ id, jobId, projectId, scheduledFor: base + offset })
    }

    const first = unwrapResult(await stub.listExecutions({ projectId, limit: 2 }))
    expect(first.executions.map((execution) => execution.id)).toEqual(['p-5', 'p-4'])
    expect(first.nextCursor).toBeTruthy()

    const { items, pages } = await drainExecutions({ projectId, limit: 2 }, 3)
    expect(pages).toBe(3)
    expect(items.map((execution) => execution.id)).toEqual(['p-5', 'p-4', 'p-3', 'p-2', 'p-1'])
    expect(new Set(items.map((execution) => execution.id)).size).toBe(5)
  })

  it('空结果：未知项目直接返回空数组 + null 游标', async () => {
    const empty = unwrapResult(await stub.listExecutions({ projectId: 'proj-not-exists' }))
    expect(empty.executions).toEqual([])
    expect(empty.nextCursor).toBeNull()
  })

  it('入参非法一律 invalid_argument（含跨接口游标、越界 limit、反向时间区间）', async () => {
    await expectFailure(stub.listExecutions({ limit: 0 }), 'invalid_argument')
    await expectFailure(stub.listExecutions({ status: 'unknown' as never }), 'invalid_argument')
    await expectFailure(stub.listExecutions({ trigger: 'cron' as never }), 'invalid_argument')
    await expectFailure(stub.listExecutions({ jobId: '   ' }), 'invalid_argument')
    await expectFailure(stub.listExecutions({ cursor: 'not-a-cursor' }), 'invalid_argument')
    await expectFailure(
      stub.listExecutions({ scheduledFrom: 2_000, scheduledTo: 1_000 }),
      'invalid_argument',
    )
    // 死信游标不能拿来翻执行记录
    await expectFailure(stub.listExecutions({ cursor: 'd1|p|1000|dl-1' }), 'invalid_argument')
  })
})

describe('listDeadLetters', () => {
  it('未重放优先，桶内按 createdAt 降序、id 降序', async () => {
    const projectId = 'proj-dl-order'
    const jobId = await seedJob(projectId, 'dl-order-job')
    const base = 1_700_400_000_000

    await seedDeadLetter({
      id: 'dl-old-pending',
      executionId: 'ex-dl-1',
      jobId,
      projectId,
      createdAt: base,
      attempts: 3,
      error: 'first boom',
    })
    await seedDeadLetter({
      id: 'dl-new-pending',
      executionId: 'ex-dl-2',
      jobId,
      projectId,
      createdAt: base + 10_000,
    })
    await seedDeadLetter({
      id: 'dl-replayed',
      executionId: 'ex-dl-3',
      jobId,
      projectId,
      createdAt: base + 20_000,
      replayedAt: base + 30_000,
      replayedExecutionId: 'ex-replay-1',
    })

    const result = unwrapResult(await stub.listDeadLetters({ projectId }))
    expect(result.deadLetters.map((letter) => letter.id)).toEqual([
      'dl-new-pending',
      'dl-old-pending',
      'dl-replayed',
    ])
    expect(result.nextCursor).toBeNull()

    const replayed = result.deadLetters[2]!
    expect(replayed.jobId).toBe(jobId)
    expect(replayed.replayedAt).toBe(base + 30_000)
    expect(replayed.replayedExecutionId).toBe('ex-replay-1')
    expect(result.deadLetters[1]!.attempts).toBe(3)
    expect(result.deadLetters[1]!.error).toBe('first boom')
  })

  it('游标跨 NULL 区间（未重放桶 → 已重放桶）：不重不漏，不会每页从头返回第 1 页', async () => {
    const projectId = 'proj-dl-null-cursor'
    const jobId = await seedJob(projectId, 'dl-null-job')
    const base = 1_700_500_000_000

    // 3 条未重放（replayed_at 为 NULL，排序里排最前）+ 2 条已重放
    const pending = ['n-1', 'n-2', 'n-3']
    for (const [index, id] of pending.entries()) {
      await seedDeadLetter({
        id,
        executionId: `ex-${id}`,
        jobId,
        projectId,
        createdAt: base + index * 1_000,
      })
    }
    const replayed = ['y-1', 'y-2']
    for (const [index, id] of replayed.entries()) {
      await seedDeadLetter({
        id,
        executionId: `ex-${id}`,
        jobId,
        projectId,
        createdAt: base + (index + 3) * 1_000,
        replayedAt: base + 100_000 + index,
      })
    }

    // limit = 2：第 1 页全在 NULL 桶（n-3, n-2），第 2 页跨桶边界（n-1, y-2），第 3 页收尾（y-1）
    const first = unwrapResult(await stub.listDeadLetters({ projectId, limit: 2 }))
    expect(first.deadLetters.map((letter) => letter.id)).toEqual(['n-3', 'n-2'])
    expect(first.nextCursor).toBeTruthy()

    const second = unwrapResult(
      await stub.listDeadLetters({ projectId, limit: 2, cursor: first.nextCursor }),
    )
    expect(second.deadLetters.map((letter) => letter.id)).toEqual(['n-1', 'y-2'])
    expect(second.nextCursor).toBeTruthy()

    const { items, pages } = await drainDeadLetters({ projectId, limit: 2 }, 3)
    expect(pages).toBe(3)
    expect(items.map((letter) => letter.id)).toEqual(['n-3', 'n-2', 'n-1', 'y-2', 'y-1'])
    expect(new Set(items.map((letter) => letter.id)).size).toBe(5)
  })

  it('支持按 jobId / replayState / 时间区间筛选', async () => {
    const projectId = 'proj-dl-filter'
    const jobA = await seedJob(projectId, 'dl-filter-a')
    const jobB = await seedJob(projectId, 'dl-filter-b')
    const base = 1_700_600_000_000

    await seedDeadLetter({
      id: 'g-1',
      executionId: 'ex-g-1',
      jobId: jobA,
      projectId,
      createdAt: base,
    })
    await seedDeadLetter({
      id: 'g-2',
      executionId: 'ex-g-2',
      jobId: jobA,
      projectId,
      createdAt: base + 1_000,
      replayedAt: base + 5_000,
    })
    await seedDeadLetter({
      id: 'g-3',
      executionId: 'ex-g-3',
      jobId: jobB,
      projectId,
      createdAt: base + 2_000,
    })

    const byJob = unwrapResult(await stub.listDeadLetters({ jobId: jobA }))
    expect(byJob.deadLetters.map((letter) => letter.id)).toEqual(['g-1', 'g-2'])

    const pendingOnly = unwrapResult(
      await stub.listDeadLetters({ projectId, replayState: 'pending' }),
    )
    expect(pendingOnly.deadLetters.map((letter) => letter.id)).toEqual(['g-3', 'g-1'])

    const replayedOnly = unwrapResult(
      await stub.listDeadLetters({ projectId, replayState: 'replayed' }),
    )
    expect(replayedOnly.deadLetters.map((letter) => letter.id)).toEqual(['g-2'])

    const window = unwrapResult(
      await stub.listDeadLetters({
        projectId,
        createdFrom: base + 1_000,
        createdTo: base + 2_000,
      }),
    )
    expect(window.deadLetters.map((letter) => letter.id)).toEqual(['g-2'])
  })

  it('空结果：未知项目直接返回空数组 + null 游标', async () => {
    const empty = unwrapResult(await stub.listDeadLetters({ projectId: 'proj-not-exists' }))
    expect(empty.deadLetters).toEqual([])
    expect(empty.nextCursor).toBeNull()
  })

  it('入参非法一律 invalid_argument（含跨接口游标、伪造桶标记、反向时间区间）', async () => {
    await expectFailure(stub.listDeadLetters({ limit: 0 }), 'invalid_argument')
    await expectFailure(
      stub.listDeadLetters({ replayState: 'done' as never }),
      'invalid_argument',
    )
    await expectFailure(stub.listDeadLetters({ cursor: 'garbage' }), 'invalid_argument')
    await expectFailure(stub.listDeadLetters({ cursor: 'd1|z|1000|dl-1' }), 'invalid_argument')
    await expectFailure(stub.listDeadLetters({ cursor: 'e1|1000|ex-1' }), 'invalid_argument')
    await expectFailure(
      stub.listDeadLetters({ createdFrom: 2_000, createdTo: 1_000 }),
      'invalid_argument',
    )
  })
})
