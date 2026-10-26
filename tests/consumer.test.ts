import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeadLetterMessage, Env, JobMessage } from '../src/env'
import { handleQueue } from '../src/queue/consumer'
import { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME } from '../src/queue/names'
import {
  createJob,
  executionRows,
  seedExecution,
  seedProject,
  startHarness,
  type TestContext,
} from './support/harness'

/**
 * Queue consumer 单测/集成测试：**真 DO + 真 SQLite，只替换下游 HTTP 与两条 Queue 的生产端**。
 *
 * 这一层覆盖「消息级」的幂等与兜底语义（同一条消息被投两次、毒消息、死信转发），
 * 而「真 Queue 真的会把消息投过来」由 `engine.test.ts` 的全链路测试证明。
 */

const SECRET = 'unit-test-signing-secret-b3'
const CALLBACK_BASE = 'https://downstream.test'

let ctx: TestContext
let env: Env
let mainQueue: { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> }
let dlqQueue: { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const realFetch = globalThis.fetch

interface FakeMessage<T> {
  id: string
  timestamp: Date
  body: T
  attempts: number
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

function makeBatch<T>(queue: string, bodies: T[]): { batch: MessageBatch<T>; messages: FakeMessage<T>[] } {
  let counter = 0
  const messages = bodies.map((body) => {
    counter += 1
    return {
      id: `msg-${counter}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    } satisfies FakeMessage<T>
  })

  const batch = {
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<T>

  return { batch, messages }
}

const ctxStub = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

beforeAll(async () => {
  ctx = await startHarness()

  const harnessEnv = await ctx.worker.getEnv()
  mainQueue = { send: vi.fn(async () => undefined), sendBatch: vi.fn(async () => undefined) }
  dlqQueue = { send: vi.fn(async () => undefined), sendBatch: vi.fn(async () => undefined) }
  env = {
    ...harnessEnv,
    WAKER_QUEUE: mainQueue as unknown as Env['WAKER_QUEUE'],
    WAKER_DLQ: dlqQueue as unknown as Env['WAKER_DLQ'],
  }
})

beforeEach(() => {
  mainQueue.send.mockClear()
  mainQueue.sendBatch.mockClear()
  dlqQueue.send.mockClear()
  dlqQueue.sendBatch.mockClear()

  fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(CALLBACK_BASE)) return fetchMock(input, init)
    return realFetch(input as RequestInfo, init)
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await ctx?.harness.close()
})

async function newExecution(): Promise<{
  jobId: string
  executionId: string
  name: string
}> {
  const project = await seedProject(ctx, { callbackUrl: CALLBACK_BASE, secret: SECRET })
  const job = await createJob(ctx, {
    projectId: project.projectId,
    kind: 'cron',
    cron: '0 3 * * *',
    // 建完即暂停：本文件不需要调度器参与，执行记录由 seedExecution 直接落库。
    enabled: false,
    policies: { maxRetries: 2, timeoutSeconds: 5 },
  })
  const executionId = await seedExecution(ctx, { jobId: job.id, projectId: project.projectId })
  return { jobId: job.id, executionId, name: job.name }
}

describe('主队列 consumer', () => {
  it('正常 2xx：打一次下游 → 标记 succeeded → ack', async () => {
    const { jobId, executionId } = await newExecution()
    const { batch, messages } = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [
      { executionId, jobId, attempt: 0 },
    ])

    await handleQueue(batch, env, ctxStub)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    expect(messages[0]!.retry).not.toHaveBeenCalled()

    const row = (await executionRows(ctx, jobId)).find((item) => item.id === executionId)
    expect(row?.status).toBe('succeeded')
  })

  it('同一条消息被投两次：第二次直接 ack，下游只被打一次（executionId 幂等）', async () => {
    const { jobId, executionId } = await newExecution()
    const message: JobMessage = { executionId, jobId, attempt: 0 }

    const first = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [message])
    await handleQueue(first.batch, env, ctxStub)
    const second = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [message])
    await handleQueue(second.batch, env, ctxStub)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.messages[0]!.ack).toHaveBeenCalled()
    expect(second.messages[0]!.ack).toHaveBeenCalled()
  })

  it('2xx 但响应体不是 JSON / 空体：仍算成功，只是无法自续', async () => {
    const { jobId, executionId } = await newExecution()
    fetchMock.mockResolvedValueOnce(new Response('ok!', { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    for (const _ of [0, 1]) {
      const executionId2 =
        _ === 0 ? executionId : await seedExecution(ctx, { jobId, projectId: 'proj-x' })
      const { batch } = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [
        { executionId: executionId2, jobId, attempt: 0 },
      ])
      await handleQueue(batch, env, ctxStub)
    }

    const row = (await executionRows(ctx, jobId)).find((item) => item.id === executionId)
    expect(row?.status).toBe('succeeded')
    expect(row?.renewal_at).toBeNull()
  })

  it('毒消息（无法识别的 body）：直接 ack，不抛错、不打下游', async () => {
    const { batch, messages } = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [
      { nonsense: true } as unknown as JobMessage,
      { executionId: '', attempt: 0 } as JobMessage,
    ])

    await handleQueue(batch, env, ctxStub)

    expect(fetchMock).not.toHaveBeenCalled()
    for (const message of messages) expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it('平台配置类错误（缺 signing key）：不重试，转死信并 ack', async () => {
    const now = Date.now()
    await ctx.sql.exec(
      `INSERT INTO projects (id, name, callback_url, status, created_at, updated_at)
       VALUES ('proj-broken', '缺签名密钥项目', ?, 'active', ?, ?)`,
      CALLBACK_BASE,
      now,
      now,
    )
    const job = await createJob(ctx, {
      projectId: 'proj-broken',
      kind: 'cron',
      cron: '0 3 * * *',
      enabled: false,
    })
    const executionId = await seedExecution(ctx, { jobId: job.id, projectId: 'proj-broken' })

    const { batch, messages } = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [
      { executionId, jobId: job.id, projectId: 'proj-broken', attempt: 0 },
    ])
    await handleQueue(batch, env, ctxStub)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    expect(dlqQueue.send).toHaveBeenCalledTimes(1)
    const sent = dlqQueue.send.mock.calls[0]![0] as DeadLetterMessage
    expect(sent.executionId).toBe(executionId)
    expect(String(sent.error)).toContain('signing_key_missing')
  })

  it('非 2xx：按 maxRetries 重新入队（attempt 递增），本次 ack', async () => {
    const { jobId, executionId } = await newExecution()
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))

    const { batch, messages } = makeBatch<JobMessage>(MAIN_QUEUE_NAME, [
      { executionId, jobId, attempt: 0 },
    ])
    await handleQueue(batch, env, ctxStub)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    // 这次失败尚未用尽 maxRetries(2)：不进死信，由 DO 经 Queue 重排。
    expect(dlqQueue.send).not.toHaveBeenCalled()

    const row = (await executionRows(ctx, jobId)).find((item) => item.id === executionId)
    expect(row?.attempt).toBe(1)
    expect(row?.status).toBe('dispatched')
    expect(String(row?.error)).toContain('HTTP 500')
  })
})

describe('死信队列 consumer', () => {
  it('CF 自动投递的原始消息（没有 error/attempts）也能从执行记录补全并落库', async () => {
    const { jobId, executionId } = await newExecution()
    const { batch, messages } = makeBatch<JobMessage>(DLQ_QUEUE_NAME, [
      { executionId, jobId, attempt: 2 },
    ])

    await handleQueue(batch, env, ctxStub)

    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    const deadLetter = (
      await ctx.sql.exec('SELECT * FROM dead_letters WHERE execution_id = ?', executionId)
    )[0]
    expect(deadLetter).toBeDefined()
    expect(Number(deadLetter!.attempts)).toBe(3)
    expect(String(deadLetter!.error)).toBe('unknown_error')

    const row = (await executionRows(ctx, jobId)).find((item) => item.id === executionId)
    expect(row?.status).toBe('dead')
  })

  it('同一条死信被投两次：只有一个死信行（幂等）', async () => {
    const { jobId, executionId } = await newExecution()
    const body: DeadLetterMessage = { executionId, jobId, attempts: 3, error: 'HTTP 503' }

    await handleQueue(makeBatch<DeadLetterMessage>(DLQ_QUEUE_NAME, [body]).batch, env, ctxStub)
    await handleQueue(makeBatch<DeadLetterMessage>(DLQ_QUEUE_NAME, [body]).batch, env, ctxStub)

    const rows = await ctx.sql.exec(
      'SELECT * FROM dead_letters WHERE execution_id = ?',
      executionId,
    )
    expect(rows).toHaveLength(1)
    expect(String(rows[0]!.error)).toBe('HTTP 503')
  })

  it('执行记录已不存在的死信：ack 掉（不无限重投）', async () => {
    const { batch, messages } = makeBatch<DeadLetterMessage>(DLQ_QUEUE_NAME, [
      { executionId: 'missing-execution', error: 'gone' },
    ])

    await handleQueue(batch, env, ctxStub)

    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    expect(messages[0]!.retry).not.toHaveBeenCalled()
  })
})
