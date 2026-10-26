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
  decodeDeadLetterCursor,
  decodeExecutionCursor,
  describeRef,
  encodeCursor,
  encodeDeadLetterCursor,
  encodeExecutionCursor,
  normalizeLimit,
  normalizePayload,
  optionalString,
  requireEnum,
  requireNonNegativeInt,
  requireString,
  requireTimeBound,
  requireTimeRange,
  resolveCallbackBaseUrl,
  resolvePolicies,
  resolveTimezone,
  toEpochMs,
  MAX_PROJECT_NAME_LENGTH,
} from './input'
import {
  SIGNING_ALGORITHM,
  decryptSigningSecret,
  deriveSigningKeyKek,
  encryptSigningSecret,
  generateProjectToken,
  generateSigningSecret,
  hashProjectToken,
  signingSecretFingerprint,
} from './keyring'
import {
  currentSigningKeyRow,
  findProjectRow,
  findProjectRowByName,
  findProjectRowByTokenHash,
  insertProject,
  insertSigningKey,
  listProjectRows,
  projectView,
  requireProjectRow,
  revokeSigningKeys,
  updateProjectRow,
  updateProjectTokenHash,
} from './projects'
import {
  MAX_CATCH_UP_OCCURRENCES,
  jitterOffsetMs,
  planOccurrences,
  policiesEqual,
} from './policies'
import { migrate, readMeta, readSchemaVersion, writeMeta } from './schema'
import type {
  CallbackTargetView,
  ConcurrencyPolicy,
  CreateJobInput,
  CreateProjectInput,
  CreateProjectResult,
  DeadLetterInput,
  DeadLetterReplayState,
  DeadLetterView,
  DispatchItem,
  ExecutionCallbackContext,
  ExecutionStatus,
  ExecutionTrigger,
  ExecutionView,
  IssuedSigningKey,
  JobKind,
  JobPolicies,
  JobRef,
  JobStatus,
  JobView,
  JsonValue,
  ListDeadLettersQuery,
  ListDeadLettersResult,
  ListExecutionsQuery,
  ListExecutionsResult,
  ListJobsQuery,
  ListJobsResult,
  ListProjectsResult,
  ManifestJobInput,
  ManualTriggerInput,
  ManualTriggerResult,
  MisfirePolicy,
  PrepareExecutionInput,
  PrepareExecutionResult,
  PrepareSkipReason,
  ProjectAuthView,
  ProjectView,
  RecordExecutionInput,
  RecordExecutionResult,
  RenewalOutcome,
  RenewalRejectionReason,
  ReplayDeadLetterInput,
  ReplayDeadLetterResult,
  RotateProjectTokenInput,
  RotateProjectTokenResult,
  RotateSigningKeyInput,
  RotateSigningKeyResult,
  SyncAlarmResult,
  SyncManifestInput,
  SyncManifestResult,
  SystemStatusView,
  UpdateJobInput,
  UpdateProjectInput,
  VerifyProjectTokenInput,
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

/** 单次声明式清单最多接受多少个任务（防一次请求把 DO 事务撑爆）。 */
const MAX_MANIFEST_JOBS = 200

/** watchdog 账本键（系统管理页据此显示上次校正时刻）。 */
const WATCHDOG_LAST_RUN_AT = 'watchdog_last_run_at'
const WATCHDOG_LAST_DUE_JOBS = 'watchdog_last_due_jobs'

/** B6 查询 RPC 的筛选值域（与 schema 里的 CHECK 约束一致；写错就报 `invalid_argument`）。 */
const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'pending',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'dead',
  'skipped',
]
const EXECUTION_TRIGGERS: readonly ExecutionTrigger[] = ['schedule', 'manual']
const DEAD_LETTER_REPLAY_STATES: readonly DeadLetterReplayState[] = ['pending', 'replayed']

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

/** 执行记录行 + 联表取的任务名（B6 `listExecutions`）。 */
interface ExecutionListRow extends ExecutionRow {
  job_name: string | null
}

/** 死信行（B3 写入，B6 只读）。 */
interface DeadLetterRow extends Record<string, string | number | null> {
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
  /** signing key 的 KEK（惰性派生，每实例一次；不落库、不进日志）。 */
  #kek: Promise<CryptoKey> | null = null

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

