import { createTestHarness, type TestHarness, type WorkerHandle } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  CreateJobInput,
  JobRef,
  JobView,
  ListJobsQuery,
  ListJobsResult,
  ManualTriggerInput,
  ManualTriggerResult,
  SyncAlarmResult,
  WakerErrorPayload,
  WakerResult,
} from '../src/do/types'
import { createCronSchedule } from '../src/cron'
import type { WakerDO } from '../src/do/waker-do'
import type { Env } from '../src/env'

/**
 * WakerDO 集成测试：**真的在 workerd 里跑**（wrangler 的 `createTestHarness` → Miniflare）。
 *
 * 用本仓真实的 wrangler.toml（真 DO 绑定、真 SQLite 后端），断言直接查 DO 里的 SQLite，
 * 不是 mock —— 这样「本地可运行 DO」这条验收标准是被真跑过的。
 */

const INSTANCE_NAME = 'waker'

interface ExecutionRow {
  id: string
  job_id: string
  project_id: string
  scheduled_for: number
  dispatch_at: number
  trigger: string
  misfire: number
  status: string
  skip_reason: string | null
  attempt: number
}

/**
 * 冻结 RPC 契约的类型面（测试侧独立声明）：
 * 下面的 `_contractCompatible` 在编译期保证 WakerDO 真的实现了这些方法。
 */
interface WakerRpcContract {
  createJob(input: CreateJobInput): Promise<WakerResult<JobView>>
  cancelJob(ref: JobRef): Promise<WakerResult<JobView>>
  pauseJob(ref: JobRef): Promise<WakerResult<JobView>>
  resumeJob(ref: JobRef): Promise<WakerResult<JobView>>
  manualTrigger(input: ManualTriggerInput): Promise<WakerResult<ManualTriggerResult>>
  getJob(ref: JobRef): Promise<WakerResult<JobView | null>>
  listJobs(query?: ListJobsQuery): Promise<WakerResult<ListJobsResult>>
  syncAlarm(): Promise<WakerResult<SyncAlarmResult>>
}

/** 编译期断言：WakerDO 满足冻结契约。 */
const _contractCompatible: WakerRpcContract = {} as WakerDO
void _contractCompatible

let harness: TestHarness
let worker: WorkerHandle<Env>
let stub: WakerRpcContract
let sql: { exec: (query: string, ...bindings: unknown[]) => Promise<Record<string, unknown>[]> }

/** 拆信封：成功取值，失败抛出带 code 的错误，便于断言。 */
function unwrapResult<T>(result: WakerResult<T>): T {
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), {
    code: result.error.code,
    details: result.error.details,
  })
}

/** 断言失败信封里的错误码，返回错误载荷（details 也可继续断言）。 */
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

beforeAll(async () => {
  harness = createTestHarness({ workers: [{ configPath: './wrangler.toml' }] })
  await harness.listen()
  worker = harness.getWorker<Env>()
  const env = await worker.getEnv()
  stub = env.WAKER_DO.get(env.WAKER_DO.idFromName(INSTANCE_NAME)) as unknown as WakerRpcContract
  sql = (await worker.getDurableObjectStorage('WAKER_DO', {
    name: INSTANCE_NAME,
  })) as unknown as typeof sql
})

afterAll(async () => {
  await harness.close()
})

let nameCounter = 0
function uniqueName(prefix: string): string {
  nameCounter += 1
  return `${prefix}-${nameCounter}`
}

async function executionsOf(jobId: string): Promise<ExecutionRow[]> {
  return (await sql.exec(
    'SELECT * FROM executions WHERE job_id = ? ORDER BY scheduled_for',
    jobId,
  )) as unknown as ExecutionRow[]
}

