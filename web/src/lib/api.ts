/**
 * 管理面 API 客户端 —— 严格对齐 B4 冻结的管理面契约（`src/api/management.ts`）。
 *
 * 契约要点（前端不自造字段、不额外拼参数）：
 *   - `POST /api/auth/setup` 用 `SETUP_SECRET` 换 12 小时会话 JWT；
 *   - 其余 `/api/*` 一律 `Authorization: Bearer <session.token>`；
 *   - 错误体统一 `{ error: { code, message, details? } }`，`code` 是冻结契约里的稳定错误码。
 *
 * 前端只做「契约 → 视图」的映射，调度语义（状态机、对账、凭据）全部在 WakerDO。
 */

export type JobKind = 'cron' | 'one_shot'
export type JobStatus = 'active' | 'paused' | 'cancelled' | 'completed'
export type MisfirePolicy = 'fire_once' | 'skip' | 'fire_all'
export type ConcurrencyPolicy = 'forbid' | 'allow'
export type ProjectStatus = 'active' | 'revoked'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface JobPolicies {
  misfire: MisfirePolicy
  concurrency: ConcurrencyPolicy
  maxRetries: number
  backoffSeconds: number
  timeoutSeconds: number
  jitterSeconds: number
}

/** 创建任务时未传策略字段的取值（B2 冻结契约，与后端 `DEFAULT_JOB_POLICIES` 一致）。 */
export const DEFAULT_JOB_POLICIES: JobPolicies = {
  misfire: 'fire_once',
  concurrency: 'forbid',
  maxRetries: 0,
  backoffSeconds: 0,
  timeoutSeconds: 30,
  jitterSeconds: 0,
}

