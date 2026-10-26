import { Cron } from 'croner'

import { parseCronExpression, type ParsedCronExpression } from './dialect'
import { CronDialectError } from './errors'

/**
 * cron 计算的唯一入口：CF 方言 → 执行时刻。
 *
 * 引擎用 **croner**（不手搓日历运算），关键配置：
 *   - `alternativeWeekdays: true`：星期 1=周日 … 7=周六，与 CF 官方编号一致。
 *     croner 默认是 Vixie 制（0=周日），整体错位一天且**不会报错**，是本模块最大的坑，
 *     固化为常量并在测试里用 CF 文档金向量钉死。
 *   - `domAndDow: false`（默认值，显式写出）：日与星期同时受限时取「或」语义，
 *     与 Vixie cron、Quartz 两系一致（CF 文档未另立规则，继承 Quartz 系语义）。
 *   - `paused: true`：只做时间计算，不挂定时器。
 *   - `timezone`：任务独立时区字段，默认 UTC。
 */

/** CF 星期编号：1=周日 … 7=周六。croner 必须开这个选项才对得上。 */
export const CRONER_OPTIONS = {
  alternativeWeekdays: true,
  domAndDow: false,
  paused: true,
} as const

export interface CronSchedule {
  /** 调用方表达式（原样）。 */
  readonly expression: string
  /** 规范化后的 pattern。 */
  readonly normalized: string
  /** 任务时区（IANA）。 */
  readonly timezone: string
  /** 严格晚于 `afterMs` 的下一次执行时刻（epoch ms）；无解返回 null。 */
  nextAfter(afterMs: number): number | null
  /** 严格早于 `beforeMs` 的上一次执行时刻（epoch ms）；无解返回 null。 */
  previousBefore(beforeMs: number): number | null
  /** 严格晚于 `afterMs` 的接下来 `count` 次执行时刻。 */
  nextAfterN(afterMs: number, count: number): number[]
}

/**
 * 引擎缓存（表达式 + 时区 → croner 实例）。
 *
 * DO 是长生命周期实例，表达式来自任务表且原则上有限；但仍给容量上限做 LRU 淘汰，
 * 避免异常输入（例如被反复创建/删除的不同表达式）把内存顶上去。
 * `Map` 的插入顺序即 LRU 顺序：命中后重新插入以刷新最近使用位置。
 */
const ENGINE_CACHE = new Map<string, Cron>()

/** 引擎缓存容量上限。 */
export const CRON_ENGINE_CACHE_LIMIT = 500

/** 当前缓存的引擎数量（诊断 / 测试用）。 */
export function cronEngineCacheSize(): number {
  return ENGINE_CACHE.size
}

function cacheEngine(key: string, engine: Cron): void {
  ENGINE_CACHE.set(key, engine)
  while (ENGINE_CACHE.size > CRON_ENGINE_CACHE_LIMIT) {
    const oldest = ENGINE_CACHE.keys().next()
    if (oldest.done === true) break
    ENGINE_CACHE.delete(oldest.value)
  }
}

/** 校验 IANA 时区名（非法抛 cron_invalid_timezone）。 */
export function assertTimezone(timezone: string): void {
  if (typeof timezone !== 'string' || timezone.trim().length === 0) {
    throw new CronDialectError('cron_invalid_timezone', '时区不能为空；默认 UTC')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new CronDialectError('cron_invalid_timezone', `不是合法的 IANA 时区名：${timezone}`)
  }
}

/** 校验表达式（CF 方言）并返回解析结果；不合规抛 {@link CronDialectError}。 */
export function parseCron(expression: string): ParsedCronExpression {
  return parseCronExpression(expression)
}

/**
 * 创建（带缓存的）cron 计算器。表达式不合 CF 方言或时区非法时抛 {@link CronDialectError}。
 */
export function createCronSchedule(
  expression: string,
  options: { timezone?: string } = {},
): CronSchedule {
  const timezone = options.timezone ?? 'UTC'
  assertTimezone(timezone)

  const parsed = parseCronExpression(expression)
  const cacheKey = `${parsed.normalized}|${timezone}`

  let engine = ENGINE_CACHE.get(cacheKey)
  if (engine !== undefined) {
    // 命中后刷新 LRU 位置（删除再插入到队尾）
    ENGINE_CACHE.delete(cacheKey)
    cacheEngine(cacheKey, engine)
  } else {
    try {
      engine = new Cron(parsed.normalized, { ...CRONER_OPTIONS, timezone })
    } catch (error) {
      // 走到这里是「本解析器放行、引擎不认」的内部不一致，属于我们的 bug：
      // 依然按方言错误抛出，绝不把非法表达式静默放行。
      const reason = error instanceof Error ? error.message : String(error)
      throw new CronDialectError(
        'cron_invalid_character',
        `表达式通过 CF 方言校验但引擎无法计算：${parsed.normalized}（${reason}）`,
      )
    }
    cacheEngine(cacheKey, engine)
  }

  const nextAfter = (afterMs: number): number | null => {
    const next = engine.nextRun(new Date(afterMs))
    return next === null ? null : next.getTime()
  }

  const previousBefore = (beforeMs: number): number | null => {
    const [previous] = engine.previousRuns(1, new Date(beforeMs))
    return previous === undefined ? null : previous.getTime()
  }

  return {
    expression: parsed.expression,
    normalized: parsed.normalized,
    timezone,
    nextAfter,
    previousBefore,
    nextAfterN(afterMs: number, count: number): number[] {
      const out: number[] = []
      let cursor = afterMs
      for (let index = 0; index < count; index += 1) {
        const next = nextAfter(cursor)
        if (next === null) break
        out.push(next)
        cursor = next
      }
      return out
    },
  }
}
