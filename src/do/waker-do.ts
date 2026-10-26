import { DurableObject } from 'cloudflare:workers'

import { MAX_SELF_RENEWAL_HORIZON_MS, resolveCallbackUrl } from '../callback/protocol'
import { createCronSchedule, type CronSchedule } from '../cron'
import type { Env, JobMessage } from '../env'
import { queueDelaySeconds, retryDelaySeconds } from '../queue/backoff'
import { ok, toFailure, WakerError } from './errors'
import {
  MAX_NAME_LENGTH,
  buildSchedule,
  decodeCursor,
  describeRef,
  encodeCursor,
  normalizeLimit,
  normalizePayload,
  requireNonNegativeInt,
  requireString,
  resolvePolicies,
  resolveTimezone,
  toEpochMs,
} from './input'
import { MAX_CATCH_UP_OCCURRENCES, jitterOffsetMs, planOccurrences } from './policies'
import { migrate } from './schema'
import type {
  CallbackTargetView,
  ConcurrencyPolicy,
  CreateJobInput,
  DeadLetterInput,
  DeadLetterView,
  DispatchItem,
  ExecutionCallbackContext,
  ExecutionStatus,
  ExecutionTrigger,
  JobKind,
  JobRef,
  JobStatus,
  JobView,
  JsonValue,
  ListJobsQuery,
  ListJobsResult,
  ManualTriggerInput,
  ManualTriggerResult,
  MisfirePolicy,
  PrepareExecutionInput,
  PrepareExecutionResult,
  PrepareSkipReason,
  RecordExecutionInput,
  RecordExecutionResult,
  RenewalOutcome,
  RenewalRejectionReason,
  ReplayDeadLetterInput,
  ReplayDeadLetterResult,
  SyncAlarmResult,
  WakerResult,
} from './types'

/** 一次最多投递多少条 pending 执行（建批，减少 Queue 操作数）；其余下一批继续。 */
const DISPATCH_BATCH_LIMIT = 100

/** 每轮 tick 最多走几批（防一次 tick 无限打 Queue；剩余留到下一次 tick / watchdog）。 */
const MAX_DISPATCH_ROUNDS = 10

/**
 * 执行租约宽限：`running` 的执行超过 `timeoutSeconds + 60s` 仍未回填结果，
 * 视为 consumer 崩了（消息已被平台重新投递），允许新消息重新认领同一次执行。
 */
const EXECUTION_LEASE_GRACE_MS = 60_000

/** 死信/执行记录里错误文本的存储上限。 */
const MAX_ERROR_LENGTH = 1000

/** jobs 表行（列名与 SQL 一一对应；索引签名是 SqlStorage 的行约束）。 */
interface JobRow extends Record<string, string | number | null> {
  id: string
  project_id: string
  name: string
  kind: string
  cron_expression: string | null
  cron_normalized: string | null
  timezone: string
  run_at: number | null
  payload: string
  misfire_policy: string
  concurrency_policy: string
  max_retries: number
  backoff_seconds: number
  timeout_seconds: number
  jitter_seconds: number
  status: string
  next_run_at: number | null
  last_run_at: number | null
  created_at: number
  updated_at: number
}

/** executions 表行。 */
interface ExecutionRow extends Record<string, string | number | null> {
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
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  response_status: number | null
  error: string | null
  created_at: number
  payload: string | null
  signing_key_id: string | null
  renewal_at: number | null
  renewal_error: string | null
}

interface InsertExecutionParams {
  job: JobRow
  scheduledFor: number
  trigger: ExecutionTrigger
  misfire: boolean
  status: ExecutionStatus
  skipReason?: string
  payload: JsonValue
  now: number
}

interface TickOutcome {
  dueJobs: number
  createdExecutions: number
  skippedExecutions: number
}

/**
 * WakerDO —— 任务真源（SQLite 后端），全平台唯一实例。
 *
 * 职责：
 *   - SQLite 数据模型与迁移（jobs / executions / dead_letters / projects / signing_keys）
 *   - 任务生命周期 RPC（create / cancel / pause / resume / manual-trigger / query）
 *   - alarm 自愈：每次 tick 都取全部 `next_run_at <= now` 的任务、按 misfire 策略补跑、
 *     推进下一次 `next_run_at`，再按「最早到期」重设 `setAlarm`
 *   - **B3 执行引擎**：把 pending 执行投递到 Queue（`#dispatchPending`）、给 consumer 发
 *     「回调材料」（含 signing key，见 `prepareExecution`）、回填执行结果并处理自续
 *     （`recordExecutionResult`）、落死信并支持重放（`recordDeadLetter` / `replayDeadLetter`）
 *
 * 不在本单：注册 API / 凭据管理（B4）。
 *
 * 存储硬约束：真源只在这里（this.ctx.storage.sql），不引入 D1 / KV。
 */
