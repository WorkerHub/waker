import {
  WAKER_TOKEN_ENV,
  WAKER_URL_ENV,
  isWakerEnabled,
  readEnvString,
  type WakerEnvLike,
} from './modes'
import type { JsonValue } from './protocol'
import { CALLBACK_PROTOCOL_VERSION } from './protocol'

/**
 * 注册客户端：调 B4 冻结的注册 API（`/v1/*`，项目令牌鉴权）。
 *
 * 覆盖下游真正需要的五件事：
 *   - `whoami()`            令牌自检（CI / 启动期 sanity check）
 *   - `syncManifest()`      部署期声明式任务同步 + 对账（幂等）
 *   - `createOneShot()`     运行时创建一次性任务（`runAt` 毫秒 / ISO / Date）
 *   - `cancelJob()`         取消 one-shot（幂等）
 *   - `listJobs()`          本项目任务列表（分页游标同平台契约）
 *
 * 传输层全部用原生：`fetch` + `AbortSignal.timeout`，不自研重试/超时。平台不可达时的重试
 * 交给调用方（部署期 CI 重跑、运行时业务自己兜底），客户端不隐藏失败。
 *
 * 项目身份**只来自令牌**：请求体里不带 `projectId`（平台也会拒绝不一致的写法）。
 */

export type WakerJobKind = 'cron' | 'one_shot'
export type WakerJobStatus = 'active' | 'paused' | 'cancelled' | 'completed'
export type WakerMisfirePolicy = 'fire_once' | 'skip' | 'fire_all'
export type WakerConcurrencyPolicy = 'forbid' | 'allow'

/** 任务策略字段（与平台 `JobPolicies` 一致；未传字段取平台默认值）。 */
export interface WakerJobPolicies {
  misfire: WakerMisfirePolicy
  concurrency: WakerConcurrencyPolicy
  maxRetries: number
  backoffSeconds: number
  timeoutSeconds: number
  jitterSeconds: number
}

/** 任务视图（与平台 `JobView` 一致）。 */
export interface WakerJobView {
  id: string
  projectId: string
  name: string
  kind: WakerJobKind
  cron: string | null
  cronNormalized: string | null
  timezone: string
  runAt: number | null
  payload: JsonValue
  policies: WakerJobPolicies
  status: WakerJobStatus
  nextRunAt: number | null
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

/** 创建任务入参（= `CreateJobInput` 去掉 `projectId`：项目由令牌决定）。 */
export interface CreateWakerJobInput {
  name: string
  kind: WakerJobKind
  /** `kind: 'cron'` 必填：CF 官方方言 5 字段表达式。 */
  cron?: string
  /** `kind: 'one_shot'` 必填：epoch ms 或 ISO 8601 字符串。 */
  runAt?: number | string
  timezone?: string
  payload?: JsonValue
  policies?: Partial<WakerJobPolicies>
  enabled?: boolean
}

/** 运行时创建一次性任务：`runAt` 额外接受 `Date`（内部转 epoch ms）。 */
export interface CreateOneShotInput {
  name: string
  runAt: number | string | Date
  timezone?: string
  payload?: JsonValue
  policies?: Partial<WakerJobPolicies>
  /** false = 创建后先暂停。默认 true。 */
  enabled?: boolean
}

/** 声明式清单里的一条任务（与平台 `ManifestJobInput` 一致，只支持 cron）。 */
export interface WakerManifestJob {
  name: string
  cron: string
  timezone?: string
  payload?: JsonValue
  policies?: Partial<WakerJobPolicies>
  enabled?: boolean
}

/** 清单对账结果（与平台 `SyncManifestResult` 一致）。 */
export interface WakerManifestSyncResult {
  projectId: string
  created: string[]
  updated: string[]
  unchanged: string[]
  paused: string[]
  jobs: WakerJobView[]
}

export interface WakerJobListResult {
  jobs: WakerJobView[]
  nextCursor: string | null
}

export interface WakerJobListQuery {
  status?: WakerJobStatus
  kind?: WakerJobKind
  limit?: number
  cursor?: string | null
}

export interface WakerProjectIdentity {
  id: string
  name: string
}

/**
 * 平台返回的错误（`{ error: { code, message, details? } }`）。
 *
 * `code` 是冻结契约里的稳定错误码（`unauthorized` / `invalid_cron` / `job_not_found` / …），
 * 调用方按 `code` 分支，不解析文案、不按状态码猜原因。
 */
export class WakerApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(input: { status: number; code: string; message: string; details?: unknown }) {
    super(`[${input.status} ${input.code}] ${input.message}`)
    this.name = 'WakerApiError'
    this.status = input.status
    this.code = input.code
    this.details = input.details ?? null
  }
}

export interface WakerClientOptions {
  /** 平台根地址，如 `https://waker.oneboy.app`（不带 `/v1`）。 */
  baseUrl: string
  /** 项目令牌（`Authorization: Bearer <项目令牌>`）。只从 secrets 注入。 */
  token: string
  /** 注入 fetch（测试 / 特殊运行时）。 */
  fetch?: typeof fetch
  /** 单次请求超时（毫秒），默认 10s。 */
  timeoutMs?: number
}

