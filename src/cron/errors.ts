/**
 * crypto 方言错误（CF 官方 Cron Triggers 语法，冻结契约二）。
 *
 * 错误码是冻结契约的一部分：管理面 / 注册 API（B4）把它原样透出给调用方，
 * 前端（F1-F3）按 code 分支处理，不得在传递过程中改写。
 */
export type CronErrorCode =
  /** 只收 5 字段；6/7 字段（秒、年）或字段数不足 */
  | 'cron_field_count'
  /** `@daily` 等宏，CF 不支持 */
  | 'cron_macro_unsupported'
  /** `?` 占位符，CF 不支持 */
  | 'cron_question_mark_unsupported'
  /** 字段内出现该字段不允许的字符 */
  | 'cron_invalid_character'
  /** 数值超出该字段取值范围 */
  | 'cron_out_of_range'
  /** 星期用了 Vixie 制 0（CF 为 1=周日…7=周六） */
  | 'cron_weekday_zero'
  /** 区间起点大于终点 */
  | 'cron_invalid_range'
  /** 步长非法（非正整数，或「数值/步长」这种 CF 未定义形式） */
  | 'cron_invalid_step'
  /** 月份 / 星期名不是 3 字母缩写 */
  | 'cron_invalid_name'
  /** CF 未定义该扩展组合（如裸 `L`、DOW 的 `LW`、DOM 的 `L-3`） */
  | 'cron_unsupported_extension'
  /** 时区不是合法 IANA 时区名 */
  | 'cron_invalid_timezone'

/** cron 字段名（与 CF 文档五列对应）。 */
export type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'

/** 表达式不合 CF 方言时抛出；`code` / `field` 供调用方分支处理。 */
export class CronDialectError extends Error {
  readonly code: CronErrorCode
  readonly field: CronFieldName | null

  constructor(code: CronErrorCode, message: string, field: CronFieldName | null = null) {
    super(message)
    this.name = 'CronDialectError'
    this.code = code
    this.field = field
  }
}
