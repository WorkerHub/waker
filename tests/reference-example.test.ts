import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMemoryExecutionLedger, type ExecutionLedger } from '../client/src/index'
import { createApp } from '../examples/reference-worker/src/app'
import type { ReferenceEnv } from '../examples/reference-worker/src/env'
import {
  DAILY_CLEANUP_CRON,
  DAILY_CLEANUP_JOB,
  REMINDER_TICK_PREFIX,
  createReferenceJobs,
  type ReferenceJobs,
} from '../examples/reference-worker/src/jobs'
import referenceWorker from '../examples/reference-worker/src/index'
import type { JobView } from '../src/do/types'
import {
  http,
  managementToken,
  startHarness,
  waitFor,
  type TestContext,
} from './support/harness'

/**
 * 参考接入示例的**全链路 smoke**（B5 验收项）：
 *
 *   注册（`/admin/sync-manifest` → 平台注册 API）→ 调度（平台手动触发 / 由 alarm 驱动）
 *   → 回调（平台 → 示例 `/_waker/execute`，HMAC 验签 + 幂等）→ 自续（handler 回 nextRunAt）
 *
 * 平台侧是真 workerd（真 DO / 真 SQLite / 真 Queue / 真 consumer），示例侧是一个真监听在
 * `127.0.0.1` 的 HTTP 服务（跑的是示例自己的 Hono app）——中间是真 HTTP 往返，零 mock。
 *
 * 同一个文件还断言**双模式**：`WAKER_MODE` 缺省时示例不挂载 SDK、`/_waker/execute` 是 404，
 * 而原生 `scheduled()` 走的是**同一份** `runJob()`，产出与回调模式一致。
 */

const DEMO_TOKEN = 'reference-example-demo-token'

let ctx: TestContext
let platformUrl: string
let exampleServer: ExampleServer
let env: ReferenceEnv
let jobs: ReferenceJobs
let projectId: string

interface ExampleServer {
  url: string
  setApp(app: Hono<{ Bindings: ReferenceEnv }>): void
  close(): Promise<void>
}

