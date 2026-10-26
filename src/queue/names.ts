/**
 * Queue 名字（与 wrangler.toml 的 `queues` 段逐字一致）。
 *
 * consumer 靠 `batch.queue` 区分「主队列」与「死信队列」——两条队列共用一个
 * `queue()` 入口，所以名字必须是常量而不是散落的字面量。
 */
export const MAIN_QUEUE_NAME = 'waker-jobs'
export const DLQ_QUEUE_NAME = 'waker-dlq'
