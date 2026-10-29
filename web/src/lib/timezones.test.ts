import { describe, expect, it } from 'vitest'

import {
  browserTimeZone,
  COMMON_TIME_ZONES,
  isCommonTimeZone,
  isValidTimeZone,
  timeZoneLabel,
} from '@/lib/timezones'

/** 时区能力全部来自平台原生 Intl：前端只维护 18 项常用清单。 */
describe('常用时区清单', () => {
  it('是 18 项且无重复', () => {
    expect(COMMON_TIME_ZONES).toHaveLength(18)
    expect(new Set(COMMON_TIME_ZONES).size).toBe(COMMON_TIME_ZONES.length)
  })

  it('覆盖用户点名的常用时区，且每项都是合法 IANA 名', () => {
    for (const zone of ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York']) {
      expect(COMMON_TIME_ZONES).toContain(zone)
    }
    for (const zone of COMMON_TIME_ZONES) {
      expect(isValidTimeZone(zone)).toBe(true)
    }
  })

  it('isCommonTimeZone 只认清单内的名字', () => {
    expect(isCommonTimeZone('Asia/Tokyo')).toBe(true)
    expect(isCommonTimeZone('Europe/Berlin')).toBe(false)
  })
})

describe('isValidTimeZone', () => {
  it('接受 IANA 名（含别名与前后空白）', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone(' UTC ')).toBe(true)
  })

  it('拒绝非法名字与空值', () => {
    expect(isValidTimeZone('Mars/Base')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('   ')).toBe(false)
  })
})

describe('timeZoneLabel', () => {
  it('按渲染时刻的原生偏移拼标签', () => {
    // 上海 / 东京无夏令时，偏移在整个日历年内恒定
    expect(timeZoneLabel('Asia/Shanghai')).toMatch(/^Asia\/Shanghai（GMT\+8）$/)
    expect(timeZoneLabel('Asia/Tokyo')).toMatch(/^Asia\/Tokyo（GMT\+9）$/)
    expect(timeZoneLabel('UTC')).toMatch(/^UTC（GMT/)
  })

  it('非法时区名原样返回，不造假偏移', () => {
    expect(timeZoneLabel('Mars/Base')).toBe('Mars/Base')
  })
})

describe('browserTimeZone', () => {
  it('返回运行环境的 IANA 时区', () => {
    expect(isValidTimeZone(browserTimeZone())).toBe(true)
  })
})
