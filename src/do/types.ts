import type { WakerErrorCode, WakerErrorDetails } from './errors'

/**
 * WakerDO 的领域类型 = **冻结 RPC 契约**（B2 定稿，B3/B4/B5 与前端 F1-F3 共同对接）。
 *
 * 契约原则：
 *   1. 出入参一律 JSON 可序列化（RPC 与 HTTP 共用同一份结构，前端不需要二次映射）。
 *   2. 时间一律 epoch 毫秒（number），不传 Date、不传字符串时间戳。
 *   3. 策略字段显式建模，不让调用方猜默认值 —— 默认值在
 *      {@link DEFAULT_JOB_POLICIES} 里定死，并在契约里写明。
 */

/**
 * RPC 统一返回信封：**每个 RPC 方法都返回它，不靠抛异常表达业务错误**。
 *
 * 为什么不用抛错：CF 的 RPC 错误传播明确只保证 `name` / `message` / 可序列化自有属性，
 * 且不保证 `instanceof`（见 CF 文档 Runtime APIs → RPC → Error handling）。
 * 冻结契约要求错误码稳定可判定，所以把错误码放进返回值里，
 * 调用方（B3 / B4 / 前端）只需分支 `ok`，不需要猜异常反序列化行为。
 */
export type WakerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WakerErrorPayload }