export interface JobView {
  id: string
  projectId: string
  name: string
  kind: JobKind
  cron: string | null
  cronNormalized: string | null
  timezone: string
  runAt: number | null
  payload: JsonValue
  policies: JobPolicies
  status: JobStatus
  nextRunAt: number | null
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ListJobsResult {
  jobs: JobView[]
  nextCursor: string | null
}

export interface ManualTriggerResult {
  jobId: string
  executionId: string
  scheduledFor: number
  dispatchAt: number
}

export interface ProjectSigningKeyView {
  id: string
  algorithm: string
  fingerprint: string
  createdAt: number
  rotatedAt: number | null
}

export interface ProjectView {
  id: string
  name: string
  callbackUrl: string
  status: ProjectStatus
  tokenFingerprint: string | null
  tokenCreatedAt: number | null
  tokenRotatedAt: number | null
  signingKey: ProjectSigningKeyView | null
  createdAt: number
  updatedAt: number
}

export interface IssuedSigningKey {
  id: string
  algorithm: string
  /** 明文，仅发放 / 轮换的应答里出现一次；前端只在内存里展示一次。 */
  secret: string
  fingerprint: string
  createdAt: number
}

export interface CreateProjectResult {
  project: ProjectView
  token: string
  signingKey: IssuedSigningKey
}

export interface RotateProjectTokenResult {
  project: ProjectView
  token: string
}

export interface RotateSigningKeyResult {
  project: ProjectView
  signingKey: IssuedSigningKey
}

export interface CreateJobInput {
  projectId: string
  name: string
  kind: JobKind
  cron?: string
  runAt?: number | string
  timezone?: string
  payload?: JsonValue
  policies?: Partial<JobPolicies>
  enabled?: boolean
}

export type UpdateJobInput = {
  jobId: string
  cron?: string
  runAt?: number | string
  timezone?: string
  payload?: JsonValue
  policies?: Partial<JobPolicies>
  enabled?: boolean
}

export interface ListJobsQuery {
  projectId?: string
  status?: JobStatus
  kind?: JobKind
  limit?: number
  cursor?: string | null
}

// ───────────────────── 执行记录 / 死信（B6 + B3 冻结契约） ─────────────────────
//
// 字段与 `src/do/types.ts` 的 `ExecutionView` / `DeadLetterView` 一一对应，前端不增删：
//   - `ExecutionView` **不含** `payload` / `signingKeyId` —— 载荷不随列表批量下发；
//   - 死信条目复用 B3 的 `DeadLetterView`（含 `payload`，重放详情要展示）。

export type ExecutionStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'skipped'

export type ExecutionTrigger = 'schedule' | 'manual'

export type DeadLetterReplayState = 'pending' | 'replayed'

export interface ExecutionView {
  id: string
  jobId: string
  /** 任务名（WakerDO 联表取）；任务行只增不删，仍留 null 兜底。 */
  jobName: string | null
  projectId: string
  trigger: ExecutionTrigger
  /** 是否补跑（错过窗口后按 misfire 策略补的那一次）。 */
  misfire: boolean
  status: ExecutionStatus
  /** `status = 'skipped'` 时的原因（并发策略主动跳过等）。 */
  skipReason: string | null
  /** 计划执行时刻（epoch ms，排序键）。 */
  scheduledFor: number
  /** 实际分发目标时刻（= scheduledFor + 抖动）。 */
  dispatchAt: number
  /** 已重试次数（0 = 首次投递）。 */
  attempt: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  responseStatus: number | null
  error: string | null
  createdAt: number
  renewalAt: number | null
  renewalError: string | null
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

export interface ListExecutionsQuery {
  jobId?: string
  projectId?: string
  status?: ExecutionStatus
  trigger?: ExecutionTrigger
  /** `scheduledFor` 下界（epoch ms，含）。 */
  scheduledFrom?: number
  /** `scheduledFor` 上界（epoch ms，不含）。 */
  scheduledTo?: number
  /** 默认 50，上限 200（与 `listJobs` 一致）。 */
  limit?: number
  cursor?: string | null
}

export interface ListExecutionsResult {
  executions: ExecutionView[]
  nextCursor: string | null
}

export interface ListDeadLettersQuery {
  jobId?: string
  projectId?: string
  replayState?: DeadLetterReplayState
  /** `createdAt` 下界（epoch ms，含）。 */
  createdFrom?: number
  /** `createdAt` 上界（epoch ms，不含）。 */
  createdTo?: number
  limit?: number
  cursor?: string | null
}

export interface ListDeadLettersResult {
  deadLetters: DeadLetterView[]
  nextCursor: string | null
}

// ───────────────────── 系统状态（F3 系统管理页，B4 冻结契约） ─────────────────────
//
// HTTP `GET /api/system/status` → `{ status }`，形状与 `src/do/types.ts` 的
// `SystemStatusView` 一致，+ HTTP 层补的两块（只有状态位与队列名，没有任何凭据值）：
//   - `secrets`：SETUP_SECRET / JWT_SECRET **是否已配置**的布尔位；
//   - `queue`：主队列 / 死信队列名。
// 前端只读这份快照，不自己推断 watchdog 是否健康。

export interface SystemCounts {
  projects: number
  jobs: number
  activeJobs: number
  executions: number
  /** 等待投递的执行条数（> 0 说明 Queue 投递落后）。 */
  pendingDispatches: number
  deadLetters: number
}

/** 密钥配置状态位：只有布尔，契约里连掩码都没有，页面照此只展示状态。 */
export interface SystemSecretsStatus {
  setupSecretConfigured: boolean
  jwtSecretConfigured: boolean
}

export interface SystemQueueStatus {
  main: string
  deadLetter: string
}

export interface SystemStatus {
  /** 采集时刻（epoch ms）。 */
  now: number
  /** WakerDO 库内 schema 版本（= 迁移账本值）。 */
  schemaVersion: number
  /** watchdog（全仓唯一 Cron Trigger）上次 ping 到 DO 的时刻；从未跑过为 null。 */
  watchdogLastRunAt: number | null
  /** 上次 ping 处理到的到期任务数（watchdog 幂等，重复 ping 只补漏）。 */
  watchdogLastDueJobs: number | null
  /** 当前 alarm 唤醒时刻（null = 没有待跑任务）。 */
  nextWakeAt: number | null
  counts: SystemCounts
  secrets: SystemSecretsStatus
  queue: SystemQueueStatus
}

/** 平台状态快照（= B4 冻结的 `GET /api/system/status`）。 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const body = await request<{ status: SystemStatus }>('/api/system/status')
  return body.status
}

/** 重放结果：以同一任务新建一条 `manual` 执行，页面用它跟踪「哪一次执行」。 */
export interface ReplayDeadLetterResult {
  deadLetterId: string
  jobId: string
  executionId: string
  scheduledFor: number
  dispatchAt: number
}

/** 查询接口的 `limit` 上限（B6 契约：与 `listJobs` 一致，默认 50 / 上限 200）。 */
export const PAGE_LIMIT_MAX = 200

/** 管理面错误码（B2/B3/B4 冻结契约的超集里，只会命中前端可能触发的那些）。 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'invalid_json'
  | 'invalid_argument'
  | 'execution_not_found'
  | 'dead_letter_not_found'
  /** 管理面兜底：该子路径还没挂载（HTTP 501，`{ error: 'not_implemented', scope }`）。 */
  | 'not_implemented'
  | 'invalid_cron'
  | 'invalid_timezone'
  | 'invalid_run_at'
  | 'invalid_policy'
  | 'duplicate_job'
  | 'duplicate_project'
  | 'name_conflict'
  | 'job_not_found'
  | 'project_not_found'
  | 'job_cancelled'
  | 'job_not_resumable'
  | 'signing_key_missing'
  | 'signing_key_unreadable'
  | 'callback_target_missing'
  | 'internal'

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown } | string
}

