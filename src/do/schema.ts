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
  {
    version: 3,
    sql: `
      -- ── B4 项目管理：凭据（令牌 / signing key）的落库形态 ──
      -- 项目令牌只存 sha256 哈希（列已存在于 v1，这里只补唯一索引与轮换时间账本）。
      -- 唯一索引让鉴权可以“哈希直查”，不需要遍历全部项目。
      ALTER TABLE projects ADD COLUMN token_rotated_at INTEGER;
      CREATE UNIQUE INDEX projects_token_hash ON projects (token_hash) WHERE token_hash IS NOT NULL;

      -- signing key 自成 v3 起以 AES-256-GCM 信封存储（信封前缀见 src/do/keyring.ts）；
      -- 明文不再落库；fingerprint 是对明文的 sha256 前 16 hex，只用于展示与人工比对；
      -- algorithm 写进库，日后换算法时不需要猜。
      ALTER TABLE signing_keys ADD COLUMN fingerprint TEXT;
      ALTER TABLE signing_keys ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'HMAC-SHA256';
    `,
  },
  {
    version: 4,
    sql: `
      -- ── 用户体系补遗（ONE-462 / AUTH-MULTIUSER-SPEC v1.0 §2）：只追加，不改 v1–v3 ──

      -- 用户：email 一律小写规范化后入库（应用层强制，唯一索引兜底防重复注册）。
      -- password_hash 是 PBKDF2-SHA256(100k) 的 saltHex:hashHex（对齐 eNotify core/auth）。
      CREATE TABLE users (
        id            TEXT    PRIMARY KEY,
        email         TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        display_name  TEXT    NOT NULL DEFAULT '',
        role          TEXT    NOT NULL CHECK (role IN ('admin', 'viewer')),
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE UNIQUE INDEX users_email ON users (email);

      -- 每用户 2FA 配置（一人一行，未配置时不存在该行）。
      -- totp_secret 是密文信封（waker-enc:v1:，KEK 由 JWT_SECRET 经 HKDF 派生、salt/info 独立），
      -- 未配置为 NULL；passkey_credentials 形状对齐 eNotify：[{id, publicKey, counter, name, createdAt}]。
      CREATE TABLE user_2fa (
        user_id            TEXT    PRIMARY KEY,
        totp_secret        TEXT,
        totp_enabled       INTEGER NOT NULL DEFAULT 0,
        passkey_credentials TEXT   NOT NULL DEFAULT '[]',
        passkey_enabled    INTEGER NOT NULL DEFAULT 0,
        email_otp_enabled  INTEGER NOT NULL DEFAULT 0,
        preferred_method   TEXT,
        updated_at         INTEGER NOT NULL
      );

      -- 一次性状态（替代 eNotify 的 KV 用法）：code_hash 只存哈希，禁止明文落库。
      --   email_otp   ：登录/启用邮件 OTP 的 6 位码（HMAC-SHA256 哈希，验后写 consumed_at）
      --   totp_used   ：TOTP 防重放（码用过即记，expires_at = now + 90s）
      --   totp_setup  ：绑定暂存（code_hash 存 TOTP secret 的密文信封，10 分钟有效）
      -- 过期/已消费行由 watchdog tick 顺带清理（src/do/auth-store.ts pruneAuthChallenges）。
      CREATE TABLE auth_challenges (
        id          TEXT    PRIMARY KEY,
        user_id     TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('email_otp', 'totp_used', 'totp_setup')),
        session_ref TEXT,
        code_hash   TEXT    NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX auth_challenges_lookup ON auth_challenges (user_id, kind, session_ref);
      CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);
    `,
  },
]

/** 当前代码期望的 schema 版本。 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/** 版本账本表（bootstrap：先建它，才能读到版本）。 */
const META_TABLE_SQL = `CREATE TABLE IF NOT EXISTS waker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`

const SCHEMA_VERSION_KEY = 'schema_version'

/** 读账本里的任意键（schema 版本、watchdog 上次校正等）；不存在返回 null。 */
export function readMeta(sql: SqlStorage, key: string): string | null {
  sql.exec(META_TABLE_SQL)
  const rows = sql
    .exec<{ value: string }>('SELECT value FROM waker_meta WHERE key = ?', key)
    .toArray()
  return rows[0]?.value ?? null
}

/** 写账本键（`INSERT OR REPLACE`，幂等）。 */
export function writeMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(META_TABLE_SQL)
  sql.exec(`INSERT OR REPLACE INTO waker_meta (key, value) VALUES (?, ?)`, key, value)
}

/** 读取库内当前 schema 版本；空库返回 0。 */
export function readSchemaVersion(sql: SqlStorage): number {
  const raw = readMeta(sql, SCHEMA_VERSION_KEY)
  return raw === null ? 0 : Number(raw)
}

function writeSchemaVersion(sql: SqlStorage, version: number): void {
  writeMeta(sql, SCHEMA_VERSION_KEY, String(version))
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