export class WakerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 幂等迁移：DO 每个实例唤醒时都跑一遍，版本已到位时是空操作。
    migrate(ctx.storage.sql)
  }

  // ───────────────────────── Durable Object 生命周期 ─────────────────────────

  /** alarm 到期：取全部到期任务执行，并重算下一个 alarm。 */
  override async alarm(): Promise<void> {
    await this.#runTick(Date.now())
  }

  // ───────────────────────── 生命周期 RPC（冻结契约） ─────────────────────────

  /** 创建任务（cron 或 one_shot）。 */
  async createJob(input: CreateJobInput): Promise<WakerResult<JobView>> {
    try {
      return ok(await this.#createJob(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #createJob(input: CreateJobInput): Promise<JobView> {
    const now = Date.now()
    const sql = this.ctx.storage.sql

    const projectId = requireString(input?.projectId, 'projectId')
    const name = requireString(input?.name, 'name')
    if (name.length > MAX_NAME_LENGTH) {
      throw new WakerError('invalid_argument', `name 最长 ${MAX_NAME_LENGTH} 字符`)
    }

    const kind = input.kind
    if (kind !== 'cron' && kind !== 'one_shot') {
      throw new WakerError('invalid_argument', "kind 必须是 'cron' 或 'one_shot'")
    }

    const timezone = resolveTimezone(input.timezone)
    const payload = normalizePayload(input.payload)
    const policies = resolvePolicies(input.policies)
    const enabled = input.enabled !== false

    let schedule: CronSchedule | null = null
    let cronExpression: string | null = null
    let cronNormalized: string | null = null
    let runAt: number | null = null

    if (kind === 'cron') {
      const rawCron = requireString(input.cron, 'cron')
      schedule = buildSchedule(rawCron, timezone)
      cronExpression = schedule.expression
      cronNormalized = schedule.normalized
    } else {
      runAt = toEpochMs(input.runAt)
    }

    const duplicate = sql
      .exec<{ id: string }>('SELECT id FROM jobs WHERE project_id = ? AND name = ? LIMIT 1', projectId, name)
      .toArray()
    if (duplicate.length > 0) {
      throw new WakerError('duplicate_job', `项目 ${projectId} 下已存在同名任务：${name}`)
    }

    const status: JobStatus = enabled ? 'active' : 'paused'
    const nextRunAt = enabled ? (schedule ? schedule.nextAfter(now) : runAt) : null
    const id = crypto.randomUUID()

    sql.exec(
      `INSERT INTO jobs (
         id, project_id, name, kind, cron_expression, cron_normalized, timezone, run_at, payload,
         misfire_policy, concurrency_policy, max_retries, backoff_seconds, timeout_seconds, jitter_seconds,
         status, next_run_at, last_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id,
      projectId,
      name,
      kind,
      cronExpression,
      cronNormalized,
      timezone,
      runAt,
      JSON.stringify(payload),
      policies.misfire,
      policies.concurrency,
      policies.maxRetries,
      policies.backoffSeconds,
      policies.timeoutSeconds,
      policies.jitterSeconds,
      status,
      nextRunAt,
      now,
      now,
    )

    await this.#rescheduleAlarm()
    return this.#requireView({ jobId: id })
  }

  /** 取消任务（终态）：不再进调度，历史执行记录保留。 */
  async cancelJob(ref: JobRef): Promise<WakerResult<JobView>> {
    try {
      return ok(await this.#cancelJob(ref))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #cancelJob(ref: JobRef): Promise<JobView> {
    const now = Date.now()
    const row = this.#requireJobRow(ref)

    if (row.status === 'cancelled') return this.#toView(row)

    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'cancelled', next_run_at = NULL, updated_at = ? WHERE id = ?`,
      now,
      row.id,
    )

    await this.#rescheduleAlarm()
    return this.#requireView({ jobId: row.id })
  }

  /** 暂停任务：撤出调度；cron 恢复后从「当前时刻之后的下一个槽位」继续（不补暂停期间）。 */
  async pauseJob(ref: JobRef): Promise<WakerResult<JobView>> {
    try {
      return ok(await this.#pauseJob(ref))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #pauseJob(ref: JobRef): Promise<JobView> {
    const now = Date.now()
    const row = this.#requireJobRow(ref)

    if (row.status === 'cancelled') {
      throw new WakerError('job_cancelled', `任务已取消，无法暂停：${row.id}`)
    }
    if (row.status === 'completed') {
      throw new WakerError('job_not_resumable', `任务已执行完毕，无法暂停：${row.id}`)
    }
    if (row.status === 'paused') return this.#toView(row)

    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ?`,
      now,
      row.id,
    )

    await this.#rescheduleAlarm()
    return this.#requireView({ jobId: row.id })
  }

  /** 恢复任务：重新计算下一次执行时刻并入队调度。 */
  async resumeJob(ref: JobRef): Promise<WakerResult<JobView>> {
    try {
      return ok(await this.#resumeJob(ref))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #resumeJob(ref: JobRef): Promise<JobView> {
    const now = Date.now()
    const row = this.#requireJobRow(ref)

    if (row.status === 'cancelled') {
      throw new WakerError('job_cancelled', `任务已取消，无法恢复：${row.id}`)
    }
    if (row.status === 'completed') {
      throw new WakerError('job_not_resumable', `one-shot 任务已执行完毕，无法恢复：${row.id}`)
    }
    if (row.status === 'active') return this.#toView(row)

    const nextRunAt =
      row.kind === 'one_shot' ? row.run_at : this.#cronSchedule(row).nextAfter(now)

    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`,
      nextRunAt,
      now,
      row.id,
    )

    await this.#rescheduleAlarm()
    return this.#requireView({ jobId: row.id })
  }

  /**
   * 手动触发一次：不改动周期调度，只新增一条 immediate 执行记录。
   * 已取消的任务不可手动触发；已执行完的 one-shot 允许再次触发（重放语义）。
   */
  async manualTrigger(input: ManualTriggerInput): Promise<WakerResult<ManualTriggerResult>> {
    try {
      return ok(await this.#manualTrigger(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #manualTrigger(input: ManualTriggerInput): Promise<ManualTriggerResult> {
    const now = Date.now()
    const row = this.#requireJobRow(input)

    if (row.status === 'cancelled') {
      throw new WakerError('job_cancelled', `任务已取消，无法手动触发：${row.id}`)
    }

    const payload =
      input.payload === undefined ? (JSON.parse(row.payload) as JsonValue) : normalizePayload(input.payload)

    const item = this.#insertExecution({
      job: row,
      scheduledFor: now,
      trigger: 'manual',
      misfire: false,
      status: 'pending',
      payload,
      now,
    })

    await this.#dispatchPending(now)
    await this.#rescheduleAlarm()

    return {
      jobId: item.jobId,
      executionId: item.executionId,
      scheduledFor: item.scheduledFor,
      dispatchAt: item.dispatchAt,
    }
  }

  /** 查询单个任务；不存在返回 null（不用抛错表达「没有」）。 */
  async getJob(ref: JobRef): Promise<WakerResult<JobView | null>> {
    try {
      const row = this.#findJobRow(ref)
      return ok(row === null ? null : this.#toView(row))
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 分页查询任务，按 `next_run_at` 升序（无下次执行的排最后），再按 id 稳定排序。 */
  async listJobs(query: ListJobsQuery = {}): Promise<WakerResult<ListJobsResult>> {
    try {
      return ok(this.#listJobs(query))
    } catch (error) {
      return toFailure(error)
    }
  }

  #listJobs(query: ListJobsQuery): ListJobsResult {
    const sql = this.ctx.storage.sql
    const limit = normalizeLimit(query.limit)

    const where: string[] = []
    const bindings: (string | number | null)[] = []

    if (query.projectId !== undefined) {
      where.push('project_id = ?')
      bindings.push(requireString(query.projectId, 'projectId'))
    }
    if (query.status !== undefined) {
      where.push('status = ?')
      bindings.push(requireString(query.status, 'status'))
    }
    if (query.kind !== undefined) {
      where.push('kind = ?')
      bindings.push(requireString(query.kind, 'kind'))
    }

    if (query.cursor !== undefined && query.cursor !== null) {
      const cursor = decodeCursor(query.cursor)
      if (cursor.nextRunAt === null) {
        // 已进入「无下次执行」区间：只在该区间内按 id 续页。
        // 不能再 OR 出非 NULL 行，否则每页都会从头返回第 1 页、翻页死循环。
        where.push(`next_run_at IS NULL AND id > ?`)
        bindings.push(cursor.id)
      } else {
        // 非 NULL 区间之后还有「无下次执行」的 NULL 区间（排序里排在最后），一并接上。
        where.push(
          `(next_run_at IS NULL OR next_run_at > ? OR (next_run_at = ? AND id > ?))`,
        )
        bindings.push(cursor.nextRunAt, cursor.nextRunAt, cursor.id)
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = sql
      .exec<JobRow>(
        `SELECT * FROM jobs ${whereSql}
         ORDER BY next_run_at IS NULL, next_run_at, id
         LIMIT ?`,
        ...bindings,
        limit + 1,
      )
      .toArray()

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ nextRunAt: last.next_run_at, id: last.id })
        : null

    return { jobs: page.map((row) => this.#toView(row)), nextCursor }
  }

  /**
   * alarm 自愈入口：watchdog（全仓唯一 Cron Trigger，每小时）调用。
   *
   * 先处理一次「已经到期但没被 alarm 处理」的任务（alarm 丢失 / 部署漂移时的补发），
   * 再按最早到期重设 alarm。返回本次实际处理量，供 watchdog 记日志。
   */
  async syncAlarm(): Promise<WakerResult<SyncAlarmResult>> {
    try {
      return ok(await this.#runTick(Date.now()))
    } catch (error) {
      return toFailure(error)
    }
  }

  // ───────────────────────── 内部：tick / 调度 ─────────────────────────

  async #runTick(now: number): Promise<SyncAlarmResult> {
    const outcome = this.ctx.storage.transactionSync(() => this.#materializeDue(now))

    await this.#dispatchPending(now)

    const pendingDispatches = Number(
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM executions WHERE status = 'pending'`)
        .one().n,
    )

    const nextWakeAt = await this.#rescheduleAlarm()

    return {
      now,
      dueJobs: outcome.dueJobs,
      createdExecutions: outcome.createdExecutions,
      skippedExecutions: outcome.skippedExecutions,
      pendingDispatches,
      nextWakeAt,
    }
  }

  /** 单个事务内完成：到期任务 → 执行记录 → 推进 next_run_at。 */
  #materializeDue(now: number): TickOutcome {
    const sql = this.ctx.storage.sql
    const outcome: TickOutcome = {
      dueJobs: 0,
      createdExecutions: 0,
      skippedExecutions: 0,
    }

    // 天然回看补发：凡是 `next_run_at <= now` 的都算到期，不依赖「当前这一分钟」匹配。
    const dueJobs = sql
      .exec<JobRow>(
        `SELECT * FROM jobs
         WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at, id`,
        now,
      )
      .toArray()

    if (dueJobs.length === 0) return outcome

    outcome.dueJobs = dueJobs.length
    const inflight = this.#inflightJobIds(dueJobs)

    for (const job of dueJobs) {
      const slots = this.#dueSlots(job, now)
      const decisions = planOccurrences(job.misfire_policy as MisfirePolicy, slots, now)
      const blocked = job.concurrency_policy === 'forbid' && inflight.has(job.id)

      for (const decision of decisions) {
        if (blocked) {
          this.#insertExecution({
            job,
            scheduledFor: decision.scheduledFor,
            trigger: 'schedule',
            misfire: decision.misfire,
            status: 'skipped',
            skipReason: 'concurrency_policy_forbid',
            payload: JSON.parse(job.payload) as JsonValue,
            now,
          })
          outcome.skippedExecutions += 1
          continue
        }

        this.#insertExecution({
          job,
          scheduledFor: decision.scheduledFor,
          trigger: 'schedule',
          misfire: decision.misfire,
          status: 'pending',
          payload: JSON.parse(job.payload) as JsonValue,
          now,
        })
        outcome.createdExecutions += 1
      }

      const lastDecision = decisions.at(-1)
      const nextRunAt = job.kind === 'one_shot' ? null : this.#cronSchedule(job).nextAfter(now)
      const status: JobStatus = job.kind === 'one_shot' ? 'completed' : 'active'

      sql.exec(
        `UPDATE jobs SET next_run_at = ?, status = ?, last_run_at = ?, updated_at = ? WHERE id = ?`,
        nextRunAt,
        status,
        lastDecision === undefined ? job.last_run_at : lastDecision.scheduledFor,
        now,
        job.id,
      )
    }

    return outcome
  }

  /** 本次 tick 涉及的任务里，哪些还有未完成的执行（并发策略 `forbid` 用）。 */
  #inflightJobIds(jobs: readonly JobRow[]): Set<string> {
    if (jobs.length === 0) return new Set()
    const placeholders = jobs.map(() => '?').join(', ')
    const rows = this.ctx.storage.sql
      .exec<{ job_id: string }>(
        `SELECT DISTINCT job_id FROM executions
         WHERE job_id IN (${placeholders}) AND status IN ('pending', 'dispatched', 'running')`,
        ...jobs.map((job) => job.id),
      )
      .toArray()
    return new Set(rows.map((row) => row.job_id))
  }

  /** 从 `next_run_at` 起枚举所有已到期槽位（含截断保护）。 */
  #dueSlots(job: JobRow, now: number): number[] {
    const nextRunAt = job.next_run_at
    if (nextRunAt === null) return []

    if (job.kind === 'one_shot') return nextRunAt <= now ? [nextRunAt] : []

    const schedule = this.#cronSchedule(job)
    const slots: number[] = []
    let cursor = nextRunAt - 1

    while (slots.length < MAX_CATCH_UP_OCCURRENCES) {
      const next = schedule.nextAfter(cursor)
      if (next === null || next > now) return slots
      slots.push(next)
      cursor = next
    }

    // 积压超过上限：改为从 now 往前回walk，保留最近的若干次，把最老的丢掉。
    const clipped: number[] = []
    let previous = schedule.previousBefore(now + 1)
    while (
      clipped.length < MAX_CATCH_UP_OCCURRENCES &&
      previous !== null &&
      previous >= nextRunAt
    ) {
      clipped.push(previous)
      previous = schedule.previousBefore(previous)
    }
    return clipped.reverse()
  }

  #cronSchedule(job: JobRow): CronSchedule {
    if (job.cron_expression === null) {
      throw new WakerError('internal', `任务 ${job.id} 是 cron 类型但缺少表达式`)
    }
    try {
      return createCronSchedule(job.cron_expression, { timezone: job.timezone })
    } catch (error) {
      // 库内表达式本应在写入时校验过；走到这里说明数据被绕过入口改动。
      throw new WakerError('internal', `任务 ${job.id} 的 cron 表达式无法计算：${String(error)}`)
    }
  }

  #insertExecution(params: InsertExecutionParams): DispatchItem {
    const { job, scheduledFor, trigger, misfire, status, skipReason, payload, now } = params
    const id = crypto.randomUUID()
    const dispatchAt =
      trigger === 'manual'
        ? scheduledFor
        : scheduledFor + jitterOffsetMs(job.id, scheduledFor, job.jitter_seconds)

    this.ctx.storage.sql.exec(
      `INSERT INTO executions (
         id, job_id, project_id, scheduled_for, dispatch_at, trigger, misfire, status,
         skip_reason, attempt, created_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id,
      job.id,
      job.project_id,
      scheduledFor,
      dispatchAt,
      trigger,
      misfire ? 1 : 0,
      status,
      skipReason ?? null,
      now,
      JSON.stringify(payload),
    )

    return {
      executionId: id,
      jobId: job.id,
      projectId: job.project_id,
      scheduledFor,
      dispatchAt,
      trigger,
      misfire,
      attempt: 0,
      payload,
      timeoutSeconds: job.timeout_seconds,
      maxRetries: job.max_retries,
      backoffSeconds: job.backoff_seconds,
    }
  }

  /**
   * 分发：把 `status = 'pending'` 的执行推入主 Queue，并将状态推进到 `dispatched`。
   *
   * 两个设计取舍：
   *   1. **以库为准**（扫 pending 而不是只投本轮新建的那几条）：消费者崩溃 / 投递失败 /
   *      DO 在“发出但未落状态”之间被驱逐，都能被下一 tick 或 watchdog 自然补回，不丢消息。
   *   2. **按 delaySeconds 分组 + sendBatch**：抖动与重试退避全用 Queue 原生 `delaySeconds`，
   *      不自己 sleep、不靠 DO 定时器；同 delay 的合并成批，减少 Queue 操作数（免费额度口径）。
   *
   * at-least-once 的双投由 consumer 侧幂等阁掉：认领时 `pending/dispatched → running`
   * 只能成功一次，重复消息会被判 `in_flight` / `already_handled` 直接 ack。
   */
  async #dispatchPending(now: number): Promise<void> {
    const sql = this.ctx.storage.sql

    // 分批投递：积压超过一批时继续下一批（上限 10 批），避免大量任务同时到期时只投出前 100 条
    // 却要等到下一次 tick 才继续。
    for (let round = 0; round < MAX_DISPATCH_ROUNDS; round += 1) {
      const rows = sql
        .exec<ExecutionRow>(
          `SELECT * FROM executions WHERE status = 'pending' ORDER BY dispatch_at, id LIMIT ?`,
          DISPATCH_BATCH_LIMIT,
        )
        .toArray()

      if (rows.length === 0) return

      const groups = new Map<number, ExecutionRow[]>()
      for (const row of rows) {
        const delay = queueDelaySeconds(row.dispatch_at, now)
        const group = groups.get(delay)
        if (group === undefined) groups.set(delay, [row])
        else group.push(row)
      }

      for (const [delaySeconds, group] of groups) {
        const messages: MessageSendRequest<JobMessage>[] = group.map((row) => ({
          body: {
            executionId: row.id,
            jobId: row.job_id,
            projectId: row.project_id,
            attempt: row.attempt,
          },
        }))

        try {
          await this.env.WAKER_QUEUE.sendBatch(messages, { delaySeconds })
        } catch (error) {
          // 投递失败：保持 pending，等下一次 tick / watchdog 重试（不丢任务）。
          console.error(
            `[dispatch] 投递 Queue 失败（${group.length} 条，delay=${delaySeconds}s），保留 pending 等重试：${String(error)}`,
          )
          continue
        }

        const placeholders = group.map(() => '?').join(', ')
        sql.exec(
          `UPDATE executions SET status = 'dispatched' WHERE status = 'pending' AND id IN (${placeholders})`,
          ...group.map((row) => row.id),
        )
      }

      if (rows.length < DISPATCH_BATCH_LIMIT) return
    }
  }

  // ───────────────────────── 执行引擎 RPC（B3，consumer 专用） ─────────────────────────

  /**
   * consumer 认领一次执行，拿到回调所需的一切（任务信息 + 下游地址 + signing key）。
   *
   * 幂等与并发策略都在这里用库状态做原子判定（DO 单线程 + 同步 SQL，天然无竞态）：
   *   - `pending` / `dispatched` → 可执行（`pending` 说明“已发消息但状态未回写”，仍应跑）；
   *   - `running` 且租约未过 → `in_flight`（重复投递，ack 掉）；租约过期 → 重新认领；
   *   - `succeeded` / `dead` / `skipped` → `already_handled`；
   *   - `concurrencyPolicy = forbid` 且同任务的另一条执行在跑 → 本次记 `skipped`。
   */
  async prepareExecution(
    input: PrepareExecutionInput,
  ): Promise<WakerResult<PrepareExecutionResult>> {
    try {
      return ok(await this.#prepareExecution(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #prepareExecution(input: PrepareExecutionInput): Promise<PrepareExecutionResult> {
    const now = Date.now()
    const executionId = requireString(input?.executionId, 'executionId')
    const attempt = requireNonNegativeInt(input?.attempt, 'attempt')
    const row = this.#requireExecutionRow(executionId)
    const job = this.#requireJobRow({ jobId: row.job_id })

    const skip = (
      reason: PrepareSkipReason,
      executionStatus: ExecutionStatus = row.status as ExecutionStatus,
    ): PrepareExecutionResult => ({
      outcome: 'skip',
      reason,
      context: null,
      target: null,
      executionStatus,
    })

    // 先判 attempt：过期的重试消息比「已经成功」更精确（前端要能看出是被丢弃的旧消息）。
    if (attempt !== row.attempt) return skip('stale_attempt')

    if (
      row.status === 'succeeded' ||
      row.status === 'dead' ||
      row.status === 'skipped' ||
      row.status === 'failed'
    ) {
      return skip('already_handled')
    }

    if (row.status === 'running') {
      const startedAt = row.started_at ?? 0
      const leaseMs = job.timeout_seconds * 1000 + EXECUTION_LEASE_GRACE_MS
      if (now - startedAt <= leaseMs) return skip('in_flight')
    }

    if (job.status === 'cancelled') {
      this.#markExecutionSkipped(row.id, 'job_cancelled', now)
      return skip('job_not_active', 'skipped')
    }

    if (job.concurrency_policy === 'forbid') {
      const inFlight = this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM executions
           WHERE job_id = ? AND id <> ? AND status = 'running' LIMIT 1`,
          job.id,
          row.id,
        )
        .toArray()
      if (inFlight.length > 0) {
        this.#markExecutionSkipped(row.id, 'concurrency_policy_forbid', now)
        return skip('concurrency_policy_forbid', 'skipped')
      }
    }

    const target = this.#resolveCallbackTarget(job)

    this.ctx.storage.sql.exec(
      `UPDATE executions SET status = 'running', started_at = ?, attempt = ?, signing_key_id = ? WHERE id = ?`,
      now,
      attempt,
      target.signingKeyId,
      row.id,
    )

    const context: ExecutionCallbackContext = {
      executionId: row.id,
      jobId: job.id,
      projectId: job.project_id,
      jobName: job.name,
      kind: job.kind as JobKind,
      trigger: row.trigger as ExecutionTrigger,
      misfire: row.misfire === 1,
      attempt,
      scheduledFor: row.scheduled_for,
      dispatchedAt: now,
      timeoutSeconds: job.timeout_seconds,
      // 优先用这条执行自己的载荷快照（manualTrigger 覆盖 / 死信重放），旧记录回落到任务载荷。
      payload: JSON.parse(row.payload ?? job.payload) as JsonValue,
    }

    return { outcome: 'run', reason: null, context, target, executionStatus: 'running' }
  }

  /**
   * 回填执行结果（consumer 调用）：成功 → 自续；失败 → 按 maxRetries/backoff 重试或判死。
   *
   * 重试经 Queue 原生 `delaySeconds` 重新入队（由 `#dispatchPending` 把 status 改回 pending 后完成），
   * 因此**不需要 consumer 自己重发消息**：重试计划全在库里，崩溃也不丢。
   */
  async recordExecutionResult(
    input: RecordExecutionInput,
  ): Promise<WakerResult<RecordExecutionResult>> {
    try {
      return ok(await this.#recordExecutionResult(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #recordExecutionResult(input: RecordExecutionInput): Promise<RecordExecutionResult> {
    const now = Date.now()
    const sql = this.ctx.storage.sql
    const executionId = requireString(input?.executionId, 'executionId')
    const attempt = requireNonNegativeInt(input?.attempt, 'attempt')
    const row = this.#requireExecutionRow(executionId)
    const job = this.#requireJobRow({ jobId: row.job_id })

    const noRenewal = (reason: RenewalRejectionReason): RenewalOutcome => ({
      applied: false,
      nextRunAt: null,
      reason,
    })

    if (
      row.status === 'succeeded' ||
      row.status === 'dead' ||
      row.status === 'skipped'
    ) {
      return {
        executionId,
        status: row.status as ExecutionStatus,
        attempt: row.attempt,
        retryScheduled: false,
        retryAt: null,
        renewal: noRenewal('already_finalized'),
      }
    }

    if (attempt !== row.attempt) {
      return {
        executionId,
        status: row.status as ExecutionStatus,
        attempt: row.attempt,
        retryScheduled: false,
        retryAt: null,
        renewal: noRenewal('stale_attempt'),
      }
    }

    const errorText =
      input.error === undefined || input.error === null || input.error === ''
        ? null
        : String(input.error).slice(0, MAX_ERROR_LENGTH)
    const httpStatus = input.httpStatus === undefined || input.httpStatus === null ? null : input.httpStatus

    if (input.ok) {
      sql.exec(
        `UPDATE executions
         SET status = 'succeeded', finished_at = ?, duration_ms = ?, response_status = ?, error = NULL
         WHERE id = ?`,
        input.finishedAt,
        input.durationMs,
        httpStatus,
        executionId,
      )

      let renewal: RenewalOutcome
      if (job.kind === 'one_shot') {
        renewal = await this.#applyRenewal(job, row, input.nextRunAt, now)
      } else {
        // cron 任务不参与自续：下游声明了也拒（落库留痕，避免「以为续上了」）。
        renewal = noRenewal('job_not_self_renewable')
        if (input.nextRunAt !== undefined && input.nextRunAt !== null) {
          sql.exec(
            `UPDATE executions SET renewal_error = 'job_not_self_renewable' WHERE id = ?`,
            executionId,
          )
        }
      }

      return {
        executionId,
        status: 'succeeded',
        attempt,
        retryScheduled: false,
        retryAt: null,
        renewal,
      }
    }

    // 平台侧配置类错误（缺 signing key / 缺 callback_url）走不到这里：它们在认领阶段就被
    // 判为不可执行并直接进死信（见 consumer），不会用同一必败原因刷队列。
    const canRetry = attempt < job.max_retries
    if (!canRetry) {
      sql.exec(
        `UPDATE executions
         SET status = 'dead', finished_at = ?, duration_ms = ?, response_status = ?, error = ?
         WHERE id = ?`,
        input.finishedAt,
        input.durationMs,
        httpStatus,
        errorText,
        executionId,
      )
      return {
        executionId,
        status: 'dead',
        attempt,
        retryScheduled: false,
        retryAt: null,
        renewal: noRenewal('not_requested'),
      }
    }

    const retryDelay = retryDelaySeconds(job.backoff_seconds, attempt)
    const retryAt = now + retryDelay * 1000

    sql.exec(
      `UPDATE executions
       SET status = 'pending', attempt = ?, dispatch_at = ?, started_at = NULL,
           finished_at = ?, duration_ms = ?, response_status = ?, error = ?
       WHERE id = ?`,
      attempt + 1,
      retryAt,
      input.finishedAt,
      input.durationMs,
      httpStatus,
      errorText,
      executionId,
    )

    await this.#dispatchPending(now)

    return {
      executionId,
      status: 'pending',
      attempt: attempt + 1,
      retryScheduled: true,
      retryAt,
      renewal: noRenewal('not_requested'),
    }
  }

  /**
   * 死信落库（DLQ consumer 调用）：`dead_letters` 按 `execution_id` 唯一，重复投递幂等。
   *
   * DLQ 里可能有两种消息：平台自己转来的（带 error/attempts），以及 CF 在
   * `max_retries` 耗完后自动投递的原始 JobMessage（只有 executionId）——后者从执行记录里补全。
   */
  async recordDeadLetter(input: DeadLetterInput): Promise<WakerResult<DeadLetterView>> {
    try {
      return ok(this.#recordDeadLetter(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  #recordDeadLetter(input: DeadLetterInput): DeadLetterView {
    const now = Date.now()
    const sql = this.ctx.storage.sql
    const executionId = requireString(input?.executionId, 'executionId')
    const row = this.#requireExecutionRow(executionId)
    const job = this.#findJobRow({ jobId: row.job_id })

    const errorText = String(input.error ?? row.error ?? 'unknown_error').slice(0, MAX_ERROR_LENGTH)
    const attempts = input.attempts ?? row.attempt + 1

    sql.exec(
      `UPDATE executions
       SET status = 'dead', error = ?, finished_at = COALESCE(finished_at, ?)
       WHERE id = ? AND status IN ('pending', 'dispatched', 'running', 'failed')`,
      errorText,
      now,
      executionId,
    )

    const existing = sql
      .exec<{ id: string }>('SELECT id FROM dead_letters WHERE execution_id = ? LIMIT 1', executionId)
      .toArray()

    const id = existing[0]?.id ?? crypto.randomUUID()
    if (existing.length === 0) {
      sql.exec(
        `INSERT INTO dead_letters (
           id, execution_id, job_id, project_id, attempts, error, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        executionId,
        row.job_id,
        row.project_id,
        attempts,
        errorText,
        row.payload ?? job?.payload ?? 'null',
        now,
      )
    }

    return this.#requireDeadLetterView(id)
  }

  /** 死信重放：以同一任务新建一条 manual 执行记录，重新走 Queue → 回调。 */
  async replayDeadLetter(
    input: ReplayDeadLetterInput,
  ): Promise<WakerResult<ReplayDeadLetterResult>> {
    try {
      return ok(await this.#replayDeadLetter(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #replayDeadLetter(input: ReplayDeadLetterInput): Promise<ReplayDeadLetterResult> {
    const now = Date.now()
    const sql = this.ctx.storage.sql
    const deadLetterId = requireString(input?.deadLetterId, 'deadLetterId')

    const rows = sql
      .exec<{ id: string; job_id: string; payload: string; replayed_at: number | null }>(
        'SELECT id, job_id, payload, replayed_at FROM dead_letters WHERE id = ? LIMIT 1',
        deadLetterId,
      )
      .toArray()
    const deadLetter = rows[0]
    if (deadLetter === undefined) {
      throw new WakerError('dead_letter_not_found', `死信不存在：${deadLetterId}`)
    }

    const job = this.#requireJobRow({ jobId: deadLetter.job_id })
    if (job.status === 'cancelled') {
      throw new WakerError('job_cancelled', `任务已取消，无法重放死信：${job.id}`)
    }

    const item = this.#insertExecution({
      job,
      scheduledFor: now,
      trigger: 'manual',
      misfire: false,
      status: 'pending',
      payload: JSON.parse(deadLetter.payload) as JsonValue,
      now,
    })

    sql.exec(
      `UPDATE dead_letters SET replayed_at = ?, replayed_execution_id = ? WHERE id = ?`,
      now,
      item.executionId,
      deadLetterId,
    )

    await this.#dispatchPending(now)

    return {
      deadLetterId,
      jobId: job.id,
      executionId: item.executionId,
      scheduledFor: item.scheduledFor,
      dispatchAt: item.dispatchAt,
    }
  }

  // ────────────── 内部：自续 / 回调目标 / 执行记录 ──────────────

  /**
   * 自续：校验下游声明的 `nextRunAt` 后以**同一 job 系列**续期。
   *
   * 校验（冻结契约）：合法时间戳 → 严格晚于本次执行时刻（`now`）→ 不超出
   * {@link MAX_SELF_RENEWAL_HORIZON_MS}（366 天）上限。任一不过：续期不生效，
   * 但**本次执行仍算成功**（业务已完成），只在执行记录里留 `renewal_error`。
   */
  async #applyRenewal(
    job: JobRow,
    execution: ExecutionRow,
    rawNextRunAt: number | string | null | undefined,
    now: number,
  ): Promise<RenewalOutcome> {
    const reject = (reason: RenewalRejectionReason): RenewalOutcome => {
      // `not_requested` 是常态（任务就此完结），不算「被拒」，不落库避免污染执行记录。
      if (reason !== 'not_requested') {
        this.ctx.storage.sql.exec(
          `UPDATE executions SET renewal_error = ? WHERE id = ?`,
          reason,
          execution.id,
        )
      }
      return { applied: false, nextRunAt: null, reason }
    }

    if (rawNextRunAt === undefined || rawNextRunAt === null) return reject('not_requested')
    if (job.status === 'cancelled') return reject('job_cancelled')
    // 手动暂停的任务不因下游自续而复活：续期是业务节律，暂停是运营意图，后者优先。
    if (job.status === 'paused') return reject('job_not_active')

    let nextRunAt: number
    try {
      nextRunAt = toEpochMs(rawNextRunAt)
    } catch {
      return reject('invalid_next_run_at')
    }

    if (nextRunAt <= now) return reject('next_run_at_not_future')
    if (nextRunAt > now + MAX_SELF_RENEWAL_HORIZON_MS) return reject('next_run_at_too_far')

    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'active', run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      nextRunAt,
      nextRunAt,
      now,
      job.id,
    )
    this.ctx.storage.sql.exec(
      `UPDATE executions SET renewal_at = ?, renewal_error = NULL WHERE id = ?`,
      nextRunAt,
      execution.id,
    )

    await this.#rescheduleAlarm()

    return { applied: true, nextRunAt, reason: null }
  }

  /** 回调目标：项目根地址 + 当前生效的 signing key（B4 建项目时填这两样）。 */
  #resolveCallbackTarget(job: JobRow): CallbackTargetView {
    const sql = this.ctx.storage.sql
    const project = sql
      .exec<{ id: string; name: string | null; callback_url: string | null }>(
        'SELECT id, name, callback_url FROM projects WHERE id = ? LIMIT 1',
        job.project_id,
      )
      .toArray()[0]

    if (project === undefined || project.callback_url === null || project.callback_url.trim() === '') {
      throw new WakerError(
        'callback_target_missing',
        `项目 ${job.project_id} 未配置 callback_url，无法回调任务 ${job.name}`,
      )
    }

    const key = sql
      .exec<{ id: string; secret: string }>(
        `SELECT id, secret FROM signing_keys
         WHERE project_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        job.project_id,
      )
      .toArray()[0]

    if (key === undefined) {
      throw new WakerError(
        'signing_key_missing',
        `项目 ${job.project_id} 没有可用的 signing key，无法签名回调`,
      )
    }

    return {
      projectId: job.project_id,
      projectName: project.name,
      callbackUrl: resolveCallbackUrl(project.callback_url),
      signingKeyId: key.id,
      signingSecret: key.secret,
    }
  }

  #markExecutionSkipped(executionId: string, reason: string, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE executions
       SET status = 'skipped', skip_reason = ?, finished_at = ?, duration_ms = 0
       WHERE id = ? AND status IN ('pending', 'dispatched', 'running')`,
      reason,
      now,
      executionId,
    )
  }

  #findExecutionRow(executionId: string): ExecutionRow | null {
    const rows = this.ctx.storage.sql
      .exec<ExecutionRow>('SELECT * FROM executions WHERE id = ? LIMIT 1', executionId)
      .toArray()
    return rows[0] ?? null
  }

  #requireExecutionRow(executionId: string): ExecutionRow {
    const row = this.#findExecutionRow(executionId)
    if (row === null) {
      throw new WakerError('execution_not_found', `执行记录不存在：${executionId}`)
    }
    return row
  }

  #requireDeadLetterView(deadLetterId: string): DeadLetterView {
    const rows = this.ctx.storage.sql
      .exec<{
        id: string
        execution_id: string
        job_id: string
        project_id: string
        attempts: number
        error: string
        payload: string
        created_at: number
        replayed_at: number | null
        replayed_execution_id: string | null
      }>('SELECT * FROM dead_letters WHERE id = ? LIMIT 1', deadLetterId)
      .toArray()

    const row = rows[0]
    if (row === undefined) {
      throw new WakerError('dead_letter_not_found', `死信不存在：${deadLetterId}`)
    }

    return {
      id: row.id,
      executionId: row.execution_id,
      jobId: row.job_id,
      projectId: row.project_id,
      attempts: row.attempts,
      error: row.error,
      payload: JSON.parse(row.payload) as JsonValue,
      createdAt: row.created_at,
      replayedAt: row.replayed_at,
      replayedExecutionId: row.replayed_execution_id,
    }
  }

  /** 重算「最早到期」并重设 alarm；返回设置后的唤醒时刻。 */
  async #rescheduleAlarm(): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec<{ t: number | null }>(
        `SELECT MIN(next_run_at) AS t FROM jobs WHERE status = 'active' AND next_run_at IS NOT NULL`,
      )
      .one()

    const nextWakeAt = row.t === null ? null : Number(row.t)
    const current = await this.ctx.storage.getAlarm()

    if (nextWakeAt === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return null
    }

    if (current === null || current !== nextWakeAt) {
      await this.ctx.storage.setAlarm(nextWakeAt)
    }
    return nextWakeAt
  }

  // ───────────────────────── 内部：读写与映射 ─────────────────────────

  #findJobRow(ref: JobRef): JobRow | null {
    if (ref === null || typeof ref !== 'object') {
      throw new WakerError('invalid_argument', '必须用 { jobId } 或 { projectId, name } 定位任务')
    }
    const sql = this.ctx.storage.sql
    if ('jobId' in ref) {
      const jobId = requireString(ref.jobId, 'jobId')
      const rows = sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ? LIMIT 1', jobId).toArray()
      return rows[0] ?? null
    }
    const projectId = requireString(ref.projectId, 'projectId')
    const name = requireString(ref.name, 'name')
    const rows = sql
      .exec<JobRow>('SELECT * FROM jobs WHERE project_id = ? AND name = ? LIMIT 1', projectId, name)
      .toArray()
    return rows[0] ?? null
  }

  #requireJobRow(ref: JobRef): JobRow {
    const row = this.#findJobRow(ref)
    if (row === null) {
      throw new WakerError('job_not_found', describeRef(ref))
    }
    return row
  }

  #requireView(ref: JobRef): JobView {
    return this.#toView(this.#requireJobRow(ref))
  }

  #toView(row: JobRow): JobView {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      kind: row.kind as JobKind,
      cron: row.cron_expression,
      cronNormalized: row.cron_normalized,
      timezone: row.timezone,
      runAt: row.run_at,
      payload: JSON.parse(row.payload) as JsonValue,
      policies: {
        misfire: row.misfire_policy as MisfirePolicy,
        concurrency: row.concurrency_policy as ConcurrencyPolicy,
        maxRetries: row.max_retries,
        backoffSeconds: row.backoff_seconds,
        timeoutSeconds: row.timeout_seconds,
        jitterSeconds: row.jitter_seconds,
      },
      status: row.status as JobStatus,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