/** 契约错误：`code` 原样透出，页面按它决定提示语与是否跳登录。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * 401 的两种来源要分开：
 *   - 换会话失败（`/api/auth/setup`）＝ SETUP_SECRET 不对，留在登录页提示；
 *   - 带令牌请求 401 ＝ 会话过期 / 被换掉，清掉本地会话回登录页。
 * 由会话 store 订阅这里抛出的 `ApiError`，避免 client 反向依赖 store。
 */
type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler = () => {}

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler
}

let authToken: string | null = null

export function setAuthToken(token: string | null): void {
  authToken = token
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (authToken !== null) headers.set('authorization', `Bearer ${authToken}`)

  const response = await fetch(path, { ...init, headers })
  const text = await response.text()
  const body: unknown = text.length === 0 ? null : JSON.parse(text)

  if (!response.ok) {
    const payload = (body ?? {}) as ApiErrorBody
    // 未挂载的管理面子路径回 501 `{ error: 'not_implemented', scope }`（`error` 是字符串，
    // 不是契约里的 `{ code, message }` 对象），这里一并收成稳定的 code，页面按它给提示。
    const raw = payload.error
    const code = typeof raw === 'string' ? raw : (raw?.code ?? 'internal')
    const message =
      typeof raw === 'string'
        ? `该接口尚未挂载（HTTP ${response.status}）`
        : (raw?.message ?? `请求失败（HTTP ${response.status}）`)

    if (response.status === 401 && path !== '/api/auth/setup') {
      authToken = null
      onUnauthorized()
    }
    throw new ApiError(
      response.status,
      code,
      message,
      typeof raw === 'string' ? undefined : raw?.details,
    )
  }

  return body as T
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value ?? {})
}

/** 查询参数的「有值才拼」序列化：空字符串 / undefined / null 一律不发，避免伪造筛选。 */
function queryString(entries: Array<[string, string | number | null | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params.size === 0 ? '' : `?${params.toString()}`
}

// ───────────────────────── 会话 ─────────────────────────

export interface SessionInfo {
  token: string
  expiresAt: number
}

export async function createSession(setupSecret: string): Promise<SessionInfo> {
  const body = await request<{ session: SessionInfo }>('/api/auth/setup', {
    method: 'POST',
    body: jsonBody({ setupSecret }),
  })
  return body.session
}

// ───────────────────────── 任务 ─────────────────────────

export function listJobs(query: ListJobsQuery = {}): Promise<ListJobsResult> {
  const suffix = queryString([
    ['projectId', query.projectId],
    ['status', query.status],
    ['kind', query.kind],
    ['limit', query.limit],
    ['cursor', query.cursor],
  ])
  return request<ListJobsResult>(`/api/jobs${suffix}`)
}

export async function createJob(input: CreateJobInput): Promise<JobView> {
  const body = await request<{ job: JobView }>('/api/jobs', {
    method: 'POST',
    body: jsonBody(input),
  })
  return body.job
}

export async function updateJob(input: UpdateJobInput): Promise<JobView> {
  const { jobId, ...patch } = input
  const body = await request<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    body: jsonBody(patch),
  })
  return body.job
}

export type JobAction = 'pause' | 'resume' | 'cancel' | 'trigger'

