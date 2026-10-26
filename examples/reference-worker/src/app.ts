import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'

import type { ReferenceEnv } from './env'
import {
  DAILY_CLEANUP_JOB,
  REMINDER_TICK_PREFIX,
  createReferenceJobs,
  type ReferenceJobs,
} from './jobs'
import type { ExecutionLedger } from '../../../client/src/ledger'

/**
 * 参考接入示例的 HTTP 面：**双模式在同一个 Worker 里切换**。
 *
 * ```
 * WAKER_MODE=cron   原生模式（默认）：只有健康检查与 demo 只读接口；
 *                   SDK 一行都不加载（SDK 的 import 在下面的 waker 分支里）。
 * WAKER_MODE=waker  接入模式：挂载 `/_waker`（receiver）+ 注册客户端 + demo 写接口。
 * ```
 *
 * 两种模式的业务逻辑是同一份（`./jobs`）：原生模式的 `scheduled()` 与 waker 模式的回调
 * 都走 `runJob()`，声明式任务的 cron 表达式也只写一次。
 */

/** 示例 demo 接口的口令头（示例专用；真实下游请接自己的鉴权体系）。 */
export const DEMO_TOKEN_HEADER = 'x-demo-token'

export interface CreateAppOptions {
  /** 共享的业务实例（默认新建；Worker 入口用模块级单例，让 scheduled 与 fetch 共用记录）。 */
  jobs?: ReferenceJobs
  /** 注入幂等账本（测试用内存实现；线上走 D1）。 */
  ledger?: ExecutionLedger
  /** 注入 fetch（本地 smoke 测试里指向 harness 起的平台）。 */
  fetch?: typeof fetch
}

/** 就地读取模式（**不 import SDK**：原生模式下连 SDK 模块的求值都不该发生）。 */
function modeOf(env: ReferenceEnv): 'cron' | 'waker' {
  return typeof env.WAKER_MODE === 'string' && env.WAKER_MODE.trim().toLowerCase() === 'waker'
    ? 'waker'
    : 'cron'
}

export async function createApp(
  env: ReferenceEnv,
  options: CreateAppOptions = {},
): Promise<Hono<{ Bindings: ReferenceEnv }>> {
  const jobs = options.jobs ?? createReferenceJobs()
  const app = new Hono<{ Bindings: ReferenceEnv }>()

  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'waker-reference-worker', mode: modeOf(env) }),
  )

  /** 演示用的执行记录（两种模式共用的同一份 business 输出）。 */
  app.get('/demo/runs', (c) => c.json({ runs: jobs.runs }))

  if (modeOf(env) !== 'waker') {
    // 原生模式到此为止：没有 /_waker 路由，没有注册客户端，也没有任何平台调用。
    return app
  }

  // ↓ 只有 WAKER_MODE=waker 才会走到这里 —— 动态 import 保证原生模式下 SDK 不被求值。
  const sdk = await import('../../../client/src/index')
  const led = options.ledger ?? (env.WAKER_DB !== undefined
    ? sdk.createD1ExecutionLedger(env.WAKER_DB)
    : sdk.createMemoryExecutionLedger())

  const mounted = sdk.mountWakerReceiver(app, {
    env: env as unknown as Record<string, unknown>,
    jobs: jobs.handlers,
    ledger: led,
  })
  if (!mounted) throw new Error('WAKER_MODE=waker 但 receiver 未挂载')

  const client = sdk.createWakerClientFromEnv(env as unknown as Record<string, unknown>, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  if (client === null) {
    throw new Error('WAKER_MODE=waker 但 WAKER_URL / WAKER_TOKEN 未配置')
  }

  const requireDemoToken: MiddlewareHandler<{ Bindings: ReferenceEnv }> = async (c, next) => {
    const expected = typeof env.DEMO_TOKEN === 'string' ? env.DEMO_TOKEN : ''
    if (expected.length > 0 && c.req.header(DEMO_TOKEN_HEADER) !== expected) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }

  /**
   * 部署期：把声明式清单同步给平台（幂等）。
   *
   * 真实项目在 CI 里跑这一步（shell 里 curl / 独立脚本调同一个注册 API），
   * 示例做成一个路由，方便本地跑通「注册 → 调度 → 回调」全链路。
   */
  app.post('/admin/sync-manifest', requireDemoToken, async (c) => {
    try {
      const result = await client.syncManifest(jobs.manifest)
      return c.json({ result })
    } catch (error) {
      return apiError(c, error)
    }
  })

  /** 运行时创建一次性任务（自续演示：提醒推进到窗口终点）。 */
  app.post('/demo/reminders', requireDemoToken, async (c) => {
    const body = (await readJson(c)) ?? {}
    const label = typeof body.label === 'string' ? body.label : `reminder-${Date.now()}`
    const dueInMs = typeof body.dueInMs === 'number' ? Math.max(0, body.dueInMs) : 0
    const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : 60_000
    const renewUntil =
      typeof body.renewUntil === 'number' ? body.renewUntil : Date.now() + intervalMs * 3

    try {
      const job = await client.createOneShot({
        name: `${REMINDER_TICK_PREFIX}${label}`,
        runAt: Date.now() + dueInMs,
        payload: { label, intervalMs, renewUntil },
        policies: { maxRetries: 2, backoffSeconds: 2, timeoutSeconds: 15 },
      })
      return c.json({ job, renewUntil, intervalMs }, 201)
    } catch (error) {
      return apiError(c, error)
    }
  })

  /** 取消一次性任务（幂等：已完结的任务平台也回 200）。 */
  app.delete('/demo/reminders/:name', requireDemoToken, async (c) => {
    try {
      const job = await client.cancelJob(c.req.param('name'))
      return c.json({ job })
    } catch (error) {
      return apiError(c, error)
    }
  })

  /** 声明式任务名（供 README / 测试确认两模式用的是同一个名字与表达式）。 */
  app.get('/demo/manifest', (c) =>
    c.json({ declarative: DAILY_CLEANUP_JOB, manifest: jobs.manifest }),
  )

  return app
}

async function readJson(c: Context<{ Bindings: ReferenceEnv }>): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** 平台错误 → HTTP：`code` 原样透出（SDK 的 WakerApiError 契约），方便排障。 */
function apiError(c: Context<{ Bindings: ReferenceEnv }>, error: unknown): Response {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'waker_api_unreachable'
  const message = error instanceof Error ? error.message : String(error)
  return c.json({ error: { code, message } }, 502)
}
