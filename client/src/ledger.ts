/**
 * executionId 幂等落表 helper（对齐 B3 冻结契约的「`executionId` 随回调下发，下游落表去重」）。
 *
 * 语义：
 *   - 平台重试同一次执行时带**同一个** `executionId`，下游必须只跑一次业务；
 *   - 首次投递 → `claim` 成功 → 跑业务 → `complete`；
 *   - 业务失败 → `release`（把占位删掉，让平台的重试能真正重跑）；
 *   - 重复投递 → `claim` 失败 → 直接回 2xx（幂等成功），必要时带上首次的响应体
 *     （这样自续的 `nextRunAt` 在重试时也不会丢）。
 *
 * 存储用原生能力表达，不自研分布式锁：
 *   - D1：`INSERT ... ON CONFLICT(execution_id) DO NOTHING` + `meta.changes` 判定，原子且无竞争；
 *   - 内存：单 isolate 的 `Map`（只用于本地开发 / 测试，Worker 多 isolate 下不保证跨实例去重）。
 */

/** 下游本地记录的一条执行。 */
export interface ExecutionLedgerEntry {
  executionId: string
  jobId: string
  jobName: string
  /** 名义到期时刻（epoch ms）。 */
  scheduledFor: number
  status: 'claimed' | 'succeeded'
  /** 首次成功时的响应体（重复投递时原样回放，保住 `nextRunAt`）。 */
  response: Record<string, unknown> | null
  claimedAt: number
  completedAt: number | null
}

/** 认领结果：`claimed` = 本次真的跑；`claimed: false` = 已经处理过（幂等命中）。 */
export interface ExecutionLedgerClaim {
  claimed: boolean
  /** 已存在的记录（`claimed: false` 时非空；`claimed: true` 时为 null）。 */
  existing: ExecutionLedgerEntry | null
}

export interface ExecutionLedger {
  /** 认领一次执行（原子「插入或忽略」）。 */
  claim(input: {
    executionId: string
    jobId: string
    jobName: string
    scheduledFor: number
  }): Promise<ExecutionLedgerClaim>
  /** 标记成功并保存响应体（重复投递时回放）。 */
  complete(executionId: string, response: Record<string, unknown> | null): Promise<void>
  /** 释放占位（业务失败时调用，让重试能重跑）。 */
  release(executionId: string): Promise<void>
  /** 读一条记录（幂等命中时回放响应 / 排查用）。 */
  get(executionId: string): Promise<ExecutionLedgerEntry | null>
}

export interface ExecutionLedgerOptions {
  /** 过期占位的接管时限（秒）：超过它就认为上次执行已崩溃，允许重新认领。默认 600s。 */
  staleClaimSeconds?: number
  /** 注入时钟（测试可替换），默认 `Date.now`。 */
  now?: () => number
}

const DEFAULT_STALE_CLAIM_SECONDS = 600

/** D1 的最小结构接口：只用 `prepare().bind().run()/first()`，不引入 `@cloudflare/workers-types`。 */
export interface D1RunResult {
  success?: boolean
  meta?: { changes?: number; last_row_id?: number; changed_db?: boolean }
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  run(): Promise<D1RunResult>
  first<T = unknown>(): Promise<T | null>
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike
}