async function jobRow(jobId: string): Promise<Record<string, unknown>> {
  const rows = await sql.exec('SELECT * FROM jobs WHERE id = ?', jobId)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/** 把任务的 next_run_at 人为回拨（模拟 alarm 迟到 / 停机积压）。 */
async function backdateNextRunAt(jobId: string, nextRunAt: number): Promise<void> {
  await sql.exec('UPDATE jobs SET next_run_at = ? WHERE id = ?', nextRunAt, jobId)
}

/**
 * 跨年 cron（每年 1 月 1 日 00:00 UTC）：槽位稀疏且都远早于 now，
 * 让「错过窗口 / 补跑」断言不依赖测试跑在哪一分钟（5 分钟级 cron 的最近槽位
 * 可能正好在 60s 容差内，断言语义会抖）。
 */
const YEARLY_CRON = '0 0 1 1 *'
const YEARLY_ANCHOR = Date.parse('2024-01-01T00:00:00.000Z')

/** 从锚点起、到 now 为止的应到期槽位（用同一个解析器推算，避免手写日历）。 */
function yearlySlotsUntilNow(): number[] {
  const schedule = createCronSchedule(YEARLY_CRON, { timezone: 'UTC' })
  const now = Date.now()
  return [YEARLY_ANCHOR, ...schedule.nextAfterN(YEARLY_ANCHOR, 20)].filter((slot) => slot <= now)
}

function cronJob(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    projectId: 'proj-test',
    name: uniqueName('cron'),
    kind: 'cron',
    cron: '0 3 * * *',
    timezone: 'UTC',
    ...overrides,
  }
}

describe('数据模型：DO 启动即建好 SQLite 表', () => {
  it('五张表齐全且 schema 版本已写入', async () => {
    const tables = await sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    const names = tables.map((row) => row.name as string)

    for (const table of ['dead_letters', 'executions', 'jobs', 'projects', 'signing_keys']) {
      expect(names).toContain(table)
    }

    // 版本账本在 waker_meta 里（DO 的 SQLite 不允许读写 PRAGMA user_version）
    const version = await sql.exec(`SELECT value FROM waker_meta WHERE key = 'schema_version'`)
    expect(Number(version[0]!.value)).toBe(1)
  })
})

