import { DurableObject } from 'cloudflare:workers'

import { createCronSchedule, type CronSchedule } from '../cron'
import type { Env } from '../env'
import { ok, toFailure, WakerError } from './errors'
import {
  MAX_NAME_LENGTH,
  buildSchedule,
  decodeCursor,
  describeRef,
  encodeCursor,
  normalizeLimit,
  normalizePayload,
  requireString,
  resolvePolicies,
  toEpochMs,
} from './input'
import { MAX_CATCH_UP_OCCURRENCES, jitterOffsetMs, planOccurrences } from './policies'
import { migrate } from './schema'
import type {
  ConcurrencyPolicy,
  CreateJobInput,
  DispatchItem,
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
  SyncAlarmResult,
  WakerResult,
} from './types'

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
  pending: DispatchItem[]
}

/**
 * WakerDO —— 任务真源（SQLite 后端），全平台唯一实例。
 *
 * 职责（B2 范围）：
 *   - SQLite 数据模型与迁移（jobs / executions / dead_letters / projects / signing_keys）
 *   - 任务生命周期 RPC（create / cancel / pause / resume / manual-trigger / query）
 *   - alarm 自愈：每次 tick 都取全部 `next_run_at <= now` 的任务、按 misfire 策略补跑、
 *     推进下一次 `next_run_at`，再按「最早到期」重设 `setAlarm`
 *
 * 不在本单：把执行记录投递到 Queue、回调签名与执行结果回收（B3）；
 * 注册 API / 凭据管理（B4）。投递接缝固定为 `#dispatchPending`，B3 只换它的实现。
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

    const timezone = input.timezone === undefined ? 'UTC' : requireString(input.timezone, 'timezone')
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

    this.#dispatchPending([item])
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
        // 已进入「无下次执行」区间：NULL 区间内按 id 续页，非 NULL 区间不会再有。
        where.push(`((next_run_at IS NULL AND id > ?) OR next_run_at IS NOT NULL)`)
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

    this.#dispatchPending(outcome.pending)

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
      pending: [],
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

        outcome.pending.push(
          this.#insertExecution({
            job,
            scheduledFor: decision.scheduledFor,
            trigger: 'schedule',
            misfire: decision.misfire,
            status: 'pending',
            payload: JSON.parse(job.payload) as JsonValue,
            now,
          }),
        )
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
         skip_reason, attempt, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
   * 分发接缝 —— **B3 的唯一扩展点**。
   *
   * B2 明确不写 Queue 分发与回调执行，所以这里不投递，执行记录留在 `pending`：
   * 这是「待投递」的显式状态，不是丢失。
   *
   * B3 在这里：`env.WAKER_QUEUE.sendBatch(items.map(...), { delaySeconds })`
   * （delay = max(0, ceil((dispatchAt - now) / 1000))，抖动靠 Queue 原生 delaySeconds 表达），
   * 投递成功后把 `executions.status` 推进到 `dispatched`。
   */
  #dispatchPending(_pending: DispatchItem[]): void {
    // TODO(B3)：投递 WAKER_QUEUE 并推进执行状态。
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
