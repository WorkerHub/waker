import { unwrap } from '../do/errors'
import { getWakerStub } from '../do/instance'
import type { Env } from '../env'

/**
 * Watchdog 入口（全仓唯一 Cron Trigger：每小时）。
 *
 * 只做一件事：让 WakerDO 自愈 alarm —— 先补处理「已经到期但没被 alarm 处理」的任务
 * （alarm 丢失 / 部署漂移的兜底），再按最早到期重设 `setAlarm`。
 *
 * 严禁在此处写业务调度逻辑：任务到期一律走 DO alarm。
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const result = unwrap(await getWakerStub(env).syncAlarm())
  // 只打统计量，不含任务载荷与凭据。
  console.log(
    `[watchdog] scheduledTime=${controller.scheduledTime} dueJobs=${result.dueJobs} ` +
      `created=${result.createdExecutions} skipped=${result.skippedExecutions} ` +
      `pendingDispatches=${result.pendingDispatches} nextWakeAt=${String(result.nextWakeAt)}`,
  )
}
