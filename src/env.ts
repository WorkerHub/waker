import type { WakerDO } from './do/waker-do'

/**
 * Worker 运行时绑定类型。
 *
 * 绑定名与 wrangler.toml 一一对应（B1 定死，后续子单沿用）：
 *   WAKER_DO / WAKER_QUEUE / WAKER_DLQ
 *
 * 密钥不落库、不落代码、不落日志：
 *   SETUP_SECRET / JWT_SECRET 由 GitHub Secrets → $RUNNER_TEMP/secrets.json →
 *   `wrangler deploy --secrets-file` 注入；本地开发用 `.dev.vars`（已被 gitignore）。
 */

/**
 * 主队列消息（`waker-jobs`）：alarm 取出到期任务后，由 DO 投递，consumer 消费后同步回调下游。
 *
 * 消息体故意只带「指针」（executionId + attempt）：任务 payload、地址、signing key
 * 一律不在队列里传 —— 队列消息可能被平台重试/转存/排查，不能携带凭据。
 */
export interface JobMessage {
  /** 执行唯一 id（下发下游做幂等，随回调带出） */
  executionId: string
  /** 任务 id */
  jobId: string
  /** 项目 id（仅便于排查，判定以 DO 里的记录为准） */
  projectId?: string
  /** 第几次投递，0 = 首次；与执行记录的 attempt 不一致即为过期重试消息 */
  attempt: number
}

/**
 * 死信队列消息（`waker-dlq`）：主队列重试用尽 / 永久失败后转入，由 consumer 存 DO 死信表。
 *
 * 注意：CF 在 `max_retries` 耗完时会把**主队列原始消息**（{@link JobMessage}）直接投到 DLQ，
 * 那种消息没有 error/attempts，consumer 从执行记录里补全。
 */
export interface DeadLetterMessage {
  executionId: string
  jobId?: string
  projectId?: string
  /** 累计尝试次数（缺失时从执行记录取） */
  attempts?: number
  /** 最后一次失败原因（缺失时从执行记录取） */
  error?: string | null
}

export interface Env {
  /** Durable Object 命名空间：任务真源（SQLite），单实例、原生 RPC。 */
  WAKER_DO: DurableObjectNamespace<WakerDO>
  /** 主分发队列（生产端）。 */
  WAKER_QUEUE: Queue<JobMessage>
  /** 死信队列（生产端，用于手动重放 / 显式转死信）。 */
  WAKER_DLQ: Queue<DeadLetterMessage>

  /** 首次安装口令（一次性 setup 用），仅经 secrets 注入。 */
  SETUP_SECRET: string
  /** 会话 JWT 签名密钥，仅经 secrets 注入。 */
  JWT_SECRET: string
}
