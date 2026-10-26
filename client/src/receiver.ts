import { Hono } from 'hono'
import type { Context, Env } from 'hono'

import type { ExecutionLedger } from './ledger'
import {
  CALLBACK_HEADERS,
  CALLBACK_MOUNT_PATH,
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  type CallbackRequestBody,
  type ExecutionTrigger,
  type JobKind,
  type JsonValue,
  type NextRunAt,
} from './protocol'
import {
  WAKER_MODE_WAKER,
  WAKER_SIGNING_KEY_ENV,
  readEnvString,
  resolveWakerMode,
  type WakerEnvLike,
  type WakerMode,
} from './modes'
import { verifyWakerSignature } from './verify'

/**
 * 下游 receiver：`app.route('/_waker', createWakerReceiver({ jobs }))`。
 *
 * 设计要点（对齐 B3 回调协议 v2）：
 *   - **不劫持整个 fetch**：只是一个 `/_waker/execute` 路由，下游其它路由完全不受影响；
 *   - **同步语义**：handler 返回（或 await 完成）后才回 2xx，失败回 5xx 让平台重试，
 *     绝不 `waitUntil + 立即 OK`；
 *   - **验签在前**：body 用未解析的原始字符串验签，时间窗默认 300s；
 *   - **幂等**：可选 `ledger`（`client/src/ledger.ts`）。重复投递直接回 2xx + 首次响应体回放，
 *     业务失败则释放占位，让平台的重试真的重跑；
 *   - **自续**：handler 返回 `{ nextRunAt }` 即透传给平台（平台自己再校验上限与时序）。
 */

/** receiver 内可用的上下文：只给业务需要的字段，不外泄平台内部结构。 */
export interface WakerJobContext {
  /** 任务名（= `jobs` 表的 key）。 */
  jobName: string
  /** 执行 id：**下游幂等键**（同一次执行的重试共享）。 */
  executionId: string
  /** 任务 id（自续后仍是同一个 job 系列）。 */
  jobId: string
  projectId: string
  kind: JobKind
  trigger: ExecutionTrigger
  misfire: boolean
  /** 第几次投递，0 = 首次。 */
  attempt: number
  /** 名义到期时刻（epoch ms）。 */
  scheduledFor: number
  /** 平台投递时刻（epoch ms）。 */
  dispatchedAt: number
  /** 平台侧超时（秒）：业务应在此之前返回。 */
  timeoutSeconds: number
  /** 任务载荷（原样透传，平台不解析）。 */
  payload: JsonValue
}

/**
 * handler 返回值：可以什么都不返回（= 任务完结），也可以带上 `nextRunAt` 自续。
 * 其它字段会原样回给平台（平台忽略），方便下游在响应里带业务信息排障。
 */
export interface WakerJobOutcome {
  /** 自续时刻：epoch ms 或 ISO 8601；不提供 = 任务完结（只对 one-shot 生效）。 */
  nextRunAt?: NextRunAt | null
  [key: string]: unknown
}

export type WakerJobHandler = (
  context: WakerJobContext,
) => WakerJobOutcome | void | Promise<WakerJobOutcome | void>

/** 任务名 → handler。名字与平台里注册的任务名逐字一致（manifest 里声明的同一份名字）。 */
export type WakerJobHandlers = Record<string, WakerJobHandler>

/**
 * 任务名解析器：one-shot 的任务名常常按业务 id 动态生成（`letter-<id>` / `reminder-tick-<id>`），
 * 静态 map 装不下，所以也允许传「名字 → handler」的函数（返回 `null` = 未声明该任务）。
 */
export type WakerJobResolver = (jobName: string) => WakerJobHandler | null | undefined

/** `jobs`：静态 map，或名字解析函数。 */
export type WakerJobs = WakerJobHandlers | WakerJobResolver

/** 与下游 env 无耦合的最小 Hono 绑定类型。 */
export interface WakerReceiverEnv {
  Bindings: Record<string, unknown>
}

export interface WakerReceiverOptions {
  /** 任务名 → handler（静态 map 或解析函数）。 */
  jobs: WakerJobs
  /**
   * 项目 signing key：静态字符串，或从 env 解析的函数。
   * 缺省从 `env[signingKeyEnv]`（默认 `WAKER_SIGNING_KEY`）读取——只从 secrets 注入。
   */
  signingKey?: string | ((env: WakerEnvLike) => string | null)
  /** 从 env 读 signing key 的变量名，默认 `WAKER_SIGNING_KEY`。 */
  signingKeyEnv?: string
  /** 幂等账本（可选：不传 = 不做去重，平台的重试会重跑业务）。 */
  ledger?: ExecutionLedger
  /** 注入时钟（epoch ms），测试可替换。 */
  now?: () => number
  /** 验签时间窗（秒），默认 {@link CALLBACK_TIMESTAMP_TOLERANCE_SECONDS}。 */
  toleranceSeconds?: number
  /** 业务 handler 抛错时的回调（打日志/告警用；不回给平台，平台只看状态码）。 */
  onJobError?: (error: unknown, context: WakerJobContext) => void
}

