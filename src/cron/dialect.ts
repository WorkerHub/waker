import { CronDialectError, type CronFieldName } from './errors'

/**
 * CF 官方 Cron Triggers 方言（冻结契约二）的校验与规范化。
 *
 * 方言真源：Cloudflare 文档 *Cron Triggers → Supported cron expressions*
 *
 * | 字段         | 取值                              | 允许字符          |
 * |--------------|-----------------------------------|-------------------|
 * | Minute       | 0-59                              | `* , - /`         |
 * | Hours        | 0-23                              | `* , - /`         |
 * | Days of Month| 1-31                              | `* , - / L W`     |
 * | Months       | 1-12 或大小写不敏感 3 字母缩写     | `* , - /`         |
 * | Weekdays     | 1-7 或大小写不敏感 3 字母缩写      | `* , - / L #`     |
 *
 * - **星期 1=周日 … 7=周六**（与 Vixie 制 0=周日的编号整体错位一天，故 `0` 直接报错）。
 * - 只收 5 字段：秒字段、年字段、`?`、`@` 宏在解析期拒绝。
 * - CF 扩展形式：DOM 的 `L`（当月最后一天）/ `LW`（当月最后一个工作日）/ `nW`（离 n 号最近的工作日），
 *   DOW 的 `6L` / `friL`（当月最后一个周五）、`MON#1`（当月第一个周一）。
 *
 * 规范化产出是 croner 能直接吃的 pattern（croner 以 `alternativeWeekdays: true` 运行，
 * 星期编号与 CF 一致）；`friL` 这类 CF 拼写在这里被改写成 croner 内部的 `FRI#L` 形式，
 * **绝不因为库的拼写差异拒收合法 CF 表达式**。
 */

/** 月份名 → 1-12（CF：大小写不敏感的 3 字母缩写）。 */
export const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

/** 星期名 → 1-7（CF 制：1=周日 … 7=周六）。 */
export const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

interface FieldSpec {
  readonly name: CronFieldName
  readonly label: string
  readonly min: number
  readonly max: number
  /** 允许的 3 字母名（月份 / 星期），其它字段为 null。 */
  readonly names: readonly string[] | null
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', label: '分钟', min: 0, max: 59, names: null },
  { name: 'hour', label: '小时', min: 0, max: 23, names: null },
  { name: 'dayOfMonth', label: '日', min: 1, max: 31, names: null },
  { name: 'month', label: '月', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'dayOfWeek', label: '星期', min: 1, max: 7, names: WEEKDAY_NAMES },
]

/** 解析结果：原样表达式 + 规范化 pattern + 各字段规范化产出。 */
export interface ParsedCronExpression {
  /** 调用方传入、trim 后的表达式（对外展示用）。 */
  readonly expression: string
  /** 交给 croner 的 pattern（星期编号已按 CF 制对齐）。 */
  readonly normalized: string
  /** 各字段规范化后的字符串（诊断 / 测试用）。 */
  readonly fields: Readonly<Record<CronFieldName, string>>
}

/**
 * 校验表达式是否为合法 CF 方言并返回规范化结果；不合规抛 {@link CronDialectError}。
 */
export function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== 'string') {
    throw new CronDialectError('cron_field_count', '表达式必须是字符串')
  }

  const trimmed = expression.trim()

  if (trimmed.length === 0) {
    throw new CronDialectError('cron_field_count', '表达式为空：CF 方言需要 5 个字段（分 时 日 月 星期）')
  }

  if (trimmed.startsWith('@')) {
    throw new CronDialectError(
      'cron_macro_unsupported',
      `CF Cron Triggers 不支持 \`@\` 宏（${trimmed}），请写成 5 字段表达式`,
    )
  }

  if (trimmed.includes('?')) {
    throw new CronDialectError(
      'cron_question_mark_unsupported',
      'CF Cron Triggers 不支持 `?` 占位符：日与星期都要写 `*` 或不写扩展形式',
    )
  }

  const parts = trimmed.split(/\s+/)

  if (parts.length !== FIELD_SPECS.length) {
    if (parts.length === 6 || parts.length === 7) {
      throw new CronDialectError(
        'cron_field_count',
        `CF Cron Triggers 只收 5 字段（分 时 日 月 星期），不支持秒字段与年字段；实际收到 ${parts.length} 个字段`,
      )
    }
    throw new CronDialectError(
      'cron_field_count',
      `CF Cron Triggers 需要 5 字段（分 时 日 月 星期），实际收到 ${parts.length} 个字段`,
    )
  }

  const fields: Record<CronFieldName, string> = {
    minute: '',
    hour: '',
    dayOfMonth: '',
    month: '',
    dayOfWeek: '',
  }

  const normalized = parts.map((part, index) => {
    const spec = FIELD_SPECS[index]!
    const value = normalizeField(part, spec)
    fields[spec.name] = value
    return value
  })

  return { expression: trimmed, normalized: normalized.join(' '), fields }
}

