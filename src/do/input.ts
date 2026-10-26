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
  type DeadLetterReplayState,
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

/** 项目名长度上限（管理面展示用，与任务名分开限）。 */
export const MAX_PROJECT_NAME_LENGTH = 100

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

/**
 * 校验枚举型筛选值（B6 查询 RPC 用）。
 *
 * 为什么不像 `listJobs` 那样直接把字符串拼进 SQL 绑定：状态/触发方式写错时
 * 返回「空列表」会把「参数错了」伪装成「没有数据」，查询页会白屏而没人发现；
 * 这里直接 `invalid_argument`，调用方（HTTP 面 → 400）能立刻定位。
 */
export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const raw = requireString(value, field)
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new WakerError('invalid_argument', `${field} 必须是 ${allowed.join(' / ')}`)
  }
  return raw as T
}

/** 时间区间端点（epoch ms，整数、非负）；`undefined` = 该侧不设限。 */
export function requireTimeBound(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new WakerError('invalid_argument', `${field} 必须是整数 epoch 毫秒`)
  }
  if (value < 0) throw new WakerError('invalid_argument', `${field} 不能为负数`)
  return value
}

/** 半开区间 `[from, to)`：两端都给时必须 `from <= to`（相等 = 空区间，是合法查询）。 */
export function requireTimeRange(
  from: number | undefined,
  to: number | undefined,
  fromField: string,
  toField: string,
): void {
  if (from !== undefined && to !== undefined && from > to) {
    throw new WakerError('invalid_argument', `${fromField} 不能大于 ${toField}`)
  }
}

/** 可选筛选值（字符串类、非枚举）：`undefined` / `null` 视为不过滤。 */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field)
}

/**
 * 游标前缀：不同列表的游标不能互用（混用会得到「看起来能翻、实际乱序」的结果）。
 * 前缀让误用当场报 `invalid_argument`，而不是静默返回错页。
 */
const EXECUTION_CURSOR_PREFIX = 'e1'
const DEAD_LETTER_CURSOR_PREFIX = 'd1'

function joinCursor(parts: (string | number)[]): string {
  return parts.join('|')
}

function splitCursor(raw: unknown, prefix: string, expectedParts: number, label: string): string[] {
  if (typeof raw !== 'string') {
    throw new WakerError('invalid_argument', `${label} cursor 不是本接口返回的值`)
  }
  const parts = raw.split('|')
  if (parts.length !== expectedParts || parts[0] !== prefix) {
    throw new WakerError('invalid_argument', `${label} cursor 不是本接口返回的值`)
  }
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index] === '') {
      throw new WakerError('invalid_argument', `${label} cursor 不是本接口返回的值`)
    }
  }
  return parts
}

function parseCursorNumber(raw: string, label: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new WakerError('invalid_argument', `${label} cursor 不是本接口返回的值`)
  }
  return value
}

/** 执行记录游标：`e1|<scheduledFor>|<id>`（按 `scheduledFor DESC, id DESC` 续页）。 */
export function encodeExecutionCursor(cursor: { scheduledFor: number; id: string }): string {
  return joinCursor([EXECUTION_CURSOR_PREFIX, cursor.scheduledFor, cursor.id])
}

export function decodeExecutionCursor(raw: unknown): { scheduledFor: number; id: string } {
  const [, head, id] = splitCursor(raw, EXECUTION_CURSOR_PREFIX, 3, '执行记录')
  return { scheduledFor: parseCursorNumber(head!, '执行记录'), id: id! }
}

/**
 * 死信游标：`d1|<p|r>|<createdAt>|<id>`。
 *
 * `p` = 未重放的桶（`replayed_at IS NULL`），`r` = 已重放的桶。桶必须进游标：
 * 没有它就分不清「当前在 NULL 区间里」还是「NULL 区间之后」，而这正是
 * B2 复评 blocking 那个翻页死循环的成因。
 */
export function encodeDeadLetterCursor(cursor: {
  replayState: DeadLetterReplayState
  createdAt: number
  id: string
}): string {
  return joinCursor([
    DEAD_LETTER_CURSOR_PREFIX,
    cursor.replayState === 'pending' ? 'p' : 'r',
    cursor.createdAt,
    cursor.id,
  ])
}

export function decodeDeadLetterCursor(raw: unknown): {
  replayState: DeadLetterReplayState
  createdAt: number
  id: string
} {
  const [, bucket, head, id] = splitCursor(raw, DEAD_LETTER_CURSOR_PREFIX, 4, '死信')
  if (bucket !== 'p' && bucket !== 'r') {
    throw new WakerError('invalid_argument', '死信 cursor 不是本接口返回的值')
  }
  return {
    replayState: bucket === 'p' ? 'pending' : 'replayed',
    createdAt: parseCursorNumber(head!, '死信'),
    id: id!,
  }
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

/**
 * 校验项目回调根地址：必须是绝对 http(s) URL。
 *
 * 值不在这里拼 `/_waker/execute`（那是执行期 `resolveCallbackUrl` 的事）：
 * 库里存的就是开发者填的项目根地址，管理面原样展示，拼路径只发生在回调时。
 */
export function resolveCallbackBaseUrl(value: unknown): string {
  const raw = requireString(value, 'callbackUrl')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new WakerError('invalid_argument', `callbackUrl 必须是绝对 URL：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WakerError('invalid_argument', `callbackUrl 只支持 http/https，实际：${parsed.protocol}`)
  }
  return raw
}
