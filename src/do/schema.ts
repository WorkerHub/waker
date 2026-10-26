/**
 * WakerDO 的 SQLite 数据模型（真源，唯一实例）。
 *
 * 硬约束：表只建在 WakerDO 的 SQLite 里（`ctx.storage.sql`），不建 D1、不用 KV、无 TABLE_PREFIX。
 *
 * 迁移方式：版本号记在 `waker_meta` 表的 `schema_version` 键，启动时（DO 构造函数里）按序补齐。
 * 每次结构变更只追加一条迁移，不改历史迁移（线上已执行的迁移不可回改）。
 *
 * 为什么不用 `PRAGMA user_version`：Durable Object 的 SQLite 对 PRAGMA 读写是受限的
 * （`PRAGMA user_version` 直接报 `not authorized: SQLITE_AUTH`，2026-10-26 在 workerd
 * 1.20261019.1 上实测），所以版本账本必须是一张普通表。
 */

export interface Migration {
  readonly version: number
  readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- ── 任务：cron（声明式周期）与 one_shot（一次性，可自续）两类 ──
      CREATE TABLE jobs (
        id                 TEXT    PRIMARY KEY,
        project_id         TEXT    NOT NULL,
        name               TEXT    NOT NULL,
        kind               TEXT    NOT NULL CHECK (kind IN ('cron', 'one_shot')),
        -- cron 任务：原始 CF 方言表达式 + 规范化 pattern；one_shot 为 NULL
        cron_expression    TEXT,
        cron_normalized    TEXT,
        timezone           TEXT    NOT NULL DEFAULT 'UTC',
        -- one_shot 任务：本次执行时刻（epoch ms）；cron 为 NULL
        run_at             INTEGER,
        payload            TEXT    NOT NULL DEFAULT 'null',
        -- 策略字段：建模定死，不留默认猜测（默认值见 DEFAULT_JOB_POLICIES）
        misfire_policy     TEXT    NOT NULL CHECK (misfire_policy IN ('fire_once', 'skip', 'fire_all')),
        concurrency_policy TEXT    NOT NULL CHECK (concurrency_policy IN ('forbid', 'allow')),
        max_retries        INTEGER NOT NULL DEFAULT 0,
        backoff_seconds    INTEGER NOT NULL DEFAULT 0,
        timeout_seconds    INTEGER NOT NULL DEFAULT 30,
        jitter_seconds     INTEGER NOT NULL DEFAULT 0,
        status             TEXT    NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
        -- 下一次调度时刻（epoch ms）；不活跃 / 已排完为 NULL
        next_run_at        INTEGER,
        last_run_at        INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX jobs_project_name ON jobs (project_id, name);
      CREATE INDEX jobs_due ON jobs (status, next_run_at);

      -- ── 执行记录：一次「到期槽位」一行，可多次重试 ──
      CREATE TABLE executions (
        id              TEXT    PRIMARY KEY,
        job_id          TEXT    NOT NULL,
        project_id      TEXT    NOT NULL,
        -- 计划执行时刻（名义槽位，不含抖动）
        scheduled_for   INTEGER NOT NULL,
        -- 实际分发目标时刻 = scheduled_for + 抖动；B3 用 (dispatchAt - now) 换算 Queue delaySeconds
        dispatch_at     INTEGER NOT NULL,
        trigger         TEXT    NOT NULL CHECK (trigger IN ('schedule', 'manual')),
        misfire         INTEGER NOT NULL DEFAULT 0,
        status          TEXT    NOT NULL CHECK (status IN ('pending', 'dispatched', 'running', 'succeeded', 'failed', 'dead', 'skipped')),
        skip_reason     TEXT,
        attempt         INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER,
        finished_at     INTEGER,
        duration_ms     INTEGER,
        response_status INTEGER,
        error           TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX executions_job ON executions (job_id, scheduled_for DESC);
      CREATE INDEX executions_pending ON executions (status, dispatch_at);

      -- ── 死信：主队列重试用尽后转存，管理面可重放（B3 写入语义） ──
      CREATE TABLE dead_letters (
        id                   TEXT    PRIMARY KEY,
        execution_id         TEXT    NOT NULL,
        job_id               TEXT    NOT NULL,
        project_id           TEXT    NOT NULL,
        attempts             INTEGER NOT NULL,
        error                TEXT    NOT NULL,
        payload              TEXT    NOT NULL DEFAULT 'null',
        created_at           INTEGER NOT NULL,
        replayed_at          INTEGER,
        replayed_execution_id TEXT
      );
      CREATE UNIQUE INDEX dead_letters_execution ON dead_letters (execution_id);

      -- ── 项目：单人所有者模型下的接入单元（语义归 B4，本单只定表） ──
      CREATE TABLE projects (
        id               TEXT    PRIMARY KEY,
        name             TEXT    NOT NULL,
        -- 注册 API 令牌只存哈希，明文不落库
        token_hash       TEXT,
        token_created_at INTEGER,
        status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX projects_name ON projects (name);

      -- ── 签名密钥：每项目独立，可轮换；平台侧加密存 DO（加密方式归 B4） ──
      CREATE TABLE signing_keys (
        id           TEXT    PRIMARY KEY,
        project_id   TEXT    NOT NULL,
        secret       TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        rotated_at   INTEGER,
        revoked_at   INTEGER
      );
      CREATE INDEX signing_keys_project ON signing_keys (project_id, revoked_at);
    `,
  },
  {
    version: 2,
    sql: `
      -- ── B3 执行引擎（回调协议 v2）：追加列，不改既有对象、不删数据 ──
      -- 项目回调目标：项目根地址（平台拼 /_waker/execute）；B4 建项目时写入。
      -- 为空的项目无法执行回调（执行会被直接判死进死信，不会用必败原因刷队列）。
      ALTER TABLE projects ADD COLUMN callback_url TEXT;

      -- 执行载荷快照：manualTrigger 的 payload 覆盖 / 死信重放都要按「这一次」的载荷回调，
      -- 不能回读 jobs.payload（那是任务默认载荷）。为空的旧记录回落到 jobs.payload。
      ALTER TABLE executions ADD COLUMN payload TEXT;

      -- 执行记录审计：本次签名用的 signing key id（轮换后仍可回溯到底哪把钥匙签的）。
      ALTER TABLE executions ADD COLUMN signing_key_id TEXT;
      -- 自续结果：生效时的 nextRunAt（毫秒）；未续期为 NULL。
      ALTER TABLE executions ADD COLUMN renewal_at INTEGER;
      -- 自续被拒原因（not_requested / invalid_next_run_at / next_run_at_not_future / ...）。
      -- 自续被拒不影响本次执行的成功判定，所以单独成列，不污染 error。
      ALTER TABLE executions ADD COLUMN renewal_error TEXT;
    `,
  },
]

/** 当前代码期望的 schema 版本。 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/** 版本账本表（bootstrap：先建它，才能读到版本）。 */
const META_TABLE_SQL = `CREATE TABLE IF NOT EXISTS waker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`

const SCHEMA_VERSION_KEY = 'schema_version'

/** 读取库内当前 schema 版本；空库返回 0。 */
export function readSchemaVersion(sql: SqlStorage): number {
  sql.exec(META_TABLE_SQL)
  const rows = sql
    .exec<{ value: string }>('SELECT value FROM waker_meta WHERE key = ?', SCHEMA_VERSION_KEY)
    .toArray()
  const raw = rows[0]?.value
  return raw === undefined ? 0 : Number(raw)
}

function writeSchemaVersion(sql: SqlStorage, version: number): void {
  sql.exec(
    `INSERT OR REPLACE INTO waker_meta (key, value) VALUES (?, ?)`,
    SCHEMA_VERSION_KEY,
    String(version),
  )
}

/**
 * 补齐未执行的迁移。幂等：版本已到位时不做任何事。
 * 版本比代码新（回滚场景）时抛错，避免用旧代码操作新结构。
 */
export function migrate(sql: SqlStorage): number {
  const current = readSchemaVersion(sql)

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `WakerDO schema 版本 ${current} 高于代码期望的 ${SCHEMA_VERSION}：请先部署匹配的代码，不要用旧代码操作新结构`,
    )
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    sql.exec(migration.sql)
    writeSchemaVersion(sql, migration.version)
  }

  return SCHEMA_VERSION
}
