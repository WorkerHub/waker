-- 下游自己的幂等账本（不是平台的表：平台真源在 WakerDO 的 SQLite）。
-- 表结构由 SDK 的 executionLedgerDdl() 生成，改这里请同步改 SDK 并重跑测试。
CREATE TABLE IF NOT EXISTS waker_executions (
  execution_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER
);