/** 只取规范化 pattern。 */
export function normalizeCronExpression(expression: string): string {
  return parseCronExpression(expression).normalized
}

function normalizeField(raw: string, spec: FieldSpec): string {
  // 逗号分隔的每一项独立校验；空项（`a,,b`、尾随逗号）直接报错。
  const items = raw.split(',')
  if (items.some((item) => item.length === 0)) {
    throw new CronDialectError('cron_invalid_character', `${spec.label}字段含空的逗号项：${raw}`, spec.name)
  }
  return items.map((item) => normalizeItem(item, spec)).join(',')
}

function normalizeItem(item: string, spec: FieldSpec): string {
  const slashParts = item.split('/')
  if (slashParts.length > 2) {
    throw new CronDialectError('cron_invalid_step', `${spec.label}字段步长形式非法：${item}`, spec.name)
  }

  const base = slashParts[0]!
  const rawStep = slashParts[1]
  let stepSuffix = ''

  if (rawStep !== undefined) {
    if (!/^\d+$/.test(rawStep)) {
      throw new CronDialectError('cron_invalid_step', `${spec.label}字段步长必须是正整数：${item}`, spec.name)
    }
    const step = Number(rawStep)
    if (step < 1) {
      throw new CronDialectError('cron_invalid_step', `${spec.label}字段步长必须 ≥ 1：${item}`, spec.name)
    }
    const isWildcard = base === '*'
    const isRange = base.includes('-') && !hasExtensionSuffix(base, spec)
    if (!isWildcard && !isRange) {
      throw new CronDialectError(
        'cron_invalid_step',
        `${spec.label}字段的步长只能跟在 \`*\` 或区间后面（如 */5、1-5/2）；CF 不支持「数值/步长」：${item}`,
        spec.name,
      )
    }
    stepSuffix = `/${step}`
  }

  const extension = normalizeExtension(base, spec)
  if (extension !== null) {
    if (stepSuffix !== '') {
      throw new CronDialectError(
        'cron_unsupported_extension',
        `${spec.label}字段的扩展形式不能再带步长：${item}`,
        spec.name,
      )
    }
    return extension
  }

  if (base.startsWith('*')) {
    if (base !== '*') {
      throw new CronDialectError('cron_invalid_character', `${spec.label}字段通配符写法非法：${item}`, spec.name)
    }
    return `*${stepSuffix}`
  }

  const rangeParts = base.split('-')
  if (rangeParts.length > 2) {
    throw new CronDialectError('cron_invalid_character', `${spec.label}字段区间写法非法：${item}`, spec.name)
  }

  if (rangeParts.length === 2) {
    const from = parseValue(rangeParts[0]!, spec)
    const to = parseValue(rangeParts[1]!, spec)
    if (from > to) {
      throw new CronDialectError(
        'cron_invalid_range',
        `${spec.label}字段区间起点大于终点（不支持跨零点回绕）：${item}`,
        spec.name,
      )
    }
    return `${from}-${to}${stepSuffix}`
  }

  // 单值：此时 stepSuffix 必为空（上面已拒绝「数值/步长」）。
  return `${parseValue(base, spec)}`
}

/**
 * CF 扩展形式规范化；不是扩展形式返回 null。
 * 只有日（`L` / `LW` / `nW`）与星期（`nL` / `nameL` / `n#k` / `name#k`）有扩展。
 */
