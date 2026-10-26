import type { Env } from '../env'

/**
 * Watchdog 入口（全仓唯一 Cron Trigger：每小时）。
 *
 * B1 只占位：后续单在这里 ping SchedulerDO 校正 alarm（防 alarm 丢失 / 部署漂移）。
 * 严禁在此处写业务调度逻辑——任务到期一律走 DO alarm。
 */
export async function handleScheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // 后续单：env.SCHEDULER_DO.get(idFromName('scheduler')) 调用校正入口。
}