/** 幂等表 DDL（下游自己跑一次迁移；表名可用 `table` 选项改写）。 */
export function executionLedgerDdl(table = 'waker_executions'): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  execution_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER
);`
}

/** 内存实现：本地开发 / 测试用（单 isolate 有效）。 */
export function createMemoryExecutionLedger(
  options: ExecutionLedgerOptions = {},
): ExecutionLedger {
  const now = options.now ?? Date.now
  const staleMs = (options.staleClaimSeconds ?? DEFAULT_STALE_CLAIM_SECONDS) * 1000
  const entries = new Map<string, ExecutionLedgerEntry>()

  return {
    async claim(input) {
      const existing = entries.get(input.executionId)
      if (existing === undefined) {
        entries.set(input.executionId, {
          ...input,
          status: 'claimed',
          response: null,
          claimedAt: now(),
          completedAt: null,
        })
        return { claimed: true, existing: null }
      }
      // 上次认领后进程崩了（占位一直没释放）：超时允许接管，避免这条执行永远被当成「已处理」。
      if (existing.status === 'claimed' && now() - existing.claimedAt > staleMs) {
        entries.set(input.executionId, { ...existing, claimedAt: now() })
        return { claimed: true, existing: null }
      }
      return { claimed: false, existing: { ...existing } }
    },
    async complete(executionId, response) {
      const existing = entries.get(executionId)
      if (existing === undefined) return
      entries.set(executionId, {
        ...existing,
        status: 'succeeded',
        response,
        completedAt: now(),
      })
    },
    async release(executionId) {
      const existing = entries.get(executionId)
      if (existing !== undefined && existing.status === 'claimed') entries.delete(executionId)
    },
    async get(executionId) {
      const existing = entries.get(executionId)
      return existing === undefined ? null : { ...existing }
    },
  }
}

interface LedgerRow {
  execution_id: string
  job_id: string
  job_name: string
  scheduled_for: number
  status: string
  response_json: string | null
  claimed_at: number
  completed_at: number | null
}

function rowToEntry(row: LedgerRow): ExecutionLedgerEntry {
  return {
    executionId: row.execution_id,
    jobId: row.job_id,
    jobName: row.job_name,
    scheduledFor: row.scheduled_for,
    status: row.status === 'succeeded' ? 'succeeded' : 'claimed',
    response: row.response_json === null ? null : (JSON.parse(row.response_json) as Record<string, unknown>),
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  }
}

/**
 * D1 实现（下游项目自己的库，与平台的 WakerDO SQLite 无关）。
 *
 * 认领的原子性交给 SQLite 的 `ON CONFLICT DO NOTHING` + `meta.changes`，不做「先查后写」。
 */
export function createD1ExecutionLedger(
  db: D1DatabaseLike,
  options: ExecutionLedgerOptions & { table?: string } = {},
): ExecutionLedger {
  const now = options.now ?? Date.now
  const table = options.table ?? 'waker_executions'
  const staleMs = (options.staleClaimSeconds ?? DEFAULT_STALE_CLAIM_SECONDS) * 1000

  async function readEntry(executionId: string): Promise<ExecutionLedgerEntry | null> {
    const row = await db
      .prepare(`SELECT * FROM ${table} WHERE execution_id = ?`)
      .bind(executionId)
      .first<LedgerRow>()
    return row === null ? null : rowToEntry(row)
  }

  return {
    async claim(input) {
      const claimedAt = now()
      const insert = await db
        .prepare(
          `INSERT INTO ${table} (execution_id, job_id, job_name, scheduled_for, status, response_json, claimed_at, completed_at)
           VALUES (?, ?, ?, ?, 'claimed', NULL, ?, NULL)
           ON CONFLICT(execution_id) DO NOTHING`,
        )
        .bind(
          input.executionId,
          input.jobId,
          input.jobName,
          input.scheduledFor,
          claimedAt,
        )
        .run()

      if ((insert.meta?.changes ?? 0) > 0) return { claimed: true, existing: null }

      // 已有记录：succeeded = 真正的重复投递；claimed 且超时 = 上次执行崩了，接管。
      const existing = await readEntry(input.executionId)
      if (existing !== null && existing.status === 'claimed' && claimedAt - existing.claimedAt > staleMs) {
        const takeover = await db
          .prepare(
            `UPDATE ${table} SET claimed_at = ? WHERE execution_id = ? AND status = 'claimed' AND claimed_at = ?`,
          )
          .bind(claimedAt, input.executionId, existing.claimedAt)
          .run()
        if ((takeover.meta?.changes ?? 0) > 0) return { claimed: true, existing: null }
      }

      return { claimed: false, existing }
    },
    async complete(executionId, response) {
      await db
        .prepare(
          `UPDATE ${table} SET status = 'succeeded', response_json = ?, completed_at = ? WHERE execution_id = ?`,
        )
        .bind(response === null ? null : JSON.stringify(response), now(), executionId)
        .run()
    },
    async release(executionId) {
      await db
        .prepare(`DELETE FROM ${table} WHERE execution_id = ? AND status = 'claimed'`)
        .bind(executionId)
        .run()
    },
    get: readEntry,
  }
}