function normalizeExtension(base: string, spec: FieldSpec): string | null {
  const upper = base.toUpperCase()

  if (spec.name === 'dayOfMonth') {
    if (upper === 'L') return 'L'
    if (upper === 'LW') return 'LW'
    const nearest = /^(\d+)W$/.exec(upper)
    if (nearest) {
      const day = Number(nearest[1])
      assertInRange(day, spec, base)
      return `${day}W`
    }
    if (/[LW]/.test(upper)) {
      throw new CronDialectError(
        'cron_unsupported_extension',
        `CF 方言的日期扩展只支持 L（当月最后一天）、LW（当月最后一个工作日）、nW（离 n 号最近的工作日）：${base}`,
        spec.name,
      )
    }
    return null
  }

  if (spec.name === 'dayOfWeek') {
    if (upper === 'L') {
      throw new CronDialectError(
        'cron_unsupported_extension',
        '星期字段的裸 `L` 在 CF 方言里没有定义含义；「当月最后一个周 X」请写成 6L / friL',
        spec.name,
      )
    }
    const lastOrNth = /^([A-Z]{3}|\d+)(L|#(\d+))$/.exec(upper)
    if (lastOrNth) {
      const weekday = parseValue(lastOrNth[1]!, spec)
      const nth = lastOrNth[3]
      if (nth === undefined) {
        // CF 的 `friL` / `6L` → croner 的 `FRI#L` / `6#L`（库内部拼写，解析层吸收）。
        return `${weekday}#L`
      }
      const index = Number(nth)
      if (!(index >= 1 && index <= 5)) {
        throw new CronDialectError(
          'cron_out_of_range',
          `\`#\` 表示当月第几个星期 X，取值 1-5：${base}`,
          spec.name,
        )
      }
      return `${weekday}#${index}`
    }
    if (/[L#]/.test(upper)) {
      throw new CronDialectError(
        'cron_unsupported_extension',
        `CF 方言的星期扩展只支持 nL / nameL（当月最后一个）与 n#k / name#k（当月第 k 个）：${base}`,
        spec.name,
      )
    }
    return null
  }

  return null
}

/** 扩展形式判断（带 L/#/W 后缀的项不吃区间/步长逻辑）。 */
function hasExtensionSuffix(base: string, spec: FieldSpec): boolean {
  if (spec.name === 'dayOfMonth') return /^LW$/i.test(base) || /^\d+W$/i.test(base)
  if (spec.name === 'dayOfWeek') return /^([A-Z]{3}|\d+)(L|#\d+)$/i.test(base)
  return false
}

/** 单值：数字或 3 字母名（月份 / 星期）→ 数字。 */
function parseValue(token: string, spec: FieldSpec): number {
  if (/^\d+$/.test(token)) {
    const value = Number(token)
    if (spec.name === 'dayOfWeek' && value === 0) {
      throw new CronDialectError(
        'cron_weekday_zero',
        'CF 的星期编号是 1=周日 … 7=周六（不是 Vixie 的 0=周日）；周日请写 1 或 sun',
        spec.name,
      )
    }
    assertInRange(value, spec, token)
    return value
  }

  if (/^[A-Za-z]+$/.test(token)) {
    const upper = token.toUpperCase()
    const index = spec.names ? spec.names.indexOf(upper) : -1
    if (index >= 0) return index + 1
    throw new CronDialectError(
      'cron_invalid_name',
      spec.names
        ? `${spec.label}字段只认 3 字母缩写（${spec.names.join('/')}，大小写不敏感）：${token}`
        : `${spec.label}字段不接受字母：${token}`,
      spec.name,
    )
  }

  throw new CronDialectError('cron_invalid_character', `${spec.label}字段含非法字符：${token}`, spec.name)
}

function assertInRange(value: number, spec: FieldSpec, raw: string): void {
  if (value < spec.min || value > spec.max) {
    throw new CronDialectError(
      'cron_out_of_range',
      `${spec.label}字段取值必须在 ${spec.min}-${spec.max} 之间：${raw}`,
      spec.name,
    )
  }
}