describe('任务 CRUD 与策略字段读写', () => {
  it('创建 cron 任务：表达式原样保留、策略字段落库、nextRunAt 已排定', async () => {
    const input = cronJob({
      cron: '10 7 * * mon-fri',
      timezone: 'Asia/Shanghai',
      payload: { hello: 'world' },
      policies: {
        misfire: 'skip',
        concurrency: 'allow',
        maxRetries: 3,
        backoffSeconds: 60,
        timeoutSeconds: 120,
        jitterSeconds: 30,
      },
    })

    const job = unwrapResult(await stub.createJob(input))

    expect(job.name).toBe(input.name)
    expect(job.kind).toBe('cron')
    expect(job.cron).toBe('10 7 * * mon-fri')
    expect(job.cronNormalized).toBe('10 7 * * 2-6')
    expect(job.timezone).toBe('Asia/Shanghai')
    expect(job.status).toBe('active')
    expect(job.payload).toEqual({ hello: 'world' })
    expect(job.policies).toEqual({
      misfire: 'skip',
      concurrency: 'allow',
      maxRetries: 3,
      backoffSeconds: 60,
      timeoutSeconds: 120,
      jitterSeconds: 30,
    })
    // 上海时区 07:10 = 前一天 23:10Z → 排定时刻必是 UTC 的 :10 且落在未来
    expect(job.nextRunAt).not.toBeNull()
    expect(new Date(job.nextRunAt!).getUTCMinutes()).toBe(10)
    expect(job.nextRunAt!).toBeGreaterThan(Date.now())

    const row = await jobRow(job.id)
    expect(row.misfire_policy).toBe('skip')
    expect(row.concurrency_policy).toBe('allow')
    expect(row.max_retries).toBe(3)
    expect(row.backoff_seconds).toBe(60)
    expect(row.timeout_seconds).toBe(120)
    expect(row.jitter_seconds).toBe(30)
    expect(row.next_run_at).toBe(job.nextRunAt)
  })

  it('未传策略字段时取契约里写死的默认值', async () => {
    const job = unwrapResult(await stub.createJob(cronJob()))
    expect(job.policies).toEqual({
      misfire: 'fire_once',
      concurrency: 'forbid',
      maxRetries: 0,
      backoffSeconds: 0,
      timeoutSeconds: 30,
      jitterSeconds: 0,
    })
  })

  it('one_shot 任务接受 epoch 毫秒与 ISO 字符串，统一按毫秒存', async () => {
    const runAt = Date.now() + 3_600_000

    const byNumber = unwrapResult(
      await stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('oneshot'),
        kind: 'one_shot',
        runAt,
      }),
    )
    expect(byNumber.runAt).toBe(runAt)
    expect(byNumber.nextRunAt).toBe(runAt)
    expect(byNumber.cron).toBeNull()

    const byIso = unwrapResult(
      await stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('oneshot'),
        kind: 'one_shot',
        runAt: new Date(runAt).toISOString(),
      }),
    )
    expect(byIso.runAt).toBe(runAt)
  })

  it('同项目下任务名唯一；不同项目可同名', async () => {
    const name = uniqueName('dup')
    unwrapResult(await stub.createJob(cronJob({ name })))

    await expectFailure(stub.createJob(cronJob({ name })), 'duplicate_job')

    const other = unwrapResult(await stub.createJob(cronJob({ name, projectId: 'proj-other' })))
    expect(other.projectId).toBe('proj-other')
  })

  it('getJob 支持 jobId 与 (projectId, name) 两种定位；不存在返回 null', async () => {
    const input = cronJob()
    const created = unwrapResult(await stub.createJob(input))

    const byId = unwrapResult(await stub.getJob({ jobId: created.id }))
    expect(byId?.id).toBe(created.id)

    const byName = unwrapResult(
      await stub.getJob({ projectId: input.projectId!, name: input.name }),
    )
    expect(byName?.id).toBe(created.id)

    expect(unwrapResult(await stub.getJob({ jobId: 'does-not-exist' }))).toBeNull()
  })

  it('pause / resume：暂停撤出调度，恢复按当前时刻之后的下一个槽位重排', async () => {
    const job = unwrapResult(await stub.createJob(cronJob()))

    const paused = unwrapResult(await stub.pauseJob({ jobId: job.id }))
    expect(paused.status).toBe('paused')
    expect(paused.nextRunAt).toBeNull()
    expect((await jobRow(job.id)).next_run_at).toBeNull()

    const resumed = unwrapResult(await stub.resumeJob({ jobId: job.id }))
    expect(resumed.status).toBe('active')
    expect(resumed.nextRunAt!).toBeGreaterThan(Date.now())
  })

  it('cancel 是终态：取消后不能暂停 / 恢复 / 手动触发', async () => {
    const job = unwrapResult(await stub.createJob(cronJob()))

    const cancelled = unwrapResult(await stub.cancelJob({ jobId: job.id }))
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nextRunAt).toBeNull()

    await expectFailure(stub.resumeJob({ jobId: job.id }), 'job_cancelled')
    await expectFailure(stub.pauseJob({ jobId: job.id }), 'job_cancelled')
    await expectFailure(stub.manualTrigger({ jobId: job.id }), 'job_cancelled')
  })

  it('未知任务的操作报 job_not_found', async () => {
    await expectFailure(stub.cancelJob({ jobId: 'nope' }), 'job_not_found')
    await expectFailure(stub.pauseJob({ jobId: 'nope' }), 'job_not_found')
    await expectFailure(stub.resumeJob({ jobId: 'nope' }), 'job_not_found')
    await expectFailure(stub.manualTrigger({ jobId: 'nope' }), 'job_not_found')
  })

  it('策略字段 / runAt / kind 非法时报对应错误码', async () => {
    await expectFailure(
      stub.createJob(cronJob({ policies: { misfire: 'explode' as never } })),
      'invalid_policy',
    )
    await expectFailure(
      stub.createJob(cronJob({ policies: { maxRetries: -1 } })),
      'invalid_policy',
    )
    await expectFailure(
      stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('bad-runat'),
        kind: 'one_shot',
        runAt: 'not-a-date',
      }),
      'invalid_run_at',
    )
    await expectFailure(
      stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('bad-kind'),
        kind: 'weird' as never,
        cron: '0 3 * * *',
      }),
      'invalid_argument',
    )
  })

  it('one-shot 执行完之后不能 resume（job_not_resumable）', async () => {
    const runAt = Date.now() + 3_600_000
    const job = unwrapResult(
      await stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('oneshot-done'),
        kind: 'one_shot',
        runAt,
      }),
    )
    unwrapResult(await stub.pauseJob({ jobId: job.id }))
    // 直接标记为已完成（模拟已执行完毕）
    await sql.exec(`UPDATE jobs SET status = 'completed' WHERE id = ?`, job.id)

    await expectFailure(stub.resumeJob({ jobId: job.id }), 'job_not_resumable')
    await expectFailure(stub.pauseJob({ jobId: job.id }), 'job_not_resumable')
  })

  it('手动触发只加一条 immediate 执行记录，不动周期排定', async () => {
    const job = unwrapResult(await stub.createJob(cronJob()))
    const before = job.nextRunAt

    const triggered = unwrapResult(await stub.manualTrigger({ jobId: job.id }))
    expect(triggered.jobId).toBe(job.id)
    expect(triggered.executionId).toBeTruthy()
    expect(triggered.scheduledFor).toBe(triggered.dispatchAt)

    const rows = await executionsOf(job.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.trigger).toBe('manual')
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.misfire).toBe(0)

    const refreshed = unwrapResult(await stub.getJob({ jobId: job.id }))
    expect(refreshed?.nextRunAt).toBe(before)
  })
})

