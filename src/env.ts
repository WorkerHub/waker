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

/** 分发队列消息：alarm 到期后交给 consumer 执行。字段由后续单细化。 */
export interface JobMessage {
  /** 执行唯一 id（下发下游做幂等，随回调带出） */
  executionId: string
  /** 任务 id */
  jobId: string
}

/** 死信消息：主队列重试用尽后转入，由 consumer 存 DO 死信表。 */
export interface DeadLetterMessage {
  executionId: string
  jobId: string
  /** 最后一次失败原因（截断后存） */
  error: string
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
