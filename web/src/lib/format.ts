/**
 * 展示层的纯格式化工具（不含任何调度语义）。
 *
 * **时间一律按北京时间（Asia/Shanghai）呈现**：舰队定规要求页面里的时间不随浏览器时区漂移，
 * 原始 epoch（UTC 毫秒）在渲染时才换算。`formatRelative` 是相对量，与时区无关。
 */
const DISPLAY_TIME_ZONE = 'Asia/Shanghai'

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DISPLAY_TIME_ZONE,
})

const timeOnlyFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeStyle: 'medium',
  timeZone: DISPLAY_TIME_ZONE,
})

/** epoch 毫秒 → 北京时间的可读时间；`null` 用 `—` 占位。 */
export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return dateTimeFormatter.format(new Date(value))
}

export function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return timeOnlyFormatter.format(new Date(value))
}

const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  ['month', 2_592_000_000],
  ['year', 31_536_000_000],
]

/** 与当前时刻的相对描述（「3 分钟后」/「2 天前」），用于「下次执行」这类列。 */
export function formatRelative(value: number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '—'
  const diff = value - now
  const abs = Math.abs(diff)

  let chosen: [Intl.RelativeTimeFormatUnit, number] = ['second', 1000]
  for (const unit of RELATIVE_UNITS) {
    if (abs >= unit[1]) chosen = unit
  }
  return relativeFormatter.format(Math.round(diff / chosen[1]), chosen[0])
}

/** epoch 毫秒 → `<input type="datetime-local">` 的 value（本地时区）。 */
export function toDateTimeLocal(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

/** `<input type="datetime-local">` 的 value → epoch 毫秒。 */
export function fromDateTimeLocal(value: string): number | null {
  if (value === '') return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

/** 载荷 JSON 文本 → JsonValue；非 JSON 返回错误信息（由表单展示）。 */
export function parsePayloadText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON 解析失败' }
  }
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '{}'
  return JSON.stringify(value, null, 2)
}
