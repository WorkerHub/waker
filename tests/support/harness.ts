import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createTestHarness, type TestHarness, type WorkerHandle } from 'wrangler'

import type {
  CreateJobInput,
  JobRef,
  JobView,
  ListJobsQuery,
  ListJobsResult,
  ManualTriggerInput,
  ManualTriggerResult,
  SyncAlarmResult,
  WakerResult,
} from '../../src/do/types'
import { verifyCallbackSignature } from '../../src/callback/sign'
import { getEngineStub, type WakerEngineRpc } from '../../src/do/engine-rpc'
import { CALLBACK_HEADERS, type CallbackRequestBody } from '../../src/callback/protocol'
import type { Env } from '../../src/env'

/**
 * 测试基建：在**真 workerd** 里跑（wrangler `createTestHarness` → Miniflare，读本仓真实
 * wrangler.toml：真 DO 绑定、真 SQLite、真 Queue 绑定、真 queue consumer），
 * **不 mock 平台内部任何一环**。
 *
 * 唯一的替身是下游 Worker：一个真实监听在 `127.0.0.1` 的 HTTP 服务器（workerd 能直接
 * fetch 到它），这样「平台 → 下游」是真的 HTTP 往返，验签用的是下游视角的真实请求头。
 */

const INSTANCE_NAME = 'waker'

/** 冻结 RPC 契约（测试侧独立声明，B2 用法一致）。 */
export interface WakerRpcContract {
  createJob(input: CreateJobInput): Promise<WakerResult<JobView>>
  cancelJob(ref: JobRef): Promise<WakerResult<JobView>>
  pauseJob(ref: JobRef): Promise<WakerResult<JobView>>
  resumeJob(ref: JobRef): Promise<WakerResult<JobView>>
  manualTrigger(input: ManualTriggerInput): Promise<WakerResult<ManualTriggerResult>>
  getJob(ref: JobRef): Promise<WakerResult<JobView | null>>
  listJobs(query?: ListJobsQuery): Promise<WakerResult<ListJobsResult>>
  syncAlarm(): Promise<WakerResult<SyncAlarmResult>>
}

export interface SqlHandle {
  exec(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]>
}

export interface TestContext {
  harness: TestHarness
  worker: WorkerHandle<Env>
  /** B2 冻结 RPC（任务生命周期）。 */
  stub: WakerRpcContract
  /** B3 执行引擎 RPC（consumer 面，测试里用来断言幂等/自续/死信）。 */
  engine: WakerEngineRpc
  sql: SqlHandle
}

export async function startHarness(): Promise<TestContext> {
  const harness = createTestHarness({ workers: [{ configPath: './wrangler.toml' }] })
  await harness.listen()
  const worker = harness.getWorker<Env>()
  const env = await worker.getEnv()
  const stub = env.WAKER_DO.get(
    env.WAKER_DO.idFromName(INSTANCE_NAME),
  ) as unknown as WakerRpcContract
  const sql = (await worker.getDurableObjectStorage('WAKER_DO', {
    name: INSTANCE_NAME,
  })) as unknown as SqlHandle
  const engine = getEngineStub(env)
  return { harness, worker, stub, engine, sql }
}

/** 拆信封：成功取值，失败抛出带 code 的错误（断言里直接读 `code`）。 */
export function unwrapResult<T>(result: WakerResult<T>): T {
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), {
    code: result.error.code,
    details: result.error.details,
  })
}

/** 轮询等待（真 Queue 的消费是异步的，断言前必须等状态收敛）。 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  let last: unknown = null

  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null && value !== undefined && value !== false) return value as T
    last = value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(
    `等待超时（${options.label ?? 'waitFor'}，${timeoutMs}ms），最后一次结果：${JSON.stringify(last)}`,
  )
}

export interface DownstreamRequest {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
  parsed: CallbackRequestBody
  /** 下游视角的验签结果（用项目 signing key 独立校验）。 */
  signature: Awaited<ReturnType<typeof verifyCallbackSignature>>
  receivedAt: number
}

export type DownstreamHandler = (
  request: DownstreamRequest,
  response: ServerResponse,
) => void | Promise<void>

export interface Downstream {
  /** 项目根地址（平台会拼 `/_waker/execute`）。 */
  url: string
  requests: DownstreamRequest[]
  /** 替换下游行为（默认 200 `{ok:true}`）。 */
  setHandler(handler: DownstreamHandler): void
  /** 按 executionId / jobId 过滤收到的请求。 */
  requestsFor(filter: { executionId?: string; jobId?: string }): DownstreamRequest[]
  close(): Promise<void>
}

