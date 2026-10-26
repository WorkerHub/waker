/**
 * Queue 原生能力的边界参数与「重试退避 → Queue delaySeconds」折算。
 *
 * 为什么用 Queue 的 `delaySeconds` 表达重试等待：这是平台原生能力（消息在队列侧
 * 延迟可见、不需要 DO 定时器也不要 sleep），符合「依赖能表达的一律用依赖原生的」。
 *
 * 纯函数，便于单测钉死。
 */

/**
 * CF Queues `delaySeconds` 上限：24 小时（超出会被平台拒绝）。
 * backoff 基数上限 86400 + 指数退避很快会撞到这个天花板，必须显式夹住。
 */
export const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60

/**
 * 第 `failedAttempt` 次失败（0 基，即首次失败 = 0）后的重试等待秒数：
 * `backoffSeconds * 2^failedAttempt`，上限 {@link MAX_QUEUE_DELAY_SECONDS}。
 */
export function retryDelaySeconds(backoffSeconds: number, failedAttempt: number): number {
  const base = Math.max(0, Math.floor(backoffSeconds))
  if (base === 0) return 0
  const exponent = Math.max(0, Math.min(30, Math.floor(failedAttempt)))
  const delay = base * 2 ** exponent
  return Math.min(delay, MAX_QUEUE_DELAY_SECONDS)
}

/**
 * 把「计划投递时刻」折成 Queue 的 `delaySeconds`：`max(0, ceil((dispatchAt - now)/1000))`，
 * 并夹到 {@link MAX_QUEUE_DELAY_SECONDS}。
 *
 * 抖动（jitterSeconds）就靠这个表达：同分钟任务被投递到不同 delay，防惊群。
 */
export function queueDelaySeconds(dispatchAt: number, now: number): number {
  if (!Number.isFinite(dispatchAt)) return 0
  const deltaMs = dispatchAt - now
  if (deltaMs <= 0) return 0
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.ceil(deltaMs / 1000))
}