/** 错误响应体（与平台侧错误体同构：`{ error: { code, message } }`，另加 `ok: false`）。 */
export interface WakerReceiverErrorBody {
  ok: false
  error: { code: string; message: string }
}

function errorBody(code: string, message: string): WakerReceiverErrorBody {
  return { ok: false, error: { code, message } }
}

/** 规范化 `nextRunAt`：只认有限数字与非空字符串，其它一律丢弃（平台校验上限与时序）。 */
function normalizeNextRunAt(value: unknown): NextRunAt | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return null
}

function resolveSigningKey(options: WakerReceiverOptions, env: WakerEnvLike): string | null {
  if (typeof options.signingKey === 'string') {
    return options.signingKey.trim().length === 0 ? null : options.signingKey.trim()
  }
  if (typeof options.signingKey === 'function') return options.signingKey(env)
  return readEnvString(env, options.signingKeyEnv ?? WAKER_SIGNING_KEY_ENV)
}

function readBodyFields(body: CallbackRequestBody): boolean {
  return (
    typeof body.executionId === 'string' &&
    body.executionId.length > 0 &&
    typeof body.jobId === 'string' &&
    body.jobId.length > 0 &&
    typeof body.jobName === 'string' &&
    body.jobName.length > 0 &&
    typeof body.scheduledFor === 'number'
  )
}

/**
 * 建一个只负责 `POST /execute` 的子应用。
 *
 * 挂载方式（下游）：`app.route('/_waker', createWakerReceiver({ jobs }))`，
 * 或直接用 {@link mountWakerReceiver} 走「可选接入」判定。
 */
