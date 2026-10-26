import type { Hono } from 'hono'

import { createApp } from './app'
import type { ReferenceEnv } from './env'
import { createReferenceJobs } from './jobs'

/**
 * 参考接入示例的 Worker 入口：**双模式共存**。
 *
 * - `scheduled()` 是下游自己的代码路径，SDK 从不接管它（原生模式全部逻辑都在这条路径上）；
 * - `fetch` 才是模式切换点：waker 模式下 `createApp` 会挂载 `/_waker` 并构造注册客户端，
 *   原生模式下它直接在健康检查后就返回，SDK 模块不会被求值。
 *
 * 模块级单例：`scheduled` 与 `fetch` 共用同一份业务记录，两条入口写进同一份 `runs`。
 */

const jobs = createReferenceJobs()

let appPromise: Promise<Hono<{ Bindings: ReferenceEnv }>> | null = null

export default {
  fetch(request: Request, env: ReferenceEnv, _ctx: ExecutionContext): Promise<Response> {
    appPromise ??= createApp(env, { jobs })
    return appPromise.then((app) => app.fetch(request, env))
  },

  /**
   * 原生模式入口（`WAKER_MODE=cron`，配置里保留 `[triggers]` 的那个）。
   *
   * 切到 waker 模式时这份配置里的 triggers 会被删掉（见 `wrangler.waker.toml`），
   * 于是这个函数自然不会被调用；它保留在原位，随时可以切回原生模式而不用改代码。
   */
  async scheduled(
    controller: ScheduledController,
    _env: ReferenceEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await jobs.runScheduled({
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime),
    })
  },
} satisfies ExportedHandler<ReferenceEnv>
