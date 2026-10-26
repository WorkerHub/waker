import type { DeadLetterMessage, Env, JobMessage } from '../env'

/**
 * Queue consumer 骨架。
 *
 * B1 只做消息落地/确认，不含执行与重试策略：
 *   - 主队列 workers-scheduler-jobs：后续单在此调下游回调（HMAC 签名 + 幂等）。
 *   - 死信队列 workers-scheduler-dlq：后续单在此把消息写入 SchedulerDO 死信表。
 */
export async function handleQueue(
  batch: MessageBatch<JobMessage | DeadLetterMessage>,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    message.ack()
  }
}