describe('cron 方言落地（经 RPC 走完整链路）', () => {
  it('拒绝 6 字段 / `?` / `@` 宏 / Vixie 星期 0，并透出方言错误码', async () => {
    const cases: Array<[string, string]> = [
      ['0 0 3 * * *', 'cron_field_count'],
      ['0 3 ? * *', 'cron_question_mark_unsupported'],
      ['@daily', 'cron_macro_unsupported'],
      ['0 3 * * 0', 'cron_weekday_zero'],
    ]

    for (const [cron, dialectCode] of cases) {
      const error = await expectFailure(stub.createJob(cronJob({ cron })), 'invalid_cron')
      const cronDetails = (error.details as { cron: { dialectCode: string; field: unknown } }).cron
      expect(cronDetails.dialectCode).toBe(dialectCode)
      expect(cronDetails).toHaveProperty('field')
    }
  })

  it('非法时区报 invalid_timezone', async () => {
    await expectFailure(stub.createJob(cronJob({ timezone: 'Mars/Base' })), 'invalid_timezone')
  })

  it('CF 扩展形式在 DO 里算出的执行时刻正确（LW / friL / MON#1）', async () => {
    const lw = unwrapResult(await stub.createJob(cronJob({ cron: '59 23 LW * *' })))
    const lwAt = new Date(lw.nextRunAt!)
    expect(lwAt.getUTCHours()).toBe(23)
    expect(lwAt.getUTCMinutes()).toBe(59)
    // 月末最后一个工作日不可能是周六（6）或周日（0）
    expect([1, 2, 3, 4, 5]).toContain(lwAt.getUTCDay())

    const friL = unwrapResult(await stub.createJob(cronJob({ cron: '0 18 * * friL' })))
    expect(new Date(friL.nextRunAt!).getUTCDay()).toBe(5)

    const mon1 = unwrapResult(await stub.createJob(cronJob({ cron: '0 12 * * MON#1' })))
    const mon1At = new Date(mon1.nextRunAt!)
    expect(mon1At.getUTCDay()).toBe(1)
    expect(mon1At.getUTCDate()).toBeLessThanOrEqual(7)
  })
})

