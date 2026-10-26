import { app } from './app'
import { handleScheduled } from './cron/watchdog'
import { WakerDO } from './do/waker-do'
import type { DeadLetterMessage, Env, JobMessage } from './env'
import { handleQueue } from './queue/consumer'

export { WakerDO }

/**
 * Worker 入口骨架：fetch / scheduled / queue 三入口齐全，业务实现在后续子单。
 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    app.fetch(request, env, ctx),
  scheduled: handleScheduled,
  // Queue 消息体由 wrangler 配置决定，运行时入口先按 unknown 接收再按契约收窄。
  queue: (batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> =>
    handleQueue(batch as MessageBatch<JobMessage | DeadLetterMessage>, env, ctx),
} satisfies ExportedHandler<Env>