export function createWakerReceiver(options: WakerReceiverOptions): Hono<WakerReceiverEnv> {
  const receiver = new Hono<WakerReceiverEnv>()
  const now = options.now ?? Date.now

  receiver.post('/execute', async (c: Context<WakerReceiverEnv>) => {
    // 1) 原始 body 必须先拿到：验签用的是未解析的字节串。
    const rawBody = await c.req.text()

    const timestamp = c.req.header(CALLBACK_HEADERS.timestamp) ?? ''
    const executionIdHeader = c.req.header(CALLBACK_HEADERS.executionId) ?? ''
    const jobIdHeader = c.req.header(CALLBACK_HEADERS.jobId) ?? ''
    const signature = c.req.header(CALLBACK_HEADERS.signature) ?? ''

    if (
      timestamp.length === 0 ||
      executionIdHeader.length === 0 ||
      jobIdHeader.length === 0 ||
      signature.length === 0
    ) {
      return c.json(errorBody('invalid_request', '缺少签名头（X-Waker-Timestamp / X-Waker-Execution-Id / X-Waker-Job-Id / X-Waker-Signature）'), 400)
    }

    // 2) 验签：时间窗之外的请求一律拒收（防重放）。
    const env = c.env as WakerEnvLike
    const secret = resolveSigningKey(options, env)
    if (secret === null) {
      // fail closed：没有 signing key 就绝不「看起来正常地」放行。
      return c.json(errorBody('signing_key_missing', '服务端未配置 WAKER_SIGNING_KEY，无法验签'), 500)
    }

    const verification = await verifyWakerSignature({
      secret,
      signature,
      timestamp,
      executionId: executionIdHeader,
      jobId: jobIdHeader,
      body: rawBody,
      now: now(),
      toleranceSeconds: options.toleranceSeconds ?? CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
    })
    if (!verification.ok) {
      const stale = verification.reason === 'stale_timestamp'
      return c.json(
        errorBody(
          stale ? 'stale_timestamp' : 'invalid_signature',
          stale ? '请求时间戳超出允许窗口（可能是重放）' : `签名校验失败（${verification.reason}）`,
        ),
        401,
      )
    }

    // 3) 解析并校验请求体（签名已覆盖 body，这里只做结构断言，不做信任边界判定）。
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return c.json(errorBody('invalid_request', '请求体不是合法 JSON'), 400)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return c.json(errorBody('invalid_request', '请求体必须是 JSON 对象'), 400)
    }
    const body = parsed as CallbackRequestBody
    if (body.protocolVersion !== CALLBACK_PROTOCOL_VERSION) {
      return c.json(
        errorBody('unsupported_protocol', `不支持的协议版本：${String(body.protocolVersion)}（期望 ${CALLBACK_PROTOCOL_VERSION}）`),
        400,
      )
    }
    if (!readBodyFields(body)) {
      return c.json(errorBody('invalid_request', '请求体缺少 executionId / jobId / jobName / scheduledFor'), 400)
    }
    if (body.executionId !== executionIdHeader || body.jobId !== jobIdHeader) {
      return c.json(errorBody('invalid_request', '请求体 id 与签名头不一致'), 400)
    }

    // 4) 分发到业务 handler：名字必须与注册时一致，未知名字是部署期错误，明确回 404。
    const handler =
      typeof options.jobs === 'function'
        ? options.jobs(body.jobName) ?? undefined
        : options.jobs[body.jobName]
    if (handler === undefined) {
      return c.json(
        errorBody('unknown_job', `未声明的任务名：${body.jobName}（receiver 的 jobs 里没有这个 key）`),
        404,
      )
    }

    const context: WakerJobContext = {
      jobName: body.jobName,
      executionId: body.executionId,
      jobId: body.jobId,
      projectId: body.projectId,
      kind: body.kind,
      trigger: body.trigger,
      misfire: body.misfire === true,
      attempt: typeof body.attempt === 'number' ? body.attempt : 0,
      scheduledFor: body.scheduledFor,
      dispatchedAt: body.dispatchedAt,
      timeoutSeconds: body.timeoutSeconds,
      payload: body.payload,
    }

    // 5) 幂等：同一次执行的重试直接回放首次结果（不重跑业务，也不丢 nextRunAt）。
    if (options.ledger !== undefined) {
      const claim = await options.ledger.claim({
        executionId: context.executionId,
        jobId: context.jobId,
        jobName: context.jobName,
        scheduledFor: context.scheduledFor,
      })
      if (!claim.claimed) {
        return c.json({
          ...(claim.existing?.response ?? {}),
          ok: true,
          duplicate: true,
        })
      }
    }

    // 6) 跑业务：异常 → 释放占位 + 5xx，让平台重试（重试仍是同一个 executionId）。
    try {
      const outcome = await handler(context)
      const nextRunAt = normalizeNextRunAt(outcome?.nextRunAt)
      // 业务字段原样回给平台（平台只认 nextRunAt，其它字段留着排障），`ok` 由 SDK 兜底置真。
      const response: Record<string, unknown> = { ...(outcome ?? {}), ok: true }
      if (nextRunAt === null) delete response.nextRunAt
      else response.nextRunAt = nextRunAt

      await options.ledger?.complete(context.executionId, response)
      return c.json(response)
    } catch (error) {
      await options.ledger?.release(context.executionId)
      options.onJobError?.(error, context)
      return c.json(errorBody('job_failed', '任务执行失败，平台将按策略重试'), 500)
    }
  })

  return receiver
}

export interface MountWakerReceiverOptions extends WakerReceiverOptions {
  /** 显式模式（优先于 `env`）。 */
  mode?: WakerMode
  /** 模式来源：`WAKER_MODE` 从这里读，缺省按 `cron`。 */
  env?: WakerEnvLike
}

/**
 * 可选接入的挂载入口：**只在 `WAKER_MODE=waker` 时**把 receiver 挂到 `/_waker`。
 *
 * 返回 `true` = 已挂载（waker 模式）；`false` = 原生模式，一条路由都没加。
 * 原生模式下 SDK 只做了一次 env 判定，不构造 receiver、不发任何网络请求。
 *
 * waker 模式下若 signing key 缺失会**立刻抛错**（部署期 fail fast），
 * 而不是等到第一次回调才发现验不了签。
 */
export function mountWakerReceiver<E extends Env>(
  app: Hono<E>,
  options: MountWakerReceiverOptions,
): boolean {
  const mode = options.mode ?? resolveWakerMode(options.env)
  if (mode !== WAKER_MODE_WAKER) return false

  const key = resolveSigningKey(options, options.env ?? null)
  if (key === null) {
    throw new Error(
      `WAKER_MODE=waker 但缺少 signing key（${options.signingKeyEnv ?? WAKER_SIGNING_KEY_ENV}）：` +
        '请用 `wrangler secret put` 注入建项目时一次性展示的那把 key。',
    )
  }

  const receiver = createWakerReceiver(options)
  app.route(CALLBACK_MOUNT_PATH, receiver as unknown as Hono<E>)
  return true
}