describe('next_run_at 排序查询', () => {
  it('按 next_run_at 升序返回，无下次执行的排最后，游标可续页', async () => {
    const projectId = uniqueName('proj-order')
    const now = Date.now()

    const late = unwrapResult(
      await stub.createJob({ projectId, name: 'c', kind: 'one_shot', runAt: now + 300_000 }),
    )
    const early = unwrapResult(
      await stub.createJob({ projectId, name: 'a', kind: 'one_shot', runAt: now + 60_000 }),
    )
    const middle = unwrapResult(
      await stub.createJob({ projectId, name: 'b', kind: 'one_shot', runAt: now + 120_000 }),
    )
    const paused = unwrapResult(
      await stub.createJob({
        projectId,
        name: 'd',
        kind: 'cron',
        cron: '0 4 * * *',
        enabled: false,
      }),
    )

    expect(paused.nextRunAt).toBeNull()

    const firstPage = unwrapResult(await stub.listJobs({ projectId, limit: 2 }))
    expect(firstPage.jobs.map((job) => job.name)).toEqual(['a', 'b'])
    expect(firstPage.nextCursor).toBeTruthy()

    const secondPage = unwrapResult(
      await stub.listJobs({ projectId, limit: 2, cursor: firstPage.nextCursor }),
    )
    expect(secondPage.jobs.map((job) => job.name)).toEqual(['c', 'd'])
    expect(secondPage.nextCursor).toBeNull()
    expect(secondPage.jobs[0]!.id).toBe(late.id)
    expect(secondPage.jobs[1]!.id).toBe(paused.id)
    expect(secondPage.jobs[0]!.nextRunAt!).toBeGreaterThan(middle.nextRunAt!)
    expect(secondPage.jobs[0]!.nextRunAt!).toBeGreaterThan(early.nextRunAt!)
  })

  it('支持按 status / kind 过滤', async () => {
    const projectId = uniqueName('proj-filter')
    unwrapResult(
      await stub.createJob({ projectId, name: 'cron-1', kind: 'cron', cron: '0 5 * * *' }),
    )
    unwrapResult(
      await stub.createJob({
        projectId,
        name: 'oneshot-1',
        kind: 'one_shot',
        runAt: Date.now() + 600_000,
        enabled: false,
      }),
    )

    // 变量名不要写成 crons：check-single-cron.mjs 的守卫按 `crons\s*=` 扫描全仓
    const cronOnly = unwrapResult(await stub.listJobs({ projectId, kind: 'cron' }))
    expect(cronOnly.jobs.map((job) => job.name)).toEqual(['cron-1'])

    const paused = unwrapResult(await stub.listJobs({ projectId, status: 'paused' }))
    expect(paused.jobs.map((job) => job.name)).toEqual(['oneshot-1'])
  })

  it('limit 非法报 invalid_argument', async () => {
    await expectFailure(stub.listJobs({ limit: 0 }), 'invalid_argument')
  })
})

