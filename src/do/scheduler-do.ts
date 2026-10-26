import type { Env } from '../env'

/**
 * SchedulerDO —— 任务真源（SQLite 后端），全平台唯一实例。
 *
 * B1 只落类壳与绑定：表结构、alarm 重算、任务读写、死信表都在后续子单实现。
 * 存储硬约束：真源只在这里（this.ctx.storage.sql），不引入 D1 / KV。
 */
export class SchedulerDO implements DurableObject {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    // 后续单：管理面 RPC（读任务/日志/死信）与 watchdog 校正入口。
    return Response.json({ error: 'not_implemented', scope: 'scheduler-do' }, { status: 501 })
  }

  async alarm(): Promise<void> {
    // 后续单：取出全部 next_run_at <= now 的任务投递 JOB_QUEUE，并重算下一个 alarm。
  }
}