export async function runJobAction(jobId: string, action: JobAction): Promise<JobView> {
  const body = await request<{ job: JobView }>(
    `/api/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: 'POST' },
  )
  return body.job
}

/** 手动触发：202 + 本次执行指针（页面用它告诉用户「哪一次执行」被排上了）。 */
export function triggerJob(jobId: string): Promise<ManualTriggerResult> {
  return request<ManualTriggerResult>(`/api/jobs/${encodeURIComponent(jobId)}/trigger`, {
    method: 'POST',
  })
}

// ───────────────────────── 项目 ─────────────────────────

export async function listProjects(): Promise<ProjectView[]> {
  const body = await request<{ projects: ProjectView[] }>('/api/projects')
  return body.projects
}

export function createProject(input: { name: string; callbackUrl: string }): Promise<CreateProjectResult> {
  return request<CreateProjectResult>('/api/projects', {
    method: 'POST',
    body: jsonBody(input),
  })
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; callbackUrl?: string },
): Promise<ProjectView> {
  const body = await request<{ project: ProjectView }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { method: 'PATCH', body: jsonBody(patch) },
  )
  return body.project
}

export function rotateProjectToken(projectId: string): Promise<RotateProjectTokenResult> {
  return request<RotateProjectTokenResult>(
    `/api/projects/${encodeURIComponent(projectId)}/token/rotate`,
    { method: 'POST' },
  )
}

export function rotateSigningKey(projectId: string): Promise<RotateSigningKeyResult> {
  return request<RotateSigningKeyResult>(
    `/api/projects/${encodeURIComponent(projectId)}/signing-key/rotate`,
    { method: 'POST' },
  )
}

// ───────────────────── 执行记录 / 死信 ─────────────────────
//
// HTTP 面（管理面薄映射，与 `GET /api/jobs` 同一套路；三个路径在 B4 的 501 占位里
// 已经点名过，RPC 由 B6 / B3 冻结）：
//
//   GET  /api/executions?jobId&projectId&status&trigger&scheduledFrom&scheduledTo&limit&cursor
//        → `{ executions, nextCursor }`（= B6 `listExecutions`）
//   GET  /api/dead-letters?jobId&projectId&replayState&createdFrom&createdTo&limit&cursor
//        → `{ deadLetters, nextCursor }`（= B6 `listDeadLetters`）
//   POST /api/dead-letters/{id}/replay
//        → `ReplayDeadLetterResult`（= B3 `replayDeadLetter`）
//
// 契约里 `nextCursor` 是唯一翻页依据；时间区间一律半开 `[from, to)`（epoch ms）。

export interface ListExecutionsQueryParams {
  jobId?: string
  projectId?: string
  status?: ExecutionStatus
  trigger?: ExecutionTrigger
  scheduledFrom?: number
  scheduledTo?: number
  limit?: number
  cursor?: string | null
}

export interface ListDeadLettersQueryParams {
  jobId?: string
  projectId?: string
  replayState?: DeadLetterReplayState
  createdFrom?: number
  createdTo?: number
  limit?: number
  cursor?: string | null
}

/**
 * 执行记录列表（= B6 `listExecutions`）。排序与翻页语义全在 WakerDO：
 * `scheduledFor DESC, id DESC` + keyset 游标，前端只原样回传 `nextCursor`。
 */
export function listExecutions(
  query: ListExecutionsQueryParams = {},
): Promise<ListExecutionsResult> {
  const suffix = queryString([
    ['jobId', query.jobId],
    ['projectId', query.projectId],
    ['status', query.status],
    ['trigger', query.trigger],
    ['scheduledFrom', query.scheduledFrom],
    ['scheduledTo', query.scheduledTo],
    ['limit', query.limit],
    ['cursor', query.cursor],
  ])
  return request<ListExecutionsResult>(`/api/executions${suffix}`)
}

/** 死信列表（= B6 `listDeadLetters`）：未重放优先 → `createdAt DESC` → `id DESC`。 */
export function listDeadLetters(
  query: ListDeadLettersQueryParams = {},
): Promise<ListDeadLettersResult> {
  const suffix = queryString([
    ['jobId', query.jobId],
    ['projectId', query.projectId],
    ['replayState', query.replayState],
    ['createdFrom', query.createdFrom],
    ['createdTo', query.createdTo],
    ['limit', query.limit],
    ['cursor', query.cursor],
  ])
  return request<ListDeadLettersResult>(`/api/dead-letters${suffix}`)
}

/** 重放死信：平台以同一任务新建一条 `manual` 执行并重新投递，应答给出新的 `executionId`。 */
export function replayDeadLetter(deadLetterId: string): Promise<ReplayDeadLetterResult> {
  return request<ReplayDeadLetterResult>(
    `/api/dead-letters/${encodeURIComponent(deadLetterId)}/replay`,
    { method: 'POST' },
  )
}

/**
 * 501 占位判定：管理面还有子路径没挂载（`{ error: 'not_implemented', scope }`）。
 * 页面据此区分「后端还没上这个接口」与「请求真的失败」，提示语不同。
 */
export function isNotImplementedError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 501 || error.code === 'not_implemented')
}