describe('alarm：回看补发、misfire 策略、并发策略', () => {
  it('one_shot 到期：syncAlarm 落执行记录、任务转 completed', async () => {
    // 先按未来时刻创建（避免 alarm 抢在断言前自己跑掉），再用 SQL 把排定时刻回拨到过去，
    // 模拟「停机期间到期、由 watchdog 的 syncAlarm 补处理」。
    const runAt = Date.now() + 3_600_000
    const job = unwrapResult(
      await stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('oneshot-due'),
        kind: 'one_shot',
        runAt,
      }),
    )
    const missedAt = Date.now() - 120_000
    await sql.exec(
      'UPDATE jobs SET run_at = ?, next_run_at = ? WHERE id = ?',
      missedAt,
      missedAt,
      job.id,
    )

    const result = unwrapResult(await stub.syncAlarm())
    expect(result.dueJobs).toBeGreaterThanOrEqual(1)

    const rows = await executionsOf(job.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scheduled_for).toBe(missedAt)
    expect(rows[0]!.misfire).toBe(1) // 迟到超过容差 → 按 fire_once 补跑一次
    expect(rows[0]!.status).toBe('pending')

    const row = await jobRow(job.id)
    expect(row.status).toBe('completed')
    expect(row.next_run_at).toBeNull()
    expect(row.last_run_at).toBe(missedAt)
  })

  it('fire_all：积压的每个槽位都补一条执行记录', async () => {
    const job = unwrapResult(
      await stub.createJob(cronJob({ cron: YEARLY_CRON, policies: { misfire: 'fire_all' } })),
    )

    await backdateNextRunAt(job.id, YEARLY_ANCHOR)
    const expected = yearlySlotsUntilNow()
    expect(expected.length).toBeGreaterThanOrEqual(2)

    unwrapResult(await stub.syncAlarm())

    const rows = await executionsOf(job.id)
    // 可能比 expected 多一条：syncAlarm 的 now 比 yearlySlotsUntilNow 的 now 稍晚
    expect(rows.length).toBeGreaterThanOrEqual(expected.length)
    expect(rows.slice(0, expected.length).map((row) => row.scheduled_for)).toEqual(expected)
    // 除最后一条（可能正好落在容差内）外，补跑记录都要标记 misfire
    expect(rows.slice(0, rows.length - 1).every((row) => row.misfire === 1)).toBe(true)

    const refreshed = unwrapResult(await stub.getJob({ jobId: job.id }))
    expect(refreshed?.status).toBe('active')
    expect(refreshed!.nextRunAt!).toBeGreaterThan(Date.now())
  })

  it('fire_once：多次积压只补跑最近的一次', async () => {
    const job = unwrapResult(
      await stub.createJob(cronJob({ cron: YEARLY_CRON, policies: { misfire: 'fire_once' } })),
    )

    await backdateNextRunAt(job.id, YEARLY_ANCHOR)
    const expected = yearlySlotsUntilNow()

    unwrapResult(await stub.syncAlarm())

    const rows = await executionsOf(job.id)
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(rows[0]!.scheduled_for).toBe(expected.at(-1))
    expect(rows[0]!.misfire).toBe(1)
    if (rows.length === 2) expect(rows[1]!.misfire).toBe(0)
  })

  it('skip：错过窗口的槽位一条都不补', async () => {
    const job = unwrapResult(
      await stub.createJob(cronJob({ cron: YEARLY_CRON, policies: { misfire: 'skip' } })),
    )

    await backdateNextRunAt(job.id, YEARLY_ANCHOR)

    unwrapResult(await stub.syncAlarm())

    const rows = await executionsOf(job.id)
    // 最多一条：只有落在 60s 容差内的那个槽位会被执行
    expect(rows.length).toBeLessThanOrEqual(1)
    expect(rows.every((row) => row.misfire === 0)).toBe(true)

    const refreshed = unwrapResult(await stub.getJob({ jobId: job.id }))
    expect(refreshed!.nextRunAt!).toBeGreaterThan(Date.now())
  })

  it('concurrency forbid：上一次还没结束就跳过本次（留 skipped 记录）', async () => {
    const job = unwrapResult(
      await stub.createJob(
        cronJob({ cron: YEARLY_CRON, policies: { concurrency: 'forbid', misfire: 'fire_all' } }),
      ),
    )

    // 一条未完成的执行 → 视为「上一次还没结束」
    unwrapResult(await stub.manualTrigger({ jobId: job.id }))
    await backdateNextRunAt(job.id, YEARLY_ANCHOR)

    unwrapResult(await stub.syncAlarm())

    const rows = await executionsOf(job.id)
    const scheduled = rows.filter((row) => row.trigger === 'schedule')
    expect(scheduled.length).toBeGreaterThanOrEqual(2)
    expect(scheduled.every((row) => row.status === 'skipped')).toBe(true)
    expect(scheduled[0]!.skip_reason).toBe('concurrency_policy_forbid')
  })

  it('concurrency allow：上一次没结束也照常排队', async () => {
    const job = unwrapResult(
      await stub.createJob(
        cronJob({ cron: '*/5 * * * *', policies: { concurrency: 'allow', misfire: 'fire_all' } }),
      ),
    )

    unwrapResult(await stub.manualTrigger({ jobId: job.id }))
    await backdateNextRunAt(job.id, job.nextRunAt! - 10 * 60_000)

    unwrapResult(await stub.syncAlarm())

    const rows = await executionsOf(job.id)
    const scheduled = rows.filter((row) => row.trigger === 'schedule')
    expect(scheduled.length).toBeGreaterThanOrEqual(2)
    expect(scheduled.every((row) => row.status === 'pending')).toBe(true)
  })

  it('抖动：dispatchAt 落在 [scheduledFor, scheduledFor + jitter] 内', async () => {
    const job = unwrapResult(
      await stub.createJob(cronJob({ cron: '*/5 * * * *', policies: { jitterSeconds: 120 } })),
    )

    await backdateNextRunAt(job.id, job.nextRunAt! - 5 * 60_000)
    unwrapResult(await stub.syncAlarm())

    const [row] = await executionsOf(job.id)
    expect(row).toBeDefined()
    expect(row!.dispatch_at).toBeGreaterThanOrEqual(row!.scheduled_for)
    expect(row!.dispatch_at).toBeLessThanOrEqual(row!.scheduled_for + 120_000)
  })

  it('alarm 真的会自己响：workerd 到点唤醒 DO 并落执行记录', async () => {
    const runAt = Date.now() + 800
    const job = unwrapResult(
      await stub.createJob({
        projectId: 'proj-test',
        name: uniqueName('oneshot-alarm'),
        kind: 'one_shot',
        runAt,
      }),
    )

    const deadline = Date.now() + 20_000
    let rows: ExecutionRow[] = []
    while (Date.now() < deadline) {
      rows = await executionsOf(job.id)
      if (rows.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    expect(rows).toHaveLength(1)
    expect(rows[0]!.scheduled_for).toBe(runAt)
    expect(rows[0]!.misfire).toBe(0)
    expect((await jobRow(job.id)).status).toBe('completed')
  }, 30_000)
})

