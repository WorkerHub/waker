import type { CronErrorCode, CronFieldName } from '../cron'
import type { WakerResult } from './types'

/**
 * WakerDO RPC 错误码（冻结契约的一部分）。
 *
 * 语义：
 *   - `invalid_*`：调用方入参问题（HTTP 400）
 *   - `duplicate_job`：同项目下任务名冲突（HTTP 409）
 *   - `duplicate_project`：项目名冲突（B4 新增，HTTP 409）
 *   - `name_conflict`：声明式清单里的名字被另一类任务占用（B4 新增，HTTP 409）
 *   - `job_not_found` / `execution_not_found` / `dead_letter_not_found` / `project_not_found`：
 *     目标不存在（HTTP 404；`project_not_found` 为 B4 新增）
 *   - `job_cancelled` / `job_not_resumable`：状态冲突（HTTP 409）
 *   - `signing_key_missing` / `callback_target_missing`：项目接入配置缺失（B3 新增，HTTP 409，
 *     执行侧遇到时直接判死进死信，不用同一必败原因重试）
 *   - `signing_key_unreadable`：库里的 signing key 解不开（B4 新增，HTTP 500；换过 JWT_SECRET
 *     或写入来源不合法导致，同样直接进死信不重试）
 *   - `internal`：平台内部错误（HTTP 500），调用方可重试
 *
 * B4（注册 API / 管理面）把 code 原样映射成 HTTP 错误体
 * `{ "error": { "code": string, "message": string, "details"?: object } }`，不得改写。
 */
export type WakerErrorCode =
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
  | 'execution_not_found'
  | 'dead_letter_not_found'
  | 'signing_key_missing'
  | 'signing_key_unreadable'
  | 'callback_target_missing'
  | 'internal'

/** `invalid_cron` 的 details：透出方言层错误码与字段，前端可精确定位。 */
export interface CronErrorDetails {
  readonly dialectCode: CronErrorCode
  readonly field: CronFieldName | null
}

export interface WakerErrorDetails {
  readonly cron?: CronErrorDetails
  readonly [key: string]: unknown
}

/** 领域错误：跨 RPC 边界携带稳定的 `code`，B4 直接映射 HTTP。 */
export class WakerError extends Error {
  readonly code: WakerErrorCode
  readonly details: WakerErrorDetails | null

  constructor(code: WakerErrorCode, message: string, details: WakerErrorDetails | null = null) {
    super(message)
    this.name = 'WakerError'
    this.code = code
    this.details = details
  }
}

/** 成功信封。 */
export function ok<T>(value: T): WakerResult<T> {
  return { ok: true, value }
}

/**
 * 把领域错误折成失败信封；非领域错误（真 bug / 平台异常）原样抛出，不被静默吞掉。
 */
export function toFailure(error: unknown): WakerResult<never> {
  if (error instanceof WakerError) {
    return {
      ok: false,
      error:
        error.details === null
          ? { code: error.code, message: error.message }
          : { code: error.code, message: error.message, details: error.details },
    }
  }
  throw error
}

/** 拆信封：调用方（B3 / B4 / watchdog）拿到值或抛出带 code 的 WakerError。 */
export function unwrap<T>(result: WakerResult<T>): T {
  if (result.ok) return result.value
  throw new WakerError(result.error.code, result.error.message, result.error.details ?? null)
}
