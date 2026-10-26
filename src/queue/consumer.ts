import { buildCallbackBody, deliverCallback } from '../callback'
import { getEngineStub } from '../do/engine-rpc'
import { WakerError, unwrap } from '../do/errors'
import type { PrepareExecutionResult } from '../do/types'
import type { DeadLetterMessage, Env, JobMessage } from '../env'
import { DLQ_QUEUE_NAME } from './names'

/**
 * Queue consumer：执行引擎的「跑腿端」。
 *
 * 两条队列共用一个 `queue()` 入口，按 `batch.queue` 分流：
 *   - `waker-jobs`（主队列）：认领执行 → **同步**调用下游 `/_waker/execute` → 回填结果；
 *   - `waker-dlq`（死信队列）：把消息转存到 WakerDO 的 `dead_letters` 表，供管理面重放。
 *
 * 三条硬约束：
 *   1. **同步语义**：必须 await 到下游返回 2xx 才算成功。绝不用
 *      `ctx.waitUntil(deliver()) + 立即 ack`（旧版做法）——那样成败无人知道，重试与死信全成摆设。
 *   2. **状态以 DO 为准**：重试计划、并发判定、幂等都在 DO 里原子完成；consumer 自己不记状态，
 *      因此 consumer 崩溃/重投都不会让计划错乱。
 *   3. **失败不抛给平台做业务重试**：非 2xx 由 DO 按 maxRetries + backoff 重新入队
 *      （Queue 原生 delaySeconds）；只有「平台自己坏了」（DO 不可达）才抛出让平台重试。
 */
export async function handleQueue(
  batch: MessageBatch<JobMessage | DeadLetterMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const isDeadLetterQueue = batch.queue === DLQ_QUEUE_NAME

  for (const message of batch.messages) {
    if (isDeadLetterQueue) {
      await handleDeadLetter(message as Message<JobMessage | DeadLetterMessage>, env)
    } else {
      await handleJobMessage(message as Message<JobMessage>, env)
    }
  }
}

/** 平台侧不可修复的错误：重试只会用同一必败原因刷队列，直接进死信。 */
const PERMANENT_ERROR_CODES = new Set<string>([
  'execution_not_found',
  'job_not_found',
  'signing_key_missing',
  'signing_key_unreadable',
  'callback_target_missing',
])

function isJobMessage(body: unknown): body is JobMessage {
  if (body === null || typeof body !== 'object') return false
  const candidate = body as Partial<JobMessage>
  return (
    typeof candidate.executionId === 'string' &&
    candidate.executionId.length > 0 &&
    typeof candidate.attempt === 'number' &&
    Number.isInteger(candidate.attempt) &&
    candidate.attempt >= 0
  )
}

/** 主队列消息：认领 → 同步回调 → 回填结果（重试/死信由 DO 决定）。 */
async function handleJobMessage(message: Message<JobMessage>, env: Env): Promise<void> {
  const body = message.body
  if (!isJobMessage(body)) {
    console.error(`[consumer] 丢弃无法识别的队列消息：${JSON.stringify(body)?.slice(0, 200)}`)
    message.ack()
    return
  }

  const stub = getEngineStub(env)

  let prepared: PrepareExecutionResult
  try {
    prepared = unwrap(
      await stub.prepareExecution({ executionId: body.executionId, attempt: body.attempt }),
    )
  } catch (error) {
    if (error instanceof WakerError && PERMANENT_ERROR_CODES.has(error.code)) {
      // 平台配置类错误（缺 signing key / 缺 callback_url / 记录不存在）：判死进死信，不重试。
      console.error(
        `[consumer] 执行 ${body.executionId} 无法启动（${error.code}），转死信：${error.message}`,
      )
      await env.WAKER_DLQ.send({
        executionId: body.executionId,
        jobId: body.jobId,
        projectId: body.projectId,
        attempts: body.attempt + 1,
        error: `${error.code}: ${error.message}`,
      })
      message.ack()
      return
    }
    // 平台内部错误（DO 不可达等）：交给平台重试（wrangler 的 max_retries → dead_letter_queue）。
    throw error
  }

  const { context, target } = prepared
  if (prepared.outcome === 'skip' || context === null || target === null) {
    // 重复投递 / 并发策略 forbid / 任务已取消：都不该再打下游。
    console.log(
      `[consumer] 跳过执行 ${body.executionId}（${String(prepared.reason)}，记录状态 ${prepared.executionStatus}）`,
    )
    message.ack()
    return
  }

  const delivery = await deliverCallback({
    target,
    body: buildCallbackBody(context),
    timeoutSeconds: context.timeoutSeconds,
  })

  const recorded = unwrap(
    await stub.recordExecutionResult({
      executionId: body.executionId,
      attempt: body.attempt,
      ok: delivery.ok,
      httpStatus: delivery.httpStatus,
      error: delivery.error,
      startedAt: delivery.startedAt,
      finishedAt: delivery.finishedAt,
      durationMs: delivery.durationMs,
      nextRunAt: delivery.nextRunAt,
    }),
  )

  if (recorded.retryScheduled) {
    // 已在 DO 里改成 pending 并按 backoff 用 Queue delaySeconds 重新入队，本消息结束。
    console.log(
      `[consumer] 执行 ${body.executionId} 失败，已排第 ${recorded.attempt} 次重试（${delivery.error}）`,
    )
  } else if (recorded.status === 'dead') {
    console.warn(
      `[consumer] 执行 ${body.executionId} 重试用尽或永久失败，转死信（${delivery.error}）`,
    )
    await env.WAKER_DLQ.send({
      executionId: body.executionId,
      jobId: body.jobId,
      projectId: body.projectId,
      attempts: recorded.attempt + 1,
      error: delivery.error,
    })
  } else if (recorded.renewal.applied) {
    console.log(
      `[consumer] 执行 ${body.executionId} 成功并自续到 ${recorded.renewal.nextRunAt}（job ${body.jobId}）`,
    )
  }

  message.ack()
}

/** 死信队列消息：转存 DO 死信表（`execution_id` 唯一，重复投递幂等）。 */
async function handleDeadLetter(
  message: Message<JobMessage | DeadLetterMessage>,
  env: Env,
): Promise<void> {
  const body = message.body as Partial<DeadLetterMessage>
  if (typeof body?.executionId !== 'string' || body.executionId.length === 0) {
    console.error('[dlq] 丢弃无法识别的死信消息')
    message.ack()
    return
  }

  // CF 在 max_retries 耗完后会把主队列原始消息直接投到 DLQ：那种消息只有 `attempt`（0 基），
  // 总投递次数 = attempt + 1；平台自己转来的消息则带 `attempts`。
  const attemptIndex = (message.body as Partial<JobMessage>).attempt
  const attempts =
    body.attempts ?? (typeof attemptIndex === 'number' ? attemptIndex + 1 : undefined)

  try {
    const view = unwrap(
      await getEngineStub(env).recordDeadLetter({
        executionId: body.executionId,
        jobId: body.jobId,
        projectId: body.projectId,
        attempts,
        error: body.error ?? null,
      }),
    )
    console.warn(
      `[dlq] 已转存死信 ${view.id}：execution=${view.executionId} job=${view.jobId} attempts=${view.attempts}`,
    )
    message.ack()
  } catch (error) {
    if (error instanceof WakerError && PERMANENT_ERROR_CODES.has(error.code)) {
      // 执行记录都不在了：没有可落库的死信，ack 掉避免毒消息无限重投。
      console.error(`[dlq] 无法落库（${error.code}）：${error.message}`)
      message.ack()
      return
    }
    throw error
  }
}
