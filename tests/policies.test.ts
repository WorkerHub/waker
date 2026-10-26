import { describe, expect, it } from 'vitest'

import {
  MAX_CATCH_UP_OCCURRENCES,
  MISFIRE_GRACE_MS,
  jitterOffsetMs,
  planOccurrences,
} from '../src/do/policies'

const NOW = Date.parse('2026-11-01T12:00:00.000Z')

describe('planOccurrences：misfire 策略', () => {
  it('没有到期槽位时不产生任何执行', () => {
    expect(planOccurrences('fire_once', [], NOW)).toEqual([])
  })

  it('容差内的槽位算准时，三种策略都照常执行', () => {
    const onTime = [NOW - 1_000, NOW - 30_000]
    for (const policy of ['fire_once', 'skip', 'fire_all'] as const) {
      expect(planOccurrences(policy, onTime, NOW)).toEqual([
        { scheduledFor: NOW - 1_000, misfire: false },
        { scheduledFor: NOW - 30_000, misfire: false },
      ])
    }
  })

  it('超过容差才算错过窗口（边界：正好 60s 不算）', () => {
    expect(planOccurrences('fire_once', [NOW - MISFIRE_GRACE_MS], NOW)).toEqual([
      { scheduledFor: NOW - MISFIRE_GRACE_MS, misfire: false },
    ])
    expect(planOccurrences('fire_once', [NOW - MISFIRE_GRACE_MS - 1], NOW)).toEqual([
      { scheduledFor: NOW - MISFIRE_GRACE_MS - 1, misfire: true },
    ])
  })

  it('fire_once：多个错过槽位合并成最近的一次补跑', () => {
    const slots = [NOW - 10 * 60_000, NOW - 5 * 60_000, NOW - 2 * 60_000]
    expect(planOccurrences('fire_once', slots, NOW)).toEqual([
      { scheduledFor: NOW - 2 * 60_000, misfire: true },
    ])
  })

  it('skip：错过窗口的槽位全部丢弃', () => {
    const slots = [NOW - 10 * 60_000, NOW - 5 * 60_000]
    expect(planOccurrences('skip', slots, NOW)).toEqual([])
  })

  it('fire_all：错过窗口的槽位逐个补齐', () => {
    const slots = [NOW - 10 * 60_000, NOW - 5 * 60_000]
    expect(planOccurrences('fire_all', slots, NOW)).toEqual([
      { scheduledFor: NOW - 10 * 60_000, misfire: true },
      { scheduledFor: NOW - 5 * 60_000, misfire: true },
    ])
  })

  it('补跑上限常量是正数（每条 SQL 事务内的槽位上限）', () => {
    expect(MAX_CATCH_UP_OCCURRENCES).toBeGreaterThan(0)
    expect(MAX_CATCH_UP_OCCURRENCES).toBeLessThanOrEqual(1_000)
  })
})

describe('jitterOffsetMs：确定性抖动', () => {
  it('同一 (jobId, 槽位) 恒定，可复现', () => {
    const first = jitterOffsetMs('job-a', NOW, 60)
    expect(jitterOffsetMs('job-a', NOW, 60)).toBe(first)
    expect(jitterOffsetMs('job-a', NOW, 60)).toBe(first)
  })

  it('落在 [0, jitterSeconds*1000] 内', () => {
    for (let index = 0; index < 200; index += 1) {
      const offset = jitterOffsetMs(`job-${index}`, NOW + index * 60_000, 30)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThanOrEqual(30_000)
    }
  })

  it('不同任务在同一槽位被打散（不是全部同一点）', () => {
    const offsets = new Set(
      Array.from({ length: 50 }, (_unused, index) => jitterOffsetMs(`job-${index}`, NOW, 60)),
    )
    expect(offsets.size).toBeGreaterThan(10)
  })

  it('jitterSeconds 为 0 时不抖动', () => {
    expect(jitterOffsetMs('job-a', NOW, 0)).toBe(0)
    expect(jitterOffsetMs('job-a', NOW, -5)).toBe(0)
  })
})
