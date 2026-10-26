import type { Context, Env as HonoEnv } from 'hono'

import type { WakerErrorCode } from '../do/errors'
import type { WakerResult } from '../do/types'

/**
 * HTTP 层的错误映射（B4 冻结契约的一部分）。
 *
 * 规则：**RPC 的 `code` 原样透出**，只补一个 HTTP 状态码 —— SDK / 前端 / CI 都按 `code`
 * 分支，不解析文案、不依赖状态码猜原因。`errors.ts` 里的「HTTP 建议」即本表。
 *
 * 错误体固定为：
 * ```json
 * { "error": { "code": "invalid_cron", "message": "...", "details": { ... } } }
 * ```
 * `details` 只在有结构化信息时出现（如 `invalid_cron` 的 `{ name, cron: { dialectCode, field } }`）。
 */

/** RPC 错误码 + HTTP 层自己的三种码。 */
export type ApiErrorCode = WakerErrorCode | 'unauthorized' | 'invalid_json' | 'not_found'

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  // 调用方入参问题
  invalid_argument: 400,
  invalid_cron: 400,
  invalid_timezone: 400,
  invalid_run_at: 400,
  invalid_policy: 400,
  invalid_json: 400,
  // 鉴权
  unauthorized: 401,
  // 不存在
  not_found: 404,
  job_not_found: 404,
  project_not_found: 404,
  execution_not_found: 404,
  dead_letter_not_found: 404,
  // 状态 / 唯一性冲突
  duplicate_job: 409,
  duplicate_project: 409,
  name_conflict: 409,
  job_cancelled: 409,
  job_not_resumable: 409,
  signing_key_missing: 409,
  callback_target_missing: 409,
  // 平台侧问题
  signing_key_unreadable: 500,
  internal: 500,
}

export function httpStatusFor(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
}

/** 直接回一个错误体（HTTP 层自己的错误：401 / 坏 JSON / 404）。 */
export function jsonError<E extends HonoEnv>(
  c: Context<E>,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): Response {
  return c.json(errorBody(code, message, details), httpStatusFor(code) as 400)
}

/**
 * RPC 结果 → HTTP 响应。
 *
 * 成功：`body(value)` 决定响应体；失败：`code` 原样透出（含 `details`）。
 */
export function respond<E extends HonoEnv, T>(
  c: Context<E>,
  result: WakerResult<T>,
  body: (value: T) => unknown,
  status = 200,
): Response {
  if (!result.ok) {
    return jsonError(c, result.error.code, result.error.message, result.error.details)
  }
  return c.json(body(result.value) as object, status as 200)
}

/** 解析 JSON 请求体；非法 JSON 回统一的 `invalid_json`（不让 Hono 抛 400 文本）。 */
export async function readJson<E extends HonoEnv>(c: Context<E>): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() }
  } catch {
    return { ok: false }
  }
}

/** 从查询串里取可选字符串参数（空串视为未提供）。 */
export function queryValue<E extends HonoEnv>(c: Context<E>, name: string): string | undefined {
  const raw = c.req.query(name)
  return raw === undefined || raw.length === 0 ? undefined : raw
}

/** 从查询串里取可选整数参数；非法值交给 RPC 去报 `invalid_argument`。 */
export function queryInt<E extends HonoEnv>(c: Context<E>, name: string): number | undefined {
  const raw = queryValue(c, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isNaN(parsed) ? Number.NaN : parsed
}
