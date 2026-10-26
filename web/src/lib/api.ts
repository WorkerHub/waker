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

/** 管理面错误码（B2/B3/B4 冻结契约的超集里，只会命中前端可能触发的那些）。 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'invalid_json'
  | 'invalid_argument'
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
  error?: { code?: string; message?: string; details?: unknown }
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
    const code = payload.error?.code ?? 'internal'
    const message = payload.error?.message ?? `请求失败（HTTP ${response.status}）`

    if (response.status === 401 && path !== '/api/auth/setup') {
      authToken = null
      onUnauthorized()
    }
    throw new ApiError(response.status, code, message, payload.error?.details)
  }

  return body as T
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value ?? {})
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
  const params = new URLSearchParams()
  if (query.projectId) params.set('projectId', query.projectId)
  if (query.status) params.set('status', query.status)
  if (query.kind) params.set('kind', query.kind)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
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
