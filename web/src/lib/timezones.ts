/**
 * IANA 时区的预置清单、合法性与标签（不含任何调度语义）。
 *
 * 时区全集与合法性一律交给平台原生 `Intl`：前端不维护时区数据库，
 * 常用清单只是从 IANA 全集里挑出的预置项；清单之外的时区由用户手填 IANA 名，
 * 真值判定仍归后端（`src/cron/schedule.ts` 的 `assertTimezone`）。
 */

/** 下拉预置项：跨时区排班最常用的 IANA 时区，顺序即下拉顺序。 */
export const COMMON_TIME_ZONES: readonly string[] = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Paris',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/** 下拉里「自定义（手动输入）」那一项的取值，不可能是合法 IANA 名。 */
export const CUSTOM_TIME_ZONE_VALUE = '__custom__'

export function isCommonTimeZone(timeZone: string): boolean {
  return COMMON_TIME_ZONES.includes(timeZone)
}

/** 即时预检：与后端 `assertTimezone` 同机制（`Intl.DateTimeFormat` 解析）。 */
export function isValidTimeZone(timeZone: string): boolean {
  const value = timeZone.trim()
  if (value === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * 该时区在**当前时刻**的 UTC 偏移（`GMT+8` / `GMT-4` / `GMT+5:30`）。
 * 交给原生 `shortOffset` 按渲染时刻计算，因此自动跟随 DST，不落静态偏移表。
 */
function offsetLabel(timeZone: string): string | null {
  for (const style of ['shortOffset', 'short'] as const) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: style,
      }).formatToParts(new Date())
      const offset = parts.find((part) => part.type === 'timeZoneName')?.value
      if (offset !== undefined && offset !== '') return offset
    } catch {
      // 非法时区名：不在标签里兜圈子，交给调用方原样展示。
      return null
    }
  }
  return null
}

/** 下拉选项文案：`Asia/Shanghai（GMT+8）`；取不到偏移时原样返回时区名。 */
export function timeZoneLabel(timeZone: string): string {
  const offset = offsetLabel(timeZone)
  return offset === null ? timeZone : `${timeZone}（${offset}）`
}

/** 浏览器当前时区（新建任务的默认值），读不到时回落 `UTC`。 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
