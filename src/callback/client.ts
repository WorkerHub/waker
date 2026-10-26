import type { JsonValue } from '../do/types'
import {
  CALLBACK_HEADERS,
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_SIGNATURE_ALGORITHM,
  type CallbackRequestBody,
  type CallbackResponseBody,
} from './protocol'
import { signCallback } from './sign'

/**
 * 回调投递：平台 → 下游 `/_waker/execute` 的**同步** HTTP 调用。
 *
 * 同步语义（SPEC §4 硬要求）：平台 await 到下游返回 2xx 才算这次执行成功。
 * 绝不 `waitUntil + 立即 OK` —— 那样分发方永远不知道成败，重试与死信都成了摆设。
 *
 * 传输层的所有能力都用原生：`fetch`（Workers 原生）、`AbortSignal.timeout`
 * （运行时原生的超时控制），不自研超时/连接管理。
 */

/** 下游地址 + 该项目当前 signing key（由 DO 提供；secret 绝不进日志/队列消息）。 */
export interface CallbackTarget {
  projectId: string
  projectName: string | null
  /** 完整回调地址（已拼 `/_waker/execute`）。 */
  callbackUrl: string
  /** 当前生效的 signing key id（审计用）。 */
  signingKeyId: string
  /** signing key 明文值（仅在本进程内用于签名，不落库、不落日志、不进队列）。 */
  signingSecret: string
}

/** 一次投递的结果。 */
export interface CallbackDelivery {
  ok: boolean
  httpStatus: number | null
  /** 失败原因（人类可读、已截断，绝不含密钥）。 */
  error: string | null
  /** 下游响应体原文（截断），供执行记录展示。 */
  responseBody: string | null
  /** 下游响应里声明的自续时刻（未校验，校验在 DO 里做）。 */
  nextRunAt: number | string | null
  startedAt: number
  finishedAt: number
  durationMs: number
}

const MAX_RESPONSE_BODY_BYTES = 4096
const MAX_ERROR_LENGTH = 500

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(截断)`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // AbortSignal.timeout 触发时 name === 'TimeoutError'（Workers 与 Node 一致）。
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout'
    return truncate(`${error.name}: ${error.message}`, MAX_ERROR_LENGTH)
  }
  return truncate(String(error), MAX_ERROR_LENGTH)
}

/** 从下游响应体里取 `nextRunAt`（只认 number / ISO 字符串 / null）。 */
export function extractNextRunAt(body: unknown): number | string | null {
  if (body === null || typeof body !== 'object') return null
  const raw = (body as CallbackResponseBody).nextRunAt
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  return null
}

/** 组装请求体（结构即冻结契约 {@link CallbackRequestBody}）。 */
export function buildCallbackBody(input: {
  executionId: string
  jobId: string
  projectId: string
  jobName: string
  kind: CallbackRequestBody['kind']
  trigger: CallbackRequestBody['trigger']
  misfire: boolean
  attempt: number
  scheduledFor: number
  dispatchedAt: number
  timeoutSeconds: number
  payload: JsonValue
}): CallbackRequestBody {
  return {
    protocolVersion: CALLBACK_PROTOCOL_VERSION,
    executionId: input.executionId,
    jobId: input.jobId,
    projectId: input.projectId,
    jobName: input.jobName,
    kind: input.kind,
    trigger: input.trigger,
    misfire: input.misfire,
    attempt: input.attempt,
    scheduledFor: input.scheduledFor,
    dispatchedAt: input.dispatchedAt,
    timeoutSeconds: input.timeoutSeconds,
    payload: input.payload,
  }
}

/**
 * 同步投递一次回调。
 *
 * - 2xx 才算成功（其它状态码一律失败，进重试/死信）；
 * - `timeoutSeconds` 用 `AbortSignal.timeout` 表达，超时按失败处理；
 * - 签名时间戳取「投递时刻」，每次重试重新签名（重放窗口自然刷新）；
 * - 任何异常都折成 `ok: false`，不向调用方抛错（consumer 只需分支）。
 */
export async function deliverCallback(input: {
  target: CallbackTarget
  body: CallbackRequestBody
  timeoutSeconds: number
  /** 注入时钟/签名器，测试可替换。 */
  now?: () => number
}): Promise<CallbackDelivery> {
  const now = input.now ?? Date.now
  const startedAt = now()
  const bodyText = JSON.stringify(input.body)
  const timestamp = String(Math.floor(startedAt / 1000))

  const signature = await signCallback({
    secret: input.target.signingSecret,
    timestamp,
    executionId: input.body.executionId,
    jobId: input.body.jobId,
    body: bodyText,
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': `waker-callback/${CALLBACK_PROTOCOL_VERSION}`,
    'x-waker-algorithm': CALLBACK_SIGNATURE_ALGORITHM,
    [CALLBACK_HEADERS.timestamp]: timestamp,
    [CALLBACK_HEADERS.executionId]: input.body.executionId,
    [CALLBACK_HEADERS.jobId]: input.body.jobId,
    [CALLBACK_HEADERS.projectId]: input.body.projectId,
    [CALLBACK_HEADERS.attempt]: String(input.body.attempt),
    [CALLBACK_HEADERS.signature]: signature,
    [CALLBACK_HEADERS.protocolVersion]: String(CALLBACK_PROTOCOL_VERSION),
  }

  const finish = (partial: {
    ok: boolean
    httpStatus: number | null
    error: string | null
    responseBody: string | null
    nextRunAt: number | string | null
  }): CallbackDelivery => {
    const finishedAt = now()
    return { ...partial, startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt) }
  }

  let response: Response
  try {
    response = await fetch(input.target.callbackUrl, {
      method: 'POST',
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(Math.max(1, input.timeoutSeconds) * 1000),
      // 回调必须打真实下游，禁止命中缓存。
      redirect: 'manual',
    })
  } catch (error) {
    return finish({
      ok: false,
      httpStatus: null,
      error: describeError(error),
      responseBody: null,
      nextRunAt: null,
    })
  }

  let text: string
  try {
    text = truncate(await response.text(), MAX_RESPONSE_BODY_BYTES)
  } catch (error) {
    // 2xx 但读 body 失败：不把这次执行判失败（业务已完成），只丢掉响应摘要。
    return finish({
      ok: response.ok,
      httpStatus: response.status,
      error: response.ok ? null : `response_body_unreadable: ${describeError(error)}`,
      responseBody: null,
      nextRunAt: null,
    })
  }

  let nextRunAt: number | string | null = null
  if (response.ok && text.length > 0) {
    try {
      nextRunAt = extractNextRunAt(JSON.parse(text))
    } catch {
      // 2xx 但响应体不是 JSON：允许（下游可以回 204 / 空体 / 纯文本），只是无法自续。
      nextRunAt = null
    }
  }

  return finish({
    ok: response.ok,
    httpStatus: response.status,
    error: response.ok
      ? null
      : truncate(`HTTP ${response.status}${text.length > 0 ? `: ${text}` : ''}`, MAX_ERROR_LENGTH),
    responseBody: text.length > 0 ? text : null,
    nextRunAt,
  })
}