    const jobId = this.#insertJobRow({
      projectId,
      name,
      kind,
      cronExpression,
      cronNormalized,
      timezone,
      runAt,
      payload,
      policies,
      status,
      nextRunAt,
      now,
    })

    await this.#rescheduleAlarm()
    return this.#requireView({ jobId })
  }

  /**
   * 插入一条任务行（`createJob` / 声明式清单对账 / 死信重放共用）。
   *
   * 只做写入与返回新 id；调用方负责唯一性校验、`next_run_at` 计算与 alarm 重算。
   */
  #insertJobRow(params: {
    projectId: string
    name: string
    kind: JobKind
    cronExpression: string | null
    cronNormalized: string | null
    timezone: string
    runAt: number | null
    payload: JsonValue
    policies: JobPolicies
    status: JobStatus
    nextRunAt: number | null
    now: number
  }): string {
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (
         id, project_id, name, kind, cron_expression, cron_normalized, timezone, run_at, payload,
         misfire_policy, concurrency_policy, max_retries, backoff_seconds, timeout_seconds, jitter_seconds,
         status, next_run_at, last_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id,
      params.projectId,
      params.name,
      params.kind,
      params.cronExpression,
      params.cronNormalized,
      params.timezone,
      params.runAt,
      JSON.stringify(params.payload),
      params.policies.misfire,
      params.policies.concurrency,
      params.policies.maxRetries,
      params.policies.backoffSeconds,
      params.policies.timeoutSeconds,
      params.policies.jitterSeconds,
      params.status,
      params.nextRunAt,
      params.now,
      params.now,
    )
    return id
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

  // ───────────────────── B6：只读查询 RPC（执行记录 / 死信） ─────────────────────

  /**
   * 分页查询执行记录，按 `scheduled_for DESC, id DESC`（最近的排最前）。
   *
   * 只读：不碰 alarm、不改任何行。
   */
  async listExecutions(
    query: ListExecutionsQuery = {},
  ): Promise<WakerResult<ListExecutionsResult>> {
    try {
      return ok(this.#listExecutions(query))
    } catch (error) {
      return toFailure(error)
    }
  }

  #listExecutions(query: ListExecutionsQuery): ListExecutionsResult {
    const sql = this.ctx.storage.sql
    const limit = normalizeLimit(query.limit)

    const jobId = optionalString(query.jobId, 'jobId')
    const projectId = optionalString(query.projectId, 'projectId')
    const status =
      query.status === undefined || query.status === null
        ? undefined
        : requireEnum(query.status, 'status', EXECUTION_STATUSES)
    const trigger =
      query.trigger === undefined || query.trigger === null
        ? undefined
        : requireEnum(query.trigger, 'trigger', EXECUTION_TRIGGERS)
    const scheduledFrom = requireTimeBound(query.scheduledFrom, 'scheduledFrom')
    const scheduledTo = requireTimeBound(query.scheduledTo, 'scheduledTo')
    requireTimeRange(scheduledFrom, scheduledTo, 'scheduledFrom', 'scheduledTo')

    const where: string[] = []
    const bindings: (string | number | null)[] = []

    if (jobId !== undefined) {
      where.push('e.job_id = ?')
      bindings.push(jobId)
    }
    if (projectId !== undefined) {
      where.push('e.project_id = ?')
      bindings.push(projectId)
    }
    if (status !== undefined) {
      where.push('e.status = ?')
      bindings.push(status)
    }
    if (trigger !== undefined) {
      where.push('e.trigger = ?')
      bindings.push(trigger)
    }
    if (scheduledFrom !== undefined) {
      where.push('e.scheduled_for >= ?')
      bindings.push(scheduledFrom)
    }
    if (scheduledTo !== undefined) {
      where.push('e.scheduled_for < ?')
      bindings.push(scheduledTo)
    }

    if (query.cursor !== undefined && query.cursor !== null) {
      const cursor = decodeExecutionCursor(query.cursor)
      // 降序 keyset：严格小于游标的 (scheduled_for, id) 才是下一页。
      // `scheduled_for` 是 NOT NULL 列，这里不存在 B2 `listJobs` 那个 NULL 区间问题；
      // id 是同一时刻多条时的稳定 tiebreak。
      where.push('(e.scheduled_for < ? OR (e.scheduled_for = ? AND e.id < ?))')
      bindings.push(cursor.scheduledFor, cursor.scheduledFor, cursor.id)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // 联表取任务名：执行记录页要直接展示「哪个任务」，否则前端得为每一行再查一次。
    const rows = sql
      .exec<ExecutionListRow>(
        `SELECT e.*, j.name AS job_name
           FROM executions e
           LEFT JOIN jobs j ON j.id = e.job_id
           ${whereSql}
          ORDER BY e.scheduled_for DESC, e.id DESC
          LIMIT ?`,
        ...bindings,
        limit + 1,
      )
      .toArray()

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor =
      rows.length > limit && last
        ? encodeExecutionCursor({ scheduledFor: last.scheduled_for, id: last.id })
        : null

    return { executions: page.map((row) => this.#toExecutionView(row)), nextCursor }
  }

  /**
   * 分页查询死信，排序：未重放优先 → `created_at DESC` → `id DESC`。
   *
   * 只读：重放动作仍归 B3 的 `replayDeadLetter`。
   */
  async listDeadLetters(
    query: ListDeadLettersQuery = {},
  ): Promise<WakerResult<ListDeadLettersResult>> {
    try {
      return ok(this.#listDeadLetters(query))
    } catch (error) {
      return toFailure(error)
    }
  }

  #listDeadLetters(query: ListDeadLettersQuery): ListDeadLettersResult {
    const sql = this.ctx.storage.sql
    const limit = normalizeLimit(query.limit)

    const jobId = optionalString(query.jobId, 'jobId')
    const projectId = optionalString(query.projectId, 'projectId')
    const replayState =
      query.replayState === undefined || query.replayState === null
        ? undefined
        : requireEnum(query.replayState, 'replayState', DEAD_LETTER_REPLAY_STATES)
    const createdFrom = requireTimeBound(query.createdFrom, 'createdFrom')
    const createdTo = requireTimeBound(query.createdTo, 'createdTo')
    requireTimeRange(createdFrom, createdTo, 'createdFrom', 'createdTo')

    const where: string[] = []
    const bindings: (string | number | null)[] = []

    if (jobId !== undefined) {
      where.push('job_id = ?')
      bindings.push(jobId)
    }
    if (projectId !== undefined) {
      where.push('project_id = ?')
      bindings.push(projectId)
    }
    if (replayState !== undefined) {
      where.push(replayState === 'pending' ? 'replayed_at IS NULL' : 'replayed_at IS NOT NULL')
    }
    if (createdFrom !== undefined) {
      where.push('created_at >= ?')
      bindings.push(createdFrom)
    }
    if (createdTo !== undefined) {
      where.push('created_at < ?')
      bindings.push(createdTo)
    }

    if (query.cursor !== undefined && query.cursor !== null) {
      const cursor = decodeDeadLetterCursor(query.cursor)
      // 两个桶都按 `created_at DESC, id DESC` 排序，桶只决定「谁先谁后」。
      // 游标落在 NULL 桶（未重放）时：桶内继续按 (created_at, id) 降序，
      // **并且**接上排在它后面的已重放桶（整桶都还没翻过）；
      // 游标落在已重放桶时：只剩桶内剩余，绝不能再 OR 出 NULL 桶，
      // 否则每页都从头返回第 1 页、翻页死循环（B2 复评 blocking 的那个坑）。
      where.push(
        cursor.replayState === 'pending'
          ? '((replayed_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)))\n              OR replayed_at IS NOT NULL)'
          : 'replayed_at IS NOT NULL AND (created_at < ? OR (created_at = ? AND id < ?))',
      )
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = sql
      .exec<DeadLetterRow>(
        `SELECT * FROM dead_letters ${whereSql}
          ORDER BY (replayed_at IS NULL) DESC, created_at DESC, id DESC
          LIMIT ?`,
        ...bindings,
        limit + 1,
      )
      .toArray()

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor =
      rows.length > limit && last
        ? encodeDeadLetterCursor({
            replayState: last.replayed_at === null ? 'pending' : 'replayed',
            createdAt: last.created_at,
            id: last.id,
          })
        : null

    return { deadLetters: page.map((row) => this.#toDeadLetterView(row)), nextCursor }
  }

  /**
   * alarm 自愈入口：watchdog（全仓唯一 Cron Trigger，每小时）调用。
   *
   * 先处理一次「已经到期但没被 alarm 处理」的任务（alarm 丢失 / 部署漂移时的补发），
   * 再按最早到期重设 alarm。返回本次实际处理量，供 watchdog 记日志。
   */
  async syncAlarm(): Promise<WakerResult<SyncAlarmResult>> {
    try {
      const result = await this.#runTick(Date.now())
      // watchdog 账本：管理面「系统管理」页用它显示上次校正时刻与处理量。
      // 只记统计量与时刻，不含任务载荷与凭据。
      writeMeta(this.ctx.storage.sql, WATCHDOG_LAST_RUN_AT, String(result.now))
      writeMeta(this.ctx.storage.sql, WATCHDOG_LAST_DUE_JOBS, String(result.dueJobs))
      return ok(result)
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

    const target = await this.#resolveCallbackTarget(job)

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

  /**
   * 回调目标：项目根地址 + 当前生效的 signing key 明文。
   *
   * signing key 在库里是 AES-GCM 信封（B4）：解密**只在这里发生**，明文只作为本次
   * 调用的返回值交给 consumer 签名用，绝不返回给 HTTP 层、不进队列消息、不进日志。
   */
  async #resolveCallbackTarget(job: JobRow): Promise<CallbackTargetView> {
    const sql = this.ctx.storage.sql
    const project = findProjectRow(sql, job.project_id)

    if (project === null || project.callback_url === null || project.callback_url.trim() === '') {
      throw new WakerError(
        'callback_target_missing',
        `项目 ${job.project_id} 未配置 callback_url，无法回调任务 ${job.name}`,
      )
    }

    const key = currentSigningKeyRow(sql, job.project_id)
    if (key === null) {
      throw new WakerError(
        'signing_key_missing',
        `项目 ${job.project_id} 没有可用的 signing key，无法签名回调`,
      )
    }

    const secret = await decryptSigningSecret(key.secret, await this.#requireKek())
    if (secret === null) {
      // 换过 JWT_SECRET 或有非法写入都会走到这里：宁可判死进死信，也不拿密文当明文签出一个错签名。
      throw new WakerError(
        'signing_key_unreadable',
        `项目 ${job.project_id} 的 signing key 无法解密（key ${key.id}），请轮换 signing key`,
      )
    }

    return {
      projectId: job.project_id,
      projectName: project.name,
      callbackUrl: resolveCallbackUrl(project.callback_url),
      signingKeyId: key.id,
      signingSecret: secret,
    }
  }

  /**
   * signing key 的加密密钥（KEK）：由 `JWT_SECRET` 经 HKDF 派生，每个 DO 实例只算一次。
   *
   * 选 `JWT_SECRET` 而不是新加一个部署期 secret：SPEC 只给本项目两个 secret
   * （SETUP_SECRET / JWT_SECRET），signing key 本身不进 env / CI；
   * 加新 secret 会多一道部署关口，而 HKDF 已经能做到「一把源密钥、每个用途一个子密钥」。
   */
  #requireKek(): Promise<CryptoKey> {
    this.#kek ??= deriveSigningKeyKek(this.env.JWT_SECRET)
    return this.#kek
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
      .exec<DeadLetterRow>('SELECT * FROM dead_letters WHERE id = ? LIMIT 1', deadLetterId)
      .toArray()

    const row = rows[0]
    if (row === undefined) {
      throw new WakerError('dead_letter_not_found', `死信不存在：${deadLetterId}`)
    }

    return this.#toDeadLetterView(row)
  }

  /** 死信行 → 契约视图（单条查询与 B6 列表共用，避免两份字段映射走叉）。 */
  #toDeadLetterView(row: DeadLetterRow): DeadLetterView {
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

  /** 执行记录行 → 执行记录视图（B6；不含 payload / signingKeyId，见 `ExecutionView`）。 */
  #toExecutionView(row: ExecutionListRow): ExecutionView {
    return {
      id: row.id,
      jobId: row.job_id,
      jobName: row.job_name,
      projectId: row.project_id,
      trigger: row.trigger as ExecutionTrigger,
      misfire: row.misfire === 1,
      status: row.status as ExecutionStatus,
      skipReason: row.skip_reason,
      scheduledFor: row.scheduled_for,
      dispatchAt: row.dispatch_at,
      attempt: row.attempt,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      responseStatus: row.response_status,
      error: row.error,
      createdAt: row.created_at,
      renewalAt: row.renewal_at,
      renewalError: row.renewal_error,
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

  // ───────────────────── B4：任务更新 / 声明式清单对账 ─────────────────────

  /**
   * 更新任务字段（B4 新增，B2 冻结契约的**纯加法**）。
   *
   * 为什么不换 job id 重建：`(project_id, name)` 是唯一键，改名等于换任务；
   * 而换 id 会切断执行历史与 one_shot「同一 job 系列」的自续语义。
   *
   * 语义：
   *   - 未出现的字段保持原值；`enabled` 是显式开关（false = 暂停，true = 恢复并重算）；
   *   - 排期相关字段（cron / runAt / timezone）变了、或从暂停转回活跃时才重算 `next_run_at`，
   *     改 payload / 策略不会把任务的下一次执行时间平白推后；
   *   - cancelled 是终态（`job_cancelled`），completed 的 one_shot 不可再改（`job_not_resumable`）。
   */
  async updateJob(input: UpdateJobInput): Promise<WakerResult<JobView>> {
    try {
      const view = this.ctx.storage.transactionSync(() => {
        const jobId = requireString(input?.jobId, 'jobId')
        const row = this.#requireJobRow({ jobId })
        if (row.status === 'cancelled') {
          throw new WakerError('job_cancelled', `任务已取消，无法修改：${row.id}`)
        }
        if (row.status === 'completed') {
          throw new WakerError('job_not_resumable', `one-shot 任务已执行完毕，无法修改：${row.id}`)
        }
        return this.#applyJobPatch(row, input, Date.now())
      })
      await this.#rescheduleAlarm()
      return ok(view)
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 把一次更新落到库里（`updateJob` 与声明式对账共用同一套字段语义）。 */
  #applyJobPatch(row: JobRow, input: Omit<UpdateJobInput, 'jobId'>, now: number): JobView {
    const kind = row.kind as JobKind
    const timezone = input.timezone === undefined ? row.timezone : resolveTimezone(input.timezone)

    let schedule: CronSchedule | null = null
    if (kind === 'cron') {
      const expression = input.cron === undefined ? row.cron_expression : requireString(input.cron, 'cron')
      if (expression === null) {
        throw new WakerError('internal', `任务 ${row.id} 是 cron 类型但缺少表达式`)
      }
      schedule = buildSchedule(expression, timezone)
    } else if (input.cron !== undefined) {
      throw new WakerError('invalid_argument', 'one_shot 任务不接受 cron（请改 runAt）')
    }

    let runAt = row.run_at
    if (input.runAt !== undefined) {
      if (kind !== 'one_shot') {
        throw new WakerError('invalid_argument', 'cron 任务不接受 runAt（请改 cron）')
      }
      runAt = toEpochMs(input.runAt)
    }

    const payload =
      input.payload === undefined ? (JSON.parse(row.payload) as JsonValue) : normalizePayload(input.payload)
    const policies = input.policies === undefined ? this.#policiesOf(row) : resolvePolicies(input.policies)
    const active = input.enabled === undefined ? row.status === 'active' : input.enabled
    const status: JobStatus = active ? 'active' : 'paused'

    const scheduleChanged =
      timezone !== row.timezone ||
      runAt !== row.run_at ||
      (schedule !== null && schedule.expression !== row.cron_expression)
    let nextRunAt: number | null
    if (!active) {
      nextRunAt = null
    } else if (schedule !== null) {
      nextRunAt = schedule.nextAfter(now)
    } else {
      nextRunAt = runAt
    }
    // 只改载荷/策略且任务仍在跑：保留原来的下次执行时刻，别把它推后。
    if (active && row.status === 'active' && !scheduleChanged && row.next_run_at !== null) {
      nextRunAt = row.next_run_at
    }

    this.ctx.storage.sql.exec(
      `UPDATE jobs SET
         cron_expression = ?, cron_normalized = ?, timezone = ?, run_at = ?, payload = ?,
         misfire_policy = ?, concurrency_policy = ?, max_retries = ?, backoff_seconds = ?,
         timeout_seconds = ?, jitter_seconds = ?, status = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
      schedule === null ? row.cron_expression : schedule.expression,
      schedule === null ? row.cron_normalized : schedule.normalized,
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
      row.id,
    )

    return this.#requireView({ jobId: row.id })
  }

  /**
   * 声明式清单对账（部署期 CI 调用）：一次事务内完成「建 / 改 / 停」。
   *
   * 对账**范围**：该项目的声明式 cron 任务（`kind = 'cron'`）。
   * 运行时 one-shot 不参与对账 —— 它们是业务在运行时创建的，CI 部署不该把用户
   * 正在跑的定时信/提醒当成「多出来的任务」停掉。
   *
   * 三种结果：
   *   - 清单里有、平台没有 → 新建（`created`）；
   *   - 清单里有、平台已有但内容/状态不一致 → 改写（`updated`，含从暂停恢复、从取消复位）；
   *   - 平台侧多出的同项目 cron 任务 → 停用（`paused`，status 置 paused + 清 `next_run_at`）。
   *
   * 全有或全无：先整体校验（表达式 / 时区 / 策略 / 清单内重名），任一条不合法都不写库，
   * 避免 CI 对账把一半任务改掉后停在中间态。
   */
  async syncManifest(input: SyncManifestInput): Promise<WakerResult<SyncManifestResult>> {
    try {
      const result = this.ctx.storage.transactionSync(() => this.#syncManifest(input))
      await this.#rescheduleAlarm()
      return ok(result)
    } catch (error) {
      return toFailure(error)
    }
  }

  #syncManifest(input: SyncManifestInput): SyncManifestResult {
    const now = Date.now()
    const sql = this.ctx.storage.sql
    const projectId = requireString(input?.projectId, 'projectId')
    requireProjectRow(sql, projectId)

    if (!Array.isArray(input.jobs)) {
      throw new WakerError('invalid_argument', 'jobs 必须是数组')
    }
    if (input.jobs.length > MAX_MANIFEST_JOBS) {
      throw new WakerError('invalid_argument', `单次清单最多 ${MAX_MANIFEST_JOBS} 个任务`)
    }

    const desired = input.jobs.map((entry, index) => this.#validateManifestEntry(entry, index))

    const created: string[] = []
    const updated: string[] = []
    const unchanged: string[] = []

    for (const entry of desired) {
      const existing = this.#findJobRow({ projectId, name: entry.name })

      if (existing === null) {
        this.#insertJobRow({
          projectId,
          name: entry.name,
          kind: 'cron',
          cronExpression: entry.schedule.expression,
          cronNormalized: entry.schedule.normalized,
          timezone: entry.timezone,
          runAt: null,
          payload: entry.payload,
          policies: entry.policies,
          status: entry.enabled ? 'active' : 'paused',
          nextRunAt: entry.enabled ? entry.schedule.nextAfter(now) : null,
          now,
        })
        created.push(entry.name)
        continue
      }

      if (existing.kind !== 'cron') {
        throw new WakerError(
          'name_conflict',
          `任务名 ${entry.name} 已被一个运行时 one_shot 任务占用：它不参与声明式对账，请改名`,
          { name: entry.name, kind: existing.kind },
        )
      }

      const sameContent =
        existing.cron_expression === entry.schedule.expression &&
        existing.timezone === entry.timezone &&
        existing.payload === JSON.stringify(entry.payload) &&
        policiesEqual(this.#policiesOf(existing), entry.policies)
      const desiredStatus: JobStatus = entry.enabled ? 'active' : 'paused'
      if (sameContent && existing.status === desiredStatus) {
        unchanged.push(entry.name)
        continue
      }

      // 直接写库而不是走 pause/resume：对账在一个事务里完成，且已取消的 cron 任务
      // 按清单声明式复位（`resumeJob` 的 job_cancelled 终态语义不受影响）。
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET
           cron_expression = ?, cron_normalized = ?, timezone = ?, payload = ?,
           misfire_policy = ?, concurrency_policy = ?, max_retries = ?, backoff_seconds = ?,
           timeout_seconds = ?, jitter_seconds = ?, status = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
        entry.schedule.expression,
        entry.schedule.normalized,
        entry.timezone,
        JSON.stringify(entry.payload),
        entry.policies.misfire,
        entry.policies.concurrency,
        entry.policies.maxRetries,
        entry.policies.backoffSeconds,
        entry.policies.timeoutSeconds,
        entry.policies.jitterSeconds,
        desiredStatus,
        entry.enabled ? entry.schedule.nextAfter(now) : null,
        now,
        existing.id,
      )
      updated.push(entry.name)
    }

    // 停用平台侧多出来的同项目 cron 任务（已经在 paused 的不重复计数）。
    const paused: string[] = []
    const manifestNames = new Set(desired.map((entry) => entry.name))
    for (const row of this.#projectCronRows(projectId)) {
      if (manifestNames.has(row.name) || row.status !== 'active') continue
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ?`,
        now,
        row.id,
      )
      paused.push(row.name)
    }

    return {
      projectId,
      created,
      updated,
      unchanged,
      paused,
      jobs: this.#projectCronRows(projectId).map((row) => this.#toView(row)),
    }
  }

  /** 清单条目校验 + 规范化（任何一条不合法都在写库之前抛错）。 */
  #validateManifestEntry(
    entry: ManifestJobInput,
    index: number,
  ): {
    name: string
    timezone: string
    schedule: CronSchedule
    payload: JsonValue
    policies: JobPolicies
    enabled: boolean
  } {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WakerError('invalid_argument', `jobs[${index}] 必须是对象`)
    }

    const name = requireString(entry.name, `jobs[${index}].name`)
    if (name.length > MAX_NAME_LENGTH) {
      throw new WakerError('invalid_argument', `jobs[${index}].name 最长 ${MAX_NAME_LENGTH} 字符`, {
        name,
      })
    }

    const timezone = resolveTimezone(entry.timezone)
    const rawCron = requireString(entry.cron, `jobs[${index}].cron`)

    let schedule: CronSchedule
    try {
      schedule = buildSchedule(rawCron, timezone)
    } catch (error) {
      // 方言错误原样透出 `details.cron`（B2 冻结），额外带上任务名，CI 能一眼定位是哪条。
      if (error instanceof WakerError) {
        throw new WakerError(error.code, `清单任务 ${name}：${error.message}`, {
          name,
          ...(error.details ?? {}),
        })
      }
      throw error
    }

    return {
      name,
      timezone,
      schedule,
      payload: normalizePayload(entry.payload),
      policies: resolvePolicies(entry.policies),
      enabled: entry.enabled !== false,
    }
  }

  /** 该项目全部 cron 任务行（对账后回读，供 CI / SDK 核对落库结果）。 */
  #projectCronRows(projectId: string): JobRow[] {
    return this.ctx.storage.sql
      .exec<JobRow>(
        `SELECT * FROM jobs WHERE project_id = ? AND kind = 'cron' ORDER BY name, id`,
        projectId,
      )
      .toArray()
  }

  /** 任务行 → 策略字段（`updateJob` / 对账比较用）。 */
  #policiesOf(row: JobRow): JobPolicies {
    return {
      misfire: row.misfire_policy as MisfirePolicy,
      concurrency: row.concurrency_policy as ConcurrencyPolicy,
      maxRetries: row.max_retries,
      backoffSeconds: row.backoff_seconds,
      timeoutSeconds: row.timeout_seconds,
      jitterSeconds: row.jitter_seconds,
    }
  }

  // ───────────────────── B4：项目管理与凭据（RPC） ─────────────────────

  /**
   * 新建项目：建项目行，并**同时**发放首个项目令牌与首把 signing key。
   *
   * 两把凭据互相独立：令牌用于调注册 API（只存哈希），signing key 用于回调验签
   * （加密存 DO）。明文都只在本次应答里出现一次，之后任何接口都只给掩码/指纹。
   */
  async createProject(input: CreateProjectInput): Promise<WakerResult<CreateProjectResult>> {
    try {
      return ok(await this.#createProject(input))
    } catch (error) {
      return toFailure(error)
    }
  }

  async #createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const now = Date.now()
    const sql = this.ctx.storage.sql

    const name = requireString(input?.name, 'name')
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      throw new WakerError('invalid_argument', `项目名最长 ${MAX_PROJECT_NAME_LENGTH} 字符`)
    }
    const callbackUrl = resolveCallbackBaseUrl(input?.callbackUrl)

    if (findProjectRowByName(sql, name) !== null) {
      throw new WakerError('duplicate_project', `项目名已存在：${name}`)
    }

    const projectId = crypto.randomUUID()
    const token = generateProjectToken()
    insertProject(sql, {
      id: projectId,
      name,
      callbackUrl,
      tokenHash: await hashProjectToken(token),
      now,
    })

    const signingKey = await this.#issueSigningKey(projectId, now)
    return { project: projectView(sql, requireProjectRow(sql, projectId)), token, signingKey }
  }

  /** 生成并加密存一把新 signing key（明文只在本函数返回体里出现）。 */
  async #issueSigningKey(projectId: string, now: number): Promise<IssuedSigningKey> {
    const secret = generateSigningSecret()
    const envelope = await encryptSigningSecret(secret, await this.#requireKek())
    const fingerprint = await signingSecretFingerprint(secret)
    const id = crypto.randomUUID()

    insertSigningKey(this.ctx.storage.sql, {
      id,
      projectId,
      envelope,
      fingerprint,
      algorithm: SIGNING_ALGORITHM,
      now,
    })

    return { id, algorithm: SIGNING_ALGORITHM, secret, fingerprint, createdAt: now }
  }

  /** 项目列表（单人自托管：项目数是个位数，不做分页）。 */
  async listProjects(): Promise<WakerResult<ListProjectsResult>> {
    try {
      const sql = this.ctx.storage.sql
      return ok({ projects: listProjectRows(sql).map((row) => projectView(sql, row)) })
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 查单个项目；不存在返回 null（与 `getJob` 一致，不用抛错表达「没有」）。 */
  async getProject(input: { projectId: string }): Promise<WakerResult<ProjectView | null>> {
    try {
      const sql = this.ctx.storage.sql
      const projectId = requireString(input?.projectId, 'projectId')
      const row = findProjectRow(sql, projectId)
      return ok(row === null ? null : projectView(sql, row))
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 改项目名 / 回调地址（凭据不在这个口子改，走两个独立轮换入口）。 */
  async updateProject(input: UpdateProjectInput): Promise<WakerResult<ProjectView>> {
    try {
      const now = Date.now()
      const sql = this.ctx.storage.sql
      const projectId = requireString(input?.projectId, 'projectId')
      requireProjectRow(sql, projectId)

      const patch: { name?: string; callbackUrl?: string } = {}
      if (input.name !== undefined) {
        const name = requireString(input.name, 'name')
        if (name.length > MAX_PROJECT_NAME_LENGTH) {
          throw new WakerError('invalid_argument', `项目名最长 ${MAX_PROJECT_NAME_LENGTH} 字符`)
        }
        const clash = findProjectRowByName(sql, name)
        if (clash !== null && clash.id !== projectId) {
          throw new WakerError('duplicate_project', `项目名已存在：${name}`)
        }
        patch.name = name
      }
      if (input.callbackUrl !== undefined) {
        patch.callbackUrl = resolveCallbackBaseUrl(input.callbackUrl)
      }

      updateProjectRow(sql, projectId, patch, now)
      return ok(projectView(sql, requireProjectRow(sql, projectId)))
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 轮换项目令牌：旧令牌立即失效（只覆盖哈希），新明文只在本次应答里出现一次。 */
  async rotateProjectToken(
    input: RotateProjectTokenInput,
  ): Promise<WakerResult<RotateProjectTokenResult>> {
    try {
      const now = Date.now()
      const sql = this.ctx.storage.sql
      const projectId = requireString(input?.projectId, 'projectId')
      requireProjectRow(sql, projectId)

      const token = generateProjectToken()
      updateProjectTokenHash(sql, projectId, await hashProjectToken(token), now)
      return ok({ project: projectView(sql, requireProjectRow(sql, projectId)), token })
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 轮换 signing key：旧 key 全部 `revoked_at`（保留行做审计），新 key 加密存库。 */
  async rotateSigningKey(input: RotateSigningKeyInput): Promise<WakerResult<RotateSigningKeyResult>> {
    try {
      const now = Date.now()
      const sql = this.ctx.storage.sql
      const projectId = requireString(input?.projectId, 'projectId')
      requireProjectRow(sql, projectId)

      revokeSigningKeys(sql, projectId, now)
      const signingKey = await this.#issueSigningKey(projectId, now)
      return ok({ project: projectView(sql, requireProjectRow(sql, projectId)), signingKey })
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * 注册 API 鉴权：令牌 → 项目身份。
   *
   * 只在 DO 内部比对哈希（`sha256(token)` 直查唯一索引），明文令牌不落库、
   * 不进日志；令牌无效或项目已停用时返回 null（调用方统一回 401，不区分原因）。
   */
  async verifyProjectToken(
    input: VerifyProjectTokenInput,
  ): Promise<WakerResult<ProjectAuthView | null>> {
    try {
      const sql = this.ctx.storage.sql
      const token = requireString(input?.token, 'token')
      const row = findProjectRowByTokenHash(sql, await hashProjectToken(token))
      if (row === null || row.status !== 'active') return ok(null)
      return ok({
        projectId: row.id,
        projectName: row.name,
        callbackUrl: row.callback_url ?? '',
      })
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * 平台状态快照（管理面系统管理页只读数据）。
   *
   * 只报计数、时刻与 schema 版本：没有任何凭据、载荷或用户业务数据。
   * `SETUP_SECRET` / `JWT_SECRET` 的「是否已配置」由 HTTP 层（能读 env 的那一层）补，
   * DO 不接触也不需要知道这两个 secret 的值。
   */
  async getSystemStatus(): Promise<WakerResult<SystemStatusView>> {
    try {
      const sql = this.ctx.storage.sql
      const count = (query: string): number => Number(sql.exec<{ n: number }>(query).one().n)
      const lastRunAt = readMeta(sql, WATCHDOG_LAST_RUN_AT)
      const lastDueJobs = readMeta(sql, WATCHDOG_LAST_DUE_JOBS)

      return ok({
        now: Date.now(),
        schemaVersion: readSchemaVersion(sql),
        watchdogLastRunAt: lastRunAt === null ? null : Number(lastRunAt),
        watchdogLastDueJobs: lastDueJobs === null ? null : Number(lastDueJobs),
        nextWakeAt: await this.ctx.storage.getAlarm(),
        counts: {
          projects: count('SELECT COUNT(*) AS n FROM projects'),
          jobs: count('SELECT COUNT(*) AS n FROM jobs'),
          activeJobs: count(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'active'`),
          executions: count('SELECT COUNT(*) AS n FROM executions'),
          pendingDispatches: count(`SELECT COUNT(*) AS n FROM executions WHERE status = 'pending'`),
          deadLetters: count('SELECT COUNT(*) AS n FROM dead_letters'),
        },
      })
    } catch (error) {
      return toFailure(error)
    }
  }
}