/** 把 Hono app 挂到真 node HTTP 服务上（示例在本地就是一个普通 HTTP 服务）。 */
async function startExampleServer(ledger: ExecutionLedger): Promise<ExampleServer> {
  let app: Hono<{ Bindings: ReferenceEnv }> | null = null

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (app === null) {
        response.writeHead(503)
        response.end('app not ready')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${request.url ?? '/'}`
      const init: RequestInit = {
        method: request.method ?? 'GET',
        headers: request.headers as Record<string, string>,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }
      const result = await app.fetch(new Request(url, init), env)
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(Buffer.from(await result.arrayBuffer()))
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  void ledger // 账本由 CreateAppOptions 注入，这里只保证每个服务独立

  return {
    url: `http://127.0.0.1:${port}`,
    setApp(next) {
      app = next
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

async function exampleFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'x-demo-token': DEMO_TOKEN }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${exampleServer.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  return { status: response.status, body: (text.length === 0 ? null : JSON.parse(text)) as T }
}

async function platformJobs(): Promise<JobView[]> {
  const result = await http<{ jobs: JobView[] }>(ctx, `/api/jobs?projectId=${projectId}`, {
    token: await managementToken(ctx),
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body.jobs
}

async function triggerJob(jobId: string): Promise<string> {
  const token = await managementToken(ctx)
  const result = await http<{ executionId: string }>(ctx, `/api/jobs/${jobId}/trigger`, {
    method: 'POST',
    token,
  })
  expect(result.status, JSON.stringify(result.body)).toBe(202)
  return result.body.executionId
}

async function executionStatus(executionId: string): Promise<string | null> {
  const rows = await ctx.sql.exec('SELECT status FROM executions WHERE id = ?', executionId)
  const row = rows[0]
  return row === undefined ? null : String(row.status)
}

beforeAll(async () => {
  ctx = await startHarness()
  platformUrl = (await ctx.harness.listen()).url.origin

  // 1) 先起示例服务的壳（app 要在平台建项目、拿到凭据之后才能建）。
  exampleServer = await startExampleServer(createMemoryExecutionLedger())

  // 2) 平台建项目：回调地址 = 示例服务（平台会拼 /_waker/execute）。
  const created = await http<{
    project: { id: string }
    token: string
    signingKey: { secret: string }
  }>(ctx, '/api/projects', {
    method: 'POST',
    token: await managementToken(ctx),
    body: { name: '示例接入项目', callbackUrl: exampleServer.url },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  projectId = created.body.project.id

  // 3) 用真实凭据起示例 app（waker 模式）。
  env = {
    WAKER_MODE: 'waker',
    WAKER_URL: platformUrl,
    WAKER_TOKEN: created.body.token,
    WAKER_SIGNING_KEY: created.body.signingKey.secret,
    DEMO_TOKEN,
  }
  jobs = createReferenceJobs()
  const app = await createApp(env, { jobs, ledger: createMemoryExecutionLedger() })
  exampleServer.setApp(app)
}, 60_000)

afterAll(async () => {
  await exampleServer?.close()
  await ctx?.harness.close()
})

describe('参考示例：注册 → 调度 → 回调 → 自续', () => {
  it('注册：把声明式清单同步给平台（幂等，任务名与 cron 逐字一致）', async () => {
    const synced = await exampleFetch<{
      result: { created: string[]; jobs: { name: string; cron: string; timezone: string }[] }
    }>('/admin/sync-manifest', { method: 'POST' })

    expect(synced.status, JSON.stringify(synced.body)).toBe(200)
    expect(synced.body.result.created).toContain(DAILY_CLEANUP_JOB)
    expect(synced.body.result.jobs).toContainEqual(
      expect.objectContaining({
        name: DAILY_CLEANUP_JOB,
        cron: DAILY_CLEANUP_CRON,
        timezone: 'Asia/Shanghai',
      }),
    )

    // 再同步一次：幂等，不会重复建
    const again = await exampleFetch<{ result: { created: string[]; unchanged: string[] } }>(
      '/admin/sync-manifest',
      { method: 'POST' },
    )
    expect(again.body.result.created).toHaveLength(0)
    expect(again.body.result.unchanged).toContain(DAILY_CLEANUP_JOB)
  })

  it('调度 + 回调：平台同步回调示例，示例验签后跑业务并回 2xx', async () => {
    const job = (await platformJobs()).find((entry) => entry.name === DAILY_CLEANUP_JOB)
    expect(job).toBeDefined()
    const executionId = await triggerJob(job?.id ?? '')

    const run = await waitFor(
      () => jobs.runs.find((entry) => entry.jobName === DAILY_CLEANUP_JOB),
      { label: '示例收到 waker 回调' },
    )
    expect(run.source).toBe('waker')
    expect(run.executionId).toBe(executionId)
    expect(run.detail).toMatchObject({ cleanedLinks: 3 })

    const status = await waitFor(async () => {
      const current = await executionStatus(executionId)
      return current === 'succeeded' ? current : null
    }, { label: '平台执行记录 succeeded' })
    expect(status).toBe('succeeded')
  })

  it('自续：一次性任务回 nextRunAt，平台续期并再次回调（同一 job 系列）', async () => {
    const intervalMs = 1500
    const created = await exampleFetch<{
      job: { id: string; name: string; kind: string }
      renewUntil: number
      intervalMs: number
    }>('/demo/reminders', {
      method: 'POST',
      body: { label: 'L1', dueInMs: 0, intervalMs, renewUntil: Date.now() + intervalMs + 500 },
    })

    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.job.kind).toBe('one_shot')
    expect(created.body.job.name).toBe(`${REMINDER_TICK_PREFIX}L1`)

    await triggerJob(created.body.job.id)

    // 第一次回调 + 平台续期 + 第二次回调（自续的真实证据：同一 jobId 的第二条执行）
    const second = await waitFor(
      () => jobs.runs.filter((entry) => entry.jobName === `${REMINDER_TICK_PREFIX}L1`)[1],
      { label: '自续后的第二次回调', timeoutMs: 25_000 },
    )
    expect(second.detail).toMatchObject({ label: 'L1' })

    const executions = await ctx.sql.exec(
      'SELECT id, status, attempt FROM executions WHERE job_id = ? ORDER BY scheduled_for',
      created.body.job.id,
    )
    expect(executions.length).toBeGreaterThanOrEqual(2)
    expect(executions.every((row) => row.status === 'succeeded')).toBe(true)

    // 窗口走完 → 一次性任务完结（同一个 job 系列，没有换 job id）
    const finished = await waitFor(async () => {
      const current = (await platformJobs()).find((entry) => entry.id === created.body.job.id)
      return current?.status === 'completed' ? current : null
    }, { label: '一次性任务完结' })
    expect(finished.name).toBe(`${REMINDER_TICK_PREFIX}L1`)
  })

  it('取消：示例用 SDK 取消一次性任务（平台侧变 cancelled）', async () => {
    const created = await exampleFetch<{ job: { id: string; name: string } }>('/demo/reminders', {
      method: 'POST',
      body: { label: 'L2', dueInMs: 600_000, intervalMs: 60_000 },
    })
    const cancelled = await exampleFetch<{ job: { status: string } }>(
      `/demo/reminders/${created.body.job.name}`,
      { method: 'DELETE' },
    )
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.job.status).toBe('cancelled')
  })
})

describe('参考示例：双模式切换（同一份任务逻辑）', () => {
  it('原生模式：不挂载 /_waker（SDK 不加载），scheduled() 走同一份业务逻辑', async () => {
    const cronJobs = createReferenceJobs()
    const cronApp = await createApp(
      { WAKER_MODE: 'cron', DEMO_TOKEN },
      { jobs: cronJobs, ledger: createMemoryExecutionLedger() },
    )

    const health = await cronApp.fetch(new Request('http://downstream.test/healthz'), {})
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, mode: 'cron' })

    // 原生模式没有任何回调路由：平台即使打过来也是 404。
    const callback = await cronApp.fetch(
      new Request('http://downstream.test/_waker/execute', { method: 'POST' }),
      {},
    )
    expect(callback.status).toBe(404)

    // 原生 scheduled：按 cron 表达式逐字匹配到声明式任务，再走同一份 runJob()。
    const nativeRun = await cronJobs.runScheduled({
      cron: DAILY_CLEANUP_CRON,
      scheduledTime: new Date(),
    })
    expect(nativeRun.source).toBe('scheduled')
    expect(nativeRun.jobName).toBe(DAILY_CLEANUP_JOB)
    expect(nativeRun.executionId).toBeNull()
    expect(nativeRun.detail).toMatchObject({ cleanedLinks: 3 })

    // 两模式的业务产出完全一致（同一份逻辑的两个入口）。
    const wakerRun = jobs.runs.find((entry) => entry.jobName === DAILY_CLEANUP_JOB)
    expect(wakerRun?.detail.cleanedLinks).toBe(nativeRun.detail.cleanedLinks)
  })

  it('Worker 入口：scheduled() 只认清单里的 cron 表达式', async () => {
    const scheduledController = (cron: string): ScheduledController =>
      ({ cron, scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledController
    const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

    await expect(
      referenceWorker.scheduled(scheduledController('1 1 * * *'), {
        WAKER_MODE: 'cron',
      } as ReferenceEnv, executionContext),
    ).rejects.toThrow(/未知 cron 表达式/)

    await expect(
      referenceWorker.scheduled(scheduledController(DAILY_CLEANUP_CRON), {
        WAKER_MODE: 'cron',
      } as ReferenceEnv, executionContext),
    ).resolves.toBeUndefined()
  })

  it('两份 wrangler 配置：cron 模式带那条表达式，waker 模式删掉 triggers 并打开开关', () => {
    // 示例目录下两份 toml：cron 模式（默认）与 waker 模式（另一份）。
    const configDir = join(process.cwd(), 'examples/reference-worker')
    const otherConfig = readdirSync(configDir)
      .filter((file) => file.endsWith('.toml'))
      .find((file) => file !== 'wrangler.cron.toml')
    expect(otherConfig).toBeDefined()

    const cronConfig = readFileSync(join(configDir, 'wrangler.cron.toml'), 'utf8')
    const wakerConfig = readFileSync(join(configDir, otherConfig ?? ''), 'utf8')

    // 只看生效的配置（注释里会写 `[triggers]` 这类说明文字，不算配置）。
    const active = (config: string): string =>
      config
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')

    expect(active(cronConfig)).toContain('[triggers]')
    expect(active(cronConfig)).toContain(`"${DAILY_CLEANUP_CRON}"`)
    expect(active(cronConfig)).toContain('WAKER_MODE = "cron"')

    expect(active(wakerConfig)).not.toContain('[triggers]')
    expect(active(wakerConfig)).not.toContain('crons')
    expect(active(wakerConfig)).toContain('WAKER_MODE = "waker"')
    expect(active(wakerConfig)).toContain('WAKER_URL')
    // secret 绝不写进配置文件
    expect(active(wakerConfig)).not.toContain('WAKER_TOKEN =')
    expect(active(wakerConfig)).not.toContain('WAKER_SIGNING_KEY =')
  })
})
