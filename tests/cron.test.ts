import { describe, expect, it } from 'vitest'

import {
  CronDialectError,
  assertTimezone,
  createCronSchedule,
  normalizeCronExpression,
  parseCronExpression,
} from '../src/cron'

const UTC = 'UTC'

/** 从固定时刻起算下 n 次运行（epoch ms）。 */
function runs(expression: string, count = 5, fromIso = '2026-11-01T00:00:00.000Z', timezone = UTC) {
  return createCronSchedule(expression, { timezone }).nextAfterN(Date.parse(fromIso), count)
}

/** ISO 字符串序列，断言失败时比毫秒数字易读。 */
function isos(expression: string, count = 5, fromIso = '2026-11-01T00:00:00.000Z', timezone = UTC) {
  return runs(expression, count, fromIso, timezone).map((ms) => new Date(ms).toISOString())
}

function expectDialectCode(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (error) {
    expect(error, `期望 CronDialectError，实际 ${String(error)}`).toBeInstanceOf(CronDialectError)
    expect((error as CronDialectError).code).toBe(code)
    return
  }
  throw new Error('期望抛出 CronDialectError，但没有抛错')
}

describe('CF 方言金向量（CF 官方文档示例，逐条断言）', () => {
  it('`0 17 * * sun` ≡ `0 17 * * 1`：星期编号 1=周日', () => {
    const numeric = isos('0 17 * * 1')
    const named = isos('0 17 * * sun')
    expect(named).toEqual(numeric)
    expect(named).toEqual([
      '2026-11-01T17:00:00.000Z', // 周日
      '2026-11-08T17:00:00.000Z',
      '2026-11-15T17:00:00.000Z',
      '2026-11-22T17:00:00.000Z',
      '2026-11-29T17:00:00.000Z',
    ])
  })

  it('`10 7 * * mon-fri` ≡ `10 7 * * 2-6`：工作日（2=周一 … 6=周五）', () => {
    const numeric = isos('10 7 * * 2-6', 10)
    const named = isos('10 7 * * mon-fri', 10)
    expect(named).toEqual(numeric)
    // 2026-11-02 是周一；11-07 是周六，必须跳过。
    expect(named.slice(0, 6)).toEqual([
      '2026-11-02T07:10:00.000Z',
      '2026-11-03T07:10:00.000Z',
      '2026-11-04T07:10:00.000Z',
      '2026-11-05T07:10:00.000Z',
      '2026-11-06T07:10:00.000Z',
      '2026-11-09T07:10:00.000Z',
    ])
  })

  it('`0 18 * * friL`：当月最后一个周五（含跨月/跨年）', () => {
    expect(isos('0 18 * * friL', 4)).toEqual([
      '2026-11-27T18:00:00.000Z',
      '2026-12-25T18:00:00.000Z',
      '2027-01-29T18:00:00.000Z',
      '2027-02-26T18:00:00.000Z',
    ])
  })

  it('`0 18 * * 6L` ≡ `0 18 * * friL`：6=周五', () => {
    expect(isos('0 18 * * 6L', 4)).toEqual(isos('0 18 * * friL', 4))
  })

  it('`59 23 LW * *`：当月最后一个工作日', () => {
    expect(isos('59 23 LW * *', 4)).toEqual([
      '2026-11-30T23:59:00.000Z', // 11-30 周一
      '2026-12-31T23:59:00.000Z', // 12-31 周四
      '2027-01-29T23:59:00.000Z', // 01-31 周日 → 退到 01-29 周五
      '2027-02-26T23:59:00.000Z', // 02-28 周日 → 退到 02-26 周五
    ])
  })

  it('`MON#1` / `2#1`：当月第一个周一', () => {
    expect(isos('0 12 * * MON#1', 3)).toEqual([
      '2026-11-02T12:00:00.000Z',
      '2026-12-07T12:00:00.000Z',
      '2027-01-04T12:00:00.000Z',
    ])
    expect(isos('0 12 * * 2#1', 3)).toEqual(isos('0 12 * * MON#1', 3))
  })

  it('月份 3 字母缩写与数字等价', () => {
    expect(isos('0 12 1 JAN *', 2)).toEqual(isos('0 12 1 1 *', 2))
    expect(isos('0 12 1 jan-mar *', 4)).toEqual(isos('0 12 1 1-3 *', 4))
  })

  it('`0 12 * * SAT` ≡ `0 12 * * 7`：7=周六', () => {
    expect(isos('0 12 * * SAT', 3)).toEqual(isos('0 12 * * 7', 3))
    expect(isos('0 12 * * 7', 1)).toEqual(['2026-11-07T12:00:00.000Z'])
  })

  it('CF 的 `nW`：离 n 号最近的工作日（不跨月）', () => {
    // 2026-11-15 是周日 → 最近工作日 11-16 周一
    expect(isos('0 12 15W * *', 1)[0]).toBe('2026-11-16T12:00:00.000Z')
    // 2026-08-01 是周六 → 最近工作日 08-03 周一
    expect(isos('0 12 1W * *', 1, '2026-07-15T00:00:00.000Z')[0]).toBe('2026-08-03T12:00:00.000Z')
  })

  it('DOM 与 DOW 同时受限：取「或」语义（Vixie / Quartz 一致，croner 默认）', () => {
    // `0 0 1 * 2` = 每月 1 日 或 每周一
    expect(isos('0 0 1 * 2', 6, '2026-11-01T00:00:00.000Z')).toEqual([
      '2026-11-02T00:00:00.000Z', // 周一
      '2026-11-09T00:00:00.000Z', // 周一
      '2026-11-16T00:00:00.000Z',
      '2026-11-23T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z', // 1 日（周二）
    ])
  })

  it('时区是任务独立字段：同一表达式在不同时区对应不同 UTC 时刻', () => {
    expect(isos('0 9 * * *', 2, '2026-11-01T00:00:00.000Z', 'Asia/Shanghai')).toEqual([
      '2026-11-01T01:00:00.000Z',
      '2026-11-02T01:00:00.000Z',
    ])
    expect(isos('0 9 * * *', 2, '2026-11-01T00:00:00.000Z', UTC)).toEqual([
      '2026-11-01T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ])
  })

  it('夏令时切换按任务时区处理（America/New_York 春季前跳）', () => {
    const ny = isos('30 2 * * *', 4, '2026-03-06T00:00:00.000Z', 'America/New_York')
    // 切换前是 EST -5（07:30Z），切换后是 EDT -4（06:30Z）：UTC 时刻随 DST 平移，
    // 说明计算用的是任务时区的本地 02:30，不是写死的 UTC 偏移。
    expect(ny[0]).toBe('2026-03-06T07:30:00.000Z')
    expect(ny.at(-1)).toBe('2026-03-09T06:30:00.000Z')
  })

  it('起点恰好在执行时刻时取「严格晚于」的下一次', () => {
    expect(
      createCronSchedule('0 17 * * 1', { timezone: UTC }).nextAfter(
        Date.parse('2026-11-01T17:00:00.000Z'),
      ),
    ).toBe(Date.parse('2026-11-08T17:00:00.000Z'))
  })

  it('无解表达式返回 null（2 月 31 日）', () => {
    expect(createCronSchedule('0 0 31 2 *').nextAfter(Date.parse('2026-01-01T00:00:00.000Z'))).toBeNull()
  })
})

describe('CF 方言校验：拒绝路径', () => {
  it('6 字段（含秒）报错', () => {
    expectDialectCode(() => parseCronExpression('0 0 12 * * *'), 'cron_field_count')
  })

  it('7 字段（含秒与年）报错', () => {
    expectDialectCode(() => parseCronExpression('0 0 12 * * * 2026'), 'cron_field_count')
  })

  it('多余空白不算字段（trim + 折叠空白后仍是 5 字段）', () => {
    expect(parseCronExpression('  0   12  *  *  *  ').normalized).toBe('0 12 * * *')
  })

  it('字段数不足报错', () => {
    expectDialectCode(() => parseCronExpression('0 12 * *'), 'cron_field_count')
    expectDialectCode(() => parseCronExpression(''), 'cron_field_count')
  })

  it('`?` 占位符报错', () => {
    expectDialectCode(() => parseCronExpression('0 12 ? * 1'), 'cron_question_mark_unsupported')
    expectDialectCode(() => parseCronExpression('0 12 * * ?'), 'cron_question_mark_unsupported')
  })

  it('`@` 宏报错', () => {
    for (const macro of ['@daily', '@hourly', '@every 5m', '@yearly']) {
      expectDialectCode(() => parseCronExpression(macro), 'cron_macro_unsupported')
    }
  })

  it('Vixie 星期制 0 报错（CF 是 1=周日）', () => {
    expectDialectCode(() => parseCronExpression('0 17 * * 0'), 'cron_weekday_zero')
    expectDialectCode(() => parseCronExpression('0 17 * * 0-6'), 'cron_weekday_zero')
    expectDialectCode(() => parseCronExpression('0 18 * * 0L'), 'cron_weekday_zero')
  })

  it('各字段越界报错', () => {
    expectDialectCode(() => parseCronExpression('60 * * * *'), 'cron_out_of_range')
    expectDialectCode(() => parseCronExpression('* 24 * * *'), 'cron_out_of_range')
    expectDialectCode(() => parseCronExpression('* * 0 * *'), 'cron_out_of_range')
    expectDialectCode(() => parseCronExpression('* * 32 * *'), 'cron_out_of_range')
    expectDialectCode(() => parseCronExpression('* * * 13 *'), 'cron_out_of_range')
    expectDialectCode(() => parseCronExpression('* * * * 8'), 'cron_out_of_range')
  })

  it('步长与区间非法写法报错', () => {
    expectDialectCode(() => parseCronExpression('5/10 * * * *'), 'cron_invalid_step')
    expectDialectCode(() => parseCronExpression('*/0 * * * *'), 'cron_invalid_step')
    expectDialectCode(() => parseCronExpression('22-2 * * * *'), 'cron_invalid_range')
    expectDialectCode(() => parseCronExpression('1,,2 * * * *'), 'cron_invalid_character')
  })

  it('非 3 字母的名字报错', () => {
    expectDialectCode(() => parseCronExpression('0 12 * * sunday'), 'cron_invalid_name')
    expectDialectCode(() => parseCronExpression('0 12 * january *'), 'cron_invalid_name')
    expectDialectCode(() => parseCronExpression('0 12 * * L'), 'cron_unsupported_extension')
  })

  it('CF 未定义的扩展组合报错', () => {
    expectDialectCode(() => parseCronExpression('0 12 L-3 * *'), 'cron_unsupported_extension')
    expectDialectCode(() => parseCronExpression('0 12 * * LW'), 'cron_unsupported_extension')
    expectDialectCode(() => parseCronExpression('0 12 LW/2 * *'), 'cron_invalid_step')
    expectDialectCode(() => parseCronExpression('0 12 L * MON#6'), 'cron_out_of_range')
  })

  it('时区非法报错', () => {
    expect(() => assertTimezone('Mars/Base')).toThrow(CronDialectError)
    expect(() => createCronSchedule('0 9 * * *', { timezone: 'Mars/Base' })).toThrow(CronDialectError)
  })
})

describe('规范化：CF 拼写 → 引擎 pattern', () => {
  it('DOW 名 → 数字（CF 制）', () => {
    expect(normalizeCronExpression('0 17 * * SUN')).toBe('0 17 * * 1')
    expect(normalizeCronExpression('10 7 * * mon-fri')).toBe('10 7 * * 2-6')
    expect(normalizeCronExpression('0 12 * * SAT')).toBe('0 12 * * 7')
  })

  it('月份名 → 数字', () => {
    expect(normalizeCronExpression('0 12 1 jan-mar *')).toBe('0 12 1 1-3 *')
    expect(normalizeCronExpression('0 12 1 DEC *')).toBe('0 12 1 12 *')
  })

  it('`friL` / `6L` → 引擎的 `#L` 形式（不因库拼写差异拒收）', () => {
    expect(normalizeCronExpression('0 18 * * friL')).toBe('0 18 * * 6#L')
    expect(normalizeCronExpression('0 18 * * FRIl')).toBe('0 18 * * 6#L')
    expect(normalizeCronExpression('0 18 * * 6L')).toBe('0 18 * * 6#L')
  })

  it('`MON#1` 与 DOM 扩展原样保留', () => {
    expect(normalizeCronExpression('0 12 * * MON#1')).toBe('0 12 * * 2#1')
    expect(normalizeCronExpression('59 23 LW * *')).toBe('59 23 LW * *')
    expect(normalizeCronExpression('0 12 L * *')).toBe('0 12 L * *')
    expect(normalizeCronExpression('0 12 15W * *')).toBe('0 12 15W * *')
    expect(normalizeCronExpression('*/5 * * * *')).toBe('*/5 * * * *')
  })

  it('原样保留 trim 后的表达式', () => {
    expect(parseCronExpression('  0 17 * * 1  ').expression).toBe('0 17 * * 1')
  })
})
