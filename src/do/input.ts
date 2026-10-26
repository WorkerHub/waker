import {
  CronDialectError,
  assertTimezone,
  createCronSchedule,
  type CronSchedule,
} from '../cron'
import { WakerError } from './errors'
import {
  DEFAULT_JOB_POLICIES,
  type ConcurrencyPolicy,
  type JobPolicies,
  type JobRef,
  type JsonValue,
  type MisfirePolicy,
} from './types'

/**
 * 入参校验与规范化：RPC 边界上的唯一入口。
 *
 * 目标是把「调用方给的东西」一次性收窄成内部类型，并对不合规输入抛出带稳定错误码的
 * {@link WakerError}；DO 方法体只处理已校验过的数据，不再到处 `typeof`。
 */

export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200

export const MAX_NAME_LENGTH = 200

const POLICY_LIMITS = {
  maxRetries: [0, 100],
  backoffSeconds: [0, 86_400],
  timeoutSeconds: [1, 86_400],
  jitterSeconds: [0, 3_600],
} as const

const MISFIRE_POLICIES: readonly MisfirePolicy[] = ['fire_once', 'skip', 'fire_all']
const CONCURRENCY_POLICIES: readonly ConcurrencyPolicy[] = ['forbid', 'allow']

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WakerError('invalid_argument', `${field} 必须是非空字符串`)
  }
  return value.trim()
}

/** 解析并校验 IANA 时区（cron / one_shot 两类任务都必须校验），默认 UTC。 */
export function resolveTimezone(value: string | undefined): string {
  const timezone = value === undefined ? 'UTC' : requireString(value, 'timezone')
  try {
    assertTimezone(timezone)
  } catch (error) {
    if (error instanceof CronDialectError) {
      throw new WakerError('invalid_timezone', error.message)
    }
    throw error
  }
  return timezone
}

/** 非负整数（用于 attempt / 重试次数一类计数）：负数、小数、NaN 均报 `invalid_argument`。 */
export function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new WakerError('invalid_argument', `${field} 必须是整数`)
  }
  if (value < 0) {
    throw new WakerError('invalid_argument', `${field} 不能为负数`)
  }
  return value
}

export function toEpochMs(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WakerError('invalid_run_at', 'runAt 必须是有限数字（epoch 毫秒）')
    const ms = Math.trunc(value)
    if (ms < 0) throw new WakerError('invalid_run_at', 'runAt 不能为负数')
    return ms
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) {
      throw new WakerError('invalid_run_at', `runAt 既不是 epoch 毫秒也不是合法 ISO 8601 字符串：${value}`)
    }
    return ms
  }
  throw new WakerError('invalid_run_at', 'one_shot 任务必须提供 runAt（epoch 毫秒或 ISO 8601 字符串）')
}

export function normalizePayload(payload: JsonValue | undefined): JsonValue {
  if (payload === undefined) return null
  try {
    return JSON.parse(JSON.stringify(payload)) as JsonValue
  } catch {
    throw new WakerError('invalid_argument', 'payload 必须是 JSON 可序列化值')
  }
}

export function resolvePolicies(input: Partial<JobPolicies> | undefined): JobPolicies {
  if (input === undefined) return { ...DEFAULT_JOB_POLICIES }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WakerError('invalid_policy', 'policies 必须是对象，不能是数组等其它类型')
  }

  const misfire = input.misfire ?? DEFAULT_JOB_POLICIES.misfire
  if (!MISFIRE_POLICIES.includes(misfire)) {
    throw new WakerError('invalid_policy', `misfire 必须是 ${MISFIRE_POLICIES.join(' / ')}`)
  }

  const concurrency = input.concurrency ?? DEFAULT_JOB_POLICIES.concurrency
  if (!CONCURRENCY_POLICIES.includes(concurrency)) {
    throw new WakerError('invalid_policy', `concurrency 必须是 ${CONCURRENCY_POLICIES.join(' / ')}`)
  }

  return {
    misfire,
    concurrency,
    maxRetries: requireIntInRange(input.maxRetries, 'maxRetries', POLICY_LIMITS.maxRetries),
    backoffSeconds: requireIntInRange(
      input.backoffSeconds,
      'backoffSeconds',
      POLICY_LIMITS.backoffSeconds,
    ),
    timeoutSeconds: requireIntInRange(
      input.timeoutSeconds,
      'timeoutSeconds',
      POLICY_LIMITS.timeoutSeconds,
    ),
    jitterSeconds: requireIntInRange(
      input.jitterSeconds,
      'jitterSeconds',
      POLICY_LIMITS.jitterSeconds,
    ),
  }
}

export function requireIntInRange(
  value: number | undefined,
  field: keyof JobPolicies,
  [min, max]: readonly [number, number],
): number {
  if (value === undefined) return DEFAULT_JOB_POLICIES[field] as number
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new WakerError('invalid_policy', `${field} 必须是整数`)
  }
  if (value < min || value > max) {
    throw new WakerError('invalid_policy', `${field} 必须在 ${min}-${max} 之间`)
  }
  return value
}

export function buildSchedule(expression: string, timezone: string): CronSchedule {
  try {
    return createCronSchedule(expression, { timezone })
  } catch (error) {
    if (error instanceof CronDialectError) {
      if (error.code === 'cron_invalid_timezone') {
        throw new WakerError('invalid_timezone', error.message)
      }
      throw new WakerError('invalid_cron', error.message, {
        cron: { dialectCode: error.code, field: error.field },
      })
    }
    throw error
  }
}

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new WakerError('invalid_argument', 'limit 必须是 ≥ 1 的整数')
  }
  return Math.min(limit, MAX_LIST_LIMIT)
}

/** 游标：`next_run_at`(或 `n` 表示 NULL) + `|` + id；对调用方不透明。 */
export function encodeCursor(cursor: { nextRunAt: number | null; id: string }): string {
  return `${cursor.nextRunAt === null ? 'n' : cursor.nextRunAt}|${cursor.id}`
}

export function decodeCursor(raw: string): { nextRunAt: number | null; id: string } {
  const separator = raw.indexOf('|')
  if (separator <= 0 || separator === raw.length - 1) {
    throw new WakerError('invalid_argument', 'cursor 不是本接口返回的值')
  }
  const head = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  if (head === 'n') return { nextRunAt: null, id }
  const nextRunAt = Number(head)
  if (!Number.isFinite(nextRunAt)) {
    throw new WakerError('invalid_argument', 'cursor 不是本接口返回的值')
  }
  return { nextRunAt, id }
}

export function describeRef(ref: JobRef): string {
  return 'jobId' in ref ? `任务不存在：${ref.jobId}` : `任务不存在：${ref.projectId}/${ref.name}`
}