describe('watchdog（唯一 Cron Trigger）→ DO alarm 自愈', () => {
  it('watchdog 补处理停机期间到期的任务并重设 alarm', async () => {
    // 用跨年 cron + 固定锚点回拨，避免「最近槽位正好落在 60s 容差内」导致期望次数抖动
    const job = unwrapResult(
      await stub.createJob(cronJob({ cron: YEARLY_CRON, policies: { misfire: 'fire_all' } })),
    )

    await backdateNextRunAt(job.id, YEARLY_ANCHOR)
    const expected = yearlySlotsUntilNow()
    expect(expected.length).toBeGreaterThanOrEqual(2)

    const scheduled = await worker.scheduled({
      cron: '0 * * * *',
      scheduledTime: new Date(),
    })

    expect(scheduled.outcome).toBe('ok')

    const rows = await executionsOf(job.id)
    expect(rows.length).toBeGreaterThanOrEqual(expected.length)
    expect(rows.slice(0, expected.length).map((row) => row.scheduled_for)).toEqual(expected)
    expect(rows.every((row) => row.trigger === 'schedule')).toBe(true)

    const refreshed = unwrapResult(await stub.getJob({ jobId: job.id }))
    expect(refreshed!.nextRunAt!).toBeGreaterThan(Date.now())
  })
})