/** 错误载荷：`code` 是冻结契约的稳定错误码。 */
export interface WakerErrorPayload {
  code: WakerErrorCode
  message: string
  details?: WakerErrorDetails
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** 任务两类型：cron（声明式周期）/ one_shot（一次性，可自续）。 */
export type JobKind = 'cron' | 'one_shot'

export type JobStatus = 'active' | 'paused' | 'cancelled' | 'completed'

/**
 * 错过执行窗口（alarm 延迟超过 {@link MISFIRE_GRACE_MS}）时怎么办：
 *   - `fire_once`：补跑一次（默认）
 *   - `skip`：错过就跳，适合清理类任务
 *   - `fire_all`：逐个补齐（慎用）
 */
export type MisfirePolicy = 'fire_once' | 'skip' | 'fire_all'

/** 同一任务上一次执行尚未结束时：`forbid`（默认，跳过本次）/ `allow`（并发跑）。 */
export type ConcurrencyPolicy = 'forbid' | 'allow'

/**
 * 执行记录状态：
 *   - `pending`：已排定、等待投递（B2 落库即止；B3 投递后推进到 `dispatched`）
 *   - `dispatched` / `running` / `succeeded` / `failed` / `dead`：B3 回调执行环节推进
 *   - `skipped`：本次按并发策略 `forbid` 主动跳过（`skipReason` 有原因）
 */
export type ExecutionStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'skipped'

export type ExecutionTrigger = 'schedule' | 'manual'

/** 每个任务必备的策略字段（建模定死，不留默认猜测）。 */
export interface JobPolicies {
  misfire: MisfirePolicy
  concurrency: ConcurrencyPolicy
  /** 失败重试次数，0 = 不重试。 */
  maxRetries: number
  /** 重试退避基数（秒），第 n 次重试等待 `backoffSeconds * 2^(n-1)`。 */
  backoffSeconds: number
  /** 单次执行超时（秒），下游回调超过即判失败。 */
  timeoutSeconds: number
  /** 抖动上限（秒）：同一分钟的任务按 job id 哈希打散，防惊群。 */
  jitterSeconds: number
}

/** 创建任务时未传策略字段时的取值（写进契约，调用方可预期）。 */
export const DEFAULT_JOB_POLICIES: JobPolicies = {
  misfire: 'fire_once',
  concurrency: 'forbid',
  maxRetries: 0,
  backoffSeconds: 0,
  timeoutSeconds: 30,
  jitterSeconds: 0,
}

/** 任务视图（查询 / 创建 / 状态变更的统一返回体）。 */
export interface JobView {
  id: string
  projectId: string
  name: string
  kind: JobKind
  /** cron 任务：调用方传入的原始表达式（CF 方言，原样保留）。 */
  cron: string | null
  /** cron 任务：规范化后的 pattern（诊断用）。 */
  cronNormalized: string | null
  /** 任务独立时区（IANA），默认 `UTC`。 */
  timezone: string
  /** one_shot 任务：本次执行时刻（epoch ms）；cron 任务为 null。 */
  runAt: number | null
  /** 随回调下发的业务载荷（不透明 JSON，平台不解析）。 */
  payload: JsonValue
  policies: JobPolicies
  status: JobStatus
  /** 下一次调度时刻（epoch ms；不活跃或已排完为 null）。 */
  nextRunAt: number | null
  /** 最近一次进入执行时刻（epoch ms）。 */
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

/** 创建任务入参：cron 与 one_shot 是同一个结构，靠 `kind` 区分必填项。 */
export interface CreateJobInput {
  projectId: string
  name: string
  kind: JobKind
  /** `kind: 'cron'` 必填：CF 方言 5 字段表达式。 */
  cron?: string
  /** `kind: 'one_shot'` 必填：epoch 毫秒（也接受 ISO 8601 字符串，统一转成毫秒存储）。 */
  runAt?: number | string
  /** IANA 时区，默认 `UTC`。 */
  timezone?: string
  payload?: JsonValue
  /** 部分覆盖 {@link DEFAULT_JOB_POLICIES}，未传字段取默认值。 */
  policies?: Partial<JobPolicies>
  /** false = 创建后先暂停（不进调度）。默认 true。 */
  enabled?: boolean
}

/** 定位任务的两种方式：按 id，或按 (projectId, name) 唯一键。 */
export type JobRef =
  | { jobId: string }
  | {
      projectId: string
      name: string
    }

export interface ListJobsQuery {
  projectId?: string
  status?: JobStatus
  kind?: JobKind
  /** 默认 50，上限 200。 */
  limit?: number
  /** 上一次返回的 `nextCursor`，不透明字符串。 */
  cursor?: string | null
}

export interface ListJobsResult {
  jobs: JobView[]
  nextCursor: string | null
}

/** 手动触发入参：定位方式同 {@link JobRef}，可覆盖本次载荷。 */
export type ManualTriggerInput = JobRef & { payload?: JsonValue }

export interface ManualTriggerResult {
  jobId: string
  executionId: string
  /** 本次执行计划时刻（epoch ms）。 */
  scheduledFor: number
  /** 实际分发目标时刻（含抖动），调度型任务才与 scheduledFor 不同。 */
  dispatchAt: number
}

/** 一次到期执行的分发载荷（B3 投递 Queue 时用；B2 只落库不投递）。 */
export interface DispatchItem {
  executionId: string
  jobId: string
  projectId: string
  scheduledFor: number
  dispatchAt: number
  trigger: ExecutionTrigger
  /** 是否是补跑（错过窗口后按 misfire 策略补的那一次）。 */
  misfire: boolean
  attempt: number
  payload: JsonValue
  timeoutSeconds: number
  maxRetries: number
  backoffSeconds: number
}

/** `syncAlarm` 结果：watchdog 每小时调一次，用于 alarm 自愈与可观测。 */
export interface SyncAlarmResult {
  now: number
  /** 本次处理到的到期任务数。 */
  dueJobs: number
  /** 本次落库的执行记录数。 */
  createdExecutions: number
  /** 因并发策略 `forbid` 主动跳过的次数。 */
  skippedExecutions: number
  /** 等待 B3 投递的执行条数（B2 恒等于 createdExecutions + 历史 pending）。 */
  pendingDispatches: number
  /** 重算后的最近唤醒时刻；null = 当前没有任何待跑任务。 */
  nextWakeAt: number | null
}

// ───────────────────── B3：执行引擎（回调协议 v2）的类型 ─────────────────────
//
// 以下是 B3 在 B2 冻结契约上做的**纯加法**：B2 的 RPC 方法表 / 出入参 / 错误码原样不动，
// 只新增执行引擎内部的 RPC（consumer 调用）与死信重放入参。
// 前端 F1-F3 与 B4 的注册 API 不需要这些方法，它们由 queue consumer 独占调用。

/** consumer 认领一次执行：`attempt` 必须与执行记录里的 `attempt` 一致（防重复投递）。 */
export interface PrepareExecutionInput {
  executionId: string
  attempt: number
}

/** 回调目标：下游地址 + 该项目当前 signing key（secret 只在进程内用于签名）。 */
export interface CallbackTargetView {
  projectId: string
  projectName: string | null
  /** 完整回调地址（已拼 `/_waker/execute`）。 */
  callbackUrl: string
  /** 当前生效的 signing key id（写进执行记录做审计）。 */
  signingKeyId: string
  /** signing key 明文值：不落库、不落日志、不进队列消息。 */
  signingSecret: string
}

/** 一次执行的全部回调材料（= 请求体里除 protocolVersion 外的字段来源）。 */
export interface ExecutionCallbackContext {
  executionId: string
  jobId: string
  projectId: string
  jobName: string
  kind: JobKind
  trigger: ExecutionTrigger
  misfire: boolean
  attempt: number
  scheduledFor: number
  dispatchedAt: number
  timeoutSeconds: number
  payload: JsonValue
}

/** 不允许执行本次回调的原因（consumer 直接 ack，不再打下游）。 */
export type PrepareSkipReason =
  /** 已经成功 / 已成死信 / 已按并发策略跳过：重复投递，忽略。 */
  | 'already_handled'
  /** 同一 execution 正在执行中（同进程重复投递或租约未过期）。 */
  | 'in_flight'
  /** 消息里的 attempt 落后于执行记录的 attempt：过期的重试消息。 */
  | 'stale_attempt'
  /** 同一任务 `concurrencyPolicy = forbid` 且上一次执行仍在跑：本次记 skipped。 */
  | 'concurrency_policy_forbid'
  /** 任务已取消：不再执行。 */
  | 'job_not_active'

/**
 * 认领结果。
 *
 * 为什么是「扁平结构 + 可空字段」而不是 `run | skip` 判别联合：跨 DO RPC 返回的联合类型里
 * 再嵌递归的 `JsonValue` 会让 TS 的类型实例化深度爆掉（`TS2589`），扁平结构同样能表达
 * 「跑 / 不跑」，而且 consumer 的分支更直白。
 *
 * 不变量：`outcome === 'run'` 时 `context` 与 `target` 非空；`outcome === 'skip'` 时 `reason` 非空。
 */
export interface PrepareExecutionResult {
  outcome: 'run' | 'skip'
  /** 不执行的原因（`outcome === 'skip'` 时非空）。 */
  reason: PrepareSkipReason | null
  /** 回调材料（`outcome === 'run'` 时非空）。 */
  context: ExecutionCallbackContext | null
  /** 下游地址 + signing key（`outcome === 'run'` 时非空）。 */
  target: CallbackTargetView | null
  /** 认领后（或跳过时）执行记录的状态。 */
  executionStatus: ExecutionStatus
}

/** 自续校验失败 / 跳过续期的原因（不影响本次执行的成功判定）。 */
export type RenewalRejectionReason =
  | 'not_requested'
  | 'job_not_self_renewable'
  | 'invalid_next_run_at'
  | 'next_run_at_not_future'
  | 'next_run_at_too_far'
  | 'job_cancelled'
  | 'job_not_active'
  | 'already_finalized'
  | 'stale_attempt'

export interface RenewalOutcome {
  applied: boolean
  /** 生效后的下次执行时刻（未生效为 null）。 */
  nextRunAt: number | null
  reason: RenewalRejectionReason | null
}

/** 回调结果回填：consumer 把下游的结果（含 2xx/非 2xx、耗时、自续声明）交回 DO。 */
export interface RecordExecutionInput {
  executionId: string
  attempt: number
  ok: boolean
  httpStatus?: number | null
  /** 失败原因（已截断，绝不含密钥）。 */
  error?: string | null
  startedAt: number
  finishedAt: number
  durationMs: number
  /** 下游响应声明的自续时刻（仅 one_shot 生效；number 毫秒或 ISO 字符串）。 */
  nextRunAt?: number | string | null
}

export interface RecordExecutionResult {
  executionId: string
  status: ExecutionStatus
  /** 本次失败后推进到的 attempt（下一次投递用）。 */
  attempt: number
  /** 是否已按 backoff 重新排入 Queue 重试。 */
  retryScheduled: boolean
  /** 重试的计划投递时刻（未重试为 null）。 */
  retryAt: number | null
  renewal: RenewalOutcome
}

/** 死信落库（DLQ consumer 调用；重复投递幂等）。 */
export interface DeadLetterInput {
  executionId: string
  jobId?: string
  projectId?: string
  attempts?: number
  error?: string | null
}

export interface DeadLetterView {
  id: string
  executionId: string
  jobId: string
  projectId: string
  attempts: number
  error: string
  payload: JsonValue
  createdAt: number
  replayedAt: number | null
  replayedExecutionId: string | null
}

/** 死信重放：以同一任务新建一条 manual 执行记录，重新走 Queue → 回调。 */
export interface ReplayDeadLetterInput {
  deadLetterId: string
}

export interface ReplayDeadLetterResult {
  deadLetterId: string
  jobId: string
  /** 新建的执行 id（页面用它跟踪重放结果）。 */
  executionId: string
  scheduledFor: number
  dispatchAt: number
}
