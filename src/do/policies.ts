import type { MisfirePolicy } from './types'

/**
 * 调度策略的纯逻辑：错过窗口判定、补跑决策、抖动打散。
 *
 * 与存储 / RPC 解耦（不碰 SQL、不碰 Date.now），便于单测钉死行为。
 */

/**
 * 错过窗口阈值：槽位时间过去超过这么多毫秒才算「错过」。
 *
 * 为什么需要阈值：DO alarm 是 at-least-once 且有秒~分钟级延迟（规格只承诺分钟级精度），
 * alarm 迟到几十秒不能被当成「错过一整个周期」。60s 与 Quartz 的 misfireThreshold 默认值一致。
 */
export const MISFIRE_GRACE_MS = 60_000

/**
 * 单次 tick 最多补齐的槽位数上限：alarm 停顿很久（如长时间部署/故障）时，
 * `fire_all` 不能把一条 SQL 事务撑爆。超出部分按最老的丢弃、保留最近的若干次。
 */
export const MAX_CATCH_UP_OCCURRENCES = 500

/** 一次到期槽位的执行决策。 */
export interface OccurrenceDecision {
  /** 名义槽位时刻（epoch ms，不含抖动）。 */
  scheduledFor: number
  /** 是否为「错过窗口后的补跑」。 */
  misfire: boolean
}

/**
 * 把「已到期槽位列表」按任务的 misfirePolicy 折算成「要落几条执行记录」。
 *
 * @param policy  任务的 misfirePolicy
 * @param slots   已到期槽位（升序，均 <= now）
 * @param now     当前时刻（epoch ms）
 */
export function planOccurrences(
  policy: MisfirePolicy,
  slots: readonly number[],
  now: number,
): OccurrenceDecision[] {
  if (slots.length === 0) return []

  const onTime: OccurrenceDecision[] = []
  const misfired: number[] = []

  for (const slot of slots) {
    if (now - slot > MISFIRE_GRACE_MS) misfired.push(slot)
    else onTime.push({ scheduledFor: slot, misfire: false })
  }

  switch (policy) {
    case 'skip':
      // 错过窗口的直接丢弃，只跑还在容差内的槽位。
      return onTime
    case 'fire_once': {
      // 补跑一次：所有错过槽位折算成最近的一次补跑。
      const newest = misfired.at(-1)
      return newest === undefined ? onTime : [{ scheduledFor: newest, misfire: true }, ...onTime]
    }
    case 'fire_all':
      return [
        ...misfired.map((slot) => ({ scheduledFor: slot, misfire: true })),
        ...onTime,
      ]
  }
}

/**
 * 抖动偏移（毫秒）：同一分钟的任务按 job id 哈希打散，防惊群。
 *
 * **确定性**哈希（FNV-1a）而不是随机数：同一 (jobId, 槽位) 的抖动值恒定，
 * 重算 alarm / 重放执行都不会改变执行时刻，测试也可复现。
 * 返回值落在 `[0, jitterSeconds * 1000]`。
 */
export function jitterOffsetMs(jobId: string, scheduledFor: number, jitterSeconds: number): number {
  if (!(jitterSeconds > 0)) return 0
  const span = Math.floor(jitterSeconds * 1000)
  const seed = `${jobId}:${scheduledFor}`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % (span + 1)
}