/**
 * 起一个真监听的下游 HTTP 服务器。
 *
 * 它做的事和一个真实下游一样：收请求 → 按协议验签（记下结果）→ 返回可配置响应。
 * 默认 200 + `{"ok":true}`（CRON 任务不带 nextRunAt）。
 */
export async function startDownstream(secret: string): Promise<Downstream> {
  const requests: DownstreamRequest[] = []
  let handler: DownstreamHandler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')

    const headers = request.headers as Record<string, string | string[] | undefined>
    const header = (name: string): string => {
      const raw = headers[name.toLowerCase()]
      return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : ''
    }

    const record: DownstreamRequest = {
      url: request.url ?? '',
      headers,
      body,
      parsed: JSON.parse(body) as CallbackRequestBody,
      receivedAt: Date.now(),
      signature: await verifyCallbackSignature({
        secret,
        timestamp: header(CALLBACK_HEADERS.timestamp),
        executionId: header(CALLBACK_HEADERS.executionId),
        jobId: header(CALLBACK_HEADERS.jobId),
        body,
        signature: header(CALLBACK_HEADERS.signature),
      }),
    }
    requests.push(record)

    await handler(record, response)
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('下游服务器启动失败')
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    requests,
    setHandler(next) {
      handler = next
    },
    requestsFor(filter) {
      return requests.filter(
        (request) =>
          (filter.executionId === undefined || request.parsed.executionId === filter.executionId) &&
          (filter.jobId === undefined || request.parsed.jobId === filter.jobId),
      )
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

let projectCounter = 0
let jobCounter = 0

/** 建项目 + 发 signing key（B4 的语义，这里是测试侧直接落库）。 */
export async function seedProject(
  ctx: TestContext,
  options: { callbackUrl: string; secret: string; name?: string },
): Promise<{ projectId: string; projectName: string; signingKeyId: string; secret: string }> {
  projectCounter += 1
  const projectId = `proj-${projectCounter}`
  const projectName = options.name ?? `测试项目 ${projectCounter}`
  const signingKeyId = `key-${projectCounter}`
  const now = Date.now()

  await ctx.sql.exec(
    `INSERT INTO projects (id, name, callback_url, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    projectId,
    projectName,
    options.callbackUrl,
    now,
    now,
  )
  await ctx.sql.exec(
    `INSERT INTO signing_keys (id, project_id, secret, created_at) VALUES (?, ?, ?, ?)`,
    signingKeyId,
    projectId,
    options.secret,
    now,
  )

  return { projectId, projectName, signingKeyId, secret: options.secret }
}

/** 建任务（走真实 RPC）。 */
export async function createJob(
  ctx: TestContext,
  input: Partial<CreateJobInput> & Pick<CreateJobInput, 'projectId' | 'kind'>,
): Promise<JobView> {
  jobCounter += 1
  const name = input.name ?? `job-${jobCounter}`
  return unwrapResult(await ctx.stub.createJob({ ...input, name }))
}

/**
 * 直接落一条执行记录（跳过调度器）：
 * 用来把「并发策略 / 幂等」这类**认领期判定**从 Queue 的串行消费里解耦，做成确定性断言。
 */
export async function seedExecution(
  ctx: TestContext,
  options: {
    jobId: string
    projectId: string
    scheduledFor?: number
    status?: string
    attempt?: number
  },
): Promise<string> {
  const executionId = crypto.randomUUID()
  const scheduledFor = options.scheduledFor ?? Date.now()
  await ctx.sql.exec(
    `INSERT INTO executions (
       id, job_id, project_id, scheduled_for, dispatch_at, trigger, misfire, status, attempt, created_at
     ) VALUES (?, ?, ?, ?, ?, 'manual', 0, ?, ?, ?)`,
    executionId,
    options.jobId,
    options.projectId,
    scheduledFor,
    scheduledFor,
    options.status ?? 'dispatched',
    options.attempt ?? 0,
    Date.now(),
  )
  return executionId
}

/** 直接读执行记录（绕过 RPC，断言库里的真实状态）。 */
export async function executionRows(
  ctx: TestContext,
  jobId: string,
): Promise<Record<string, unknown>[]> {
  return ctx.sql.exec(
    'SELECT * FROM executions WHERE job_id = ? ORDER BY scheduled_for, created_at',
    jobId,
  )
}

export async function jobRow(ctx: TestContext, jobId: string): Promise<Record<string, unknown>> {
  const rows = await ctx.sql.exec('SELECT * FROM jobs WHERE id = ?', jobId)
  const row = rows[0]
  if (row === undefined) throw new Error(`任务不存在：${jobId}`)
  return row
}