export interface WakerClient {
  whoami(): Promise<WakerProjectIdentity>
  listJobs(query?: WakerJobListQuery): Promise<WakerJobListResult>
  createJob(input: CreateWakerJobInput): Promise<WakerJobView>
  createOneShot(input: CreateOneShotInput): Promise<WakerJobView>
  cancelJob(name: string): Promise<WakerJobView>
  syncManifest(jobs: WakerManifestJob[]): Promise<WakerManifestSyncResult>
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown }
}

function normalizeRunAt(runAt: number | string | Date): number | string {
  return runAt instanceof Date ? runAt.getTime() : runAt
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 建一个注册客户端。
 *
 * ```ts
 * const waker = createWakerClient({ baseUrl: env.WAKER_URL, token: env.WAKER_TOKEN })
 * await waker.createOneShot({ name: `letter-${letter.id}`, runAt: deliverAt, payload: { letterId } })
 * ```
 */
export function createWakerClient(options: WakerClientOptions): WakerClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
  if (baseUrl.length === 0) throw new Error('createWakerClient: baseUrl 不能为空')
  if (options.token.trim().length === 0) throw new Error('createWakerClient: token 不能为空')

  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000

  async function request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
      'user-agent': `waker-sdk/${CALLBACK_PROTOCOL_VERSION}`,
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })

    const text = await response.text()
    const payload: unknown = text.length === 0 ? null : safeJson(text)

    if (!response.ok) {
      const envelope = (payload ?? {}) as ErrorEnvelope
      throw new WakerApiError({
        status: response.status,
        code: typeof envelope.error?.code === 'string' ? envelope.error.code : `http_${response.status}`,
        message: typeof envelope.error?.message === 'string' ? envelope.error.message : text.slice(0, 500),
        details: envelope.error?.details,
      })
    }

    return payload as T
  }

  return {
    async whoami() {
      const result = await request<{ project: WakerProjectIdentity }>('/v1/whoami')
      return result.project
    },

    async listJobs(query = {}) {
      const search = new URLSearchParams()
      if (query.status !== undefined) search.set('status', query.status)
      if (query.kind !== undefined) search.set('kind', query.kind)
      if (query.limit !== undefined) search.set('limit', String(query.limit))
      if (query.cursor !== undefined && query.cursor !== null) search.set('cursor', query.cursor)
      const suffix = search.size === 0 ? '' : `?${search.toString()}`
      return request<WakerJobListResult>(`/v1/jobs${suffix}`)
    },

    async createJob(input) {
      const result = await request<{ job: WakerJobView }>('/v1/jobs', {
        method: 'POST',
        body: input,
      })
      return result.job
    },

    async createOneShot(input) {
      const body: CreateWakerJobInput = {
        name: input.name,
        kind: 'one_shot',
        runAt: normalizeRunAt(input.runAt),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.policies === undefined ? {} : { policies: input.policies }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }
      const result = await request<{ job: WakerJobView }>('/v1/jobs', { method: 'POST', body })
      return result.job
    },

    async cancelJob(name) {
      const result = await request<{ job: WakerJobView }>(
        `/v1/jobs/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      return result.job
    },

    async syncManifest(jobs) {
      return request<WakerManifestSyncResult>('/v1/manifest', {
        method: 'PUT',
        body: { jobs },
      })
    },
  }
}

export interface CreateWakerClientFromEnvOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  /** `true` = 已启用 waker 但 `WAKER_URL` / `WAKER_TOKEN` 缺失时抛错（部署期 fail fast）。 */
  required?: boolean
}

/**
 * 可选接入的客户端入口：**只有 `WAKER_MODE=waker` 时才构造客户端**。
 *
 * - 原生模式（缺省）：返回 `null` —— 不构造、不读令牌、不发请求；
 * - waker 模式但 `WAKER_URL` / `WAKER_TOKEN` 缺失：默认也返回 `null`（等同未启用），
 *   传 `required: true` 则抛错，用于部署期自检。
 */
export function createWakerClientFromEnv(
  env: WakerEnvLike,
  options: CreateWakerClientFromEnvOptions = {},
): WakerClient | null {
  if (!isWakerEnabled(env)) return null

  const baseUrl = readEnvString(env, WAKER_URL_ENV)
  const token = readEnvString(env, WAKER_TOKEN_ENV)
  if (baseUrl === null || token === null) {
    if (options.required === true) {
      throw new Error(
        `WAKER_MODE=waker 但 ${WAKER_URL_ENV} / ${WAKER_TOKEN_ENV} 未配置：` +
          '请把平台根地址写进 [vars]、项目令牌用 `wrangler secret put` 注入。',
      )
    }
    return null
  }

  return createWakerClient({
    baseUrl,
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
}
