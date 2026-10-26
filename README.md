# waker

全舰队统一调度平台。用 **1 个 watchdog Cron Trigger + Durable Object Alarm + Queue** 取代各项目自有的 Cron Triggers，支持声明式 cron 任务与 one-shot 自续任务。

- Worker：`waker`
- 域名：`waker.oneboy.app`
- 规格：父单 ONE-373 内嵌 SPEC.md v1.0（唯一规格源）

> 当前状态：**调度内核已就位（B1 脚手架 + B2 内核）**。WakerDO 的 SQLite 数据模型、任务生命周期 RPC、
> alarm 自愈与 CF 方言 cron 解析器已完成并有测试覆盖；Queue 分发与回调执行（B3）、注册 API 与凭据（B4）、
> 管理面与前端（F1-F3）仍为后续子单。

## 架构（骨架已定型）

```
下游 Worker ──注册/创建任务(API)──► waker Worker
                                        │ RPC
                                ┌───────┴────────┐
                                │ WakerDO        │ 唯一实例，真源 SQLite
                                │ setAlarm(最近到期)│
                                └───────┬────────┘
                            alarm 到期   │ 投递
                                        ▼
                                  WAKER_QUEUE ──► consumer ──► 下游回调（HMAC 签名）
                                        │ 重试用尽
                                        ▼
                                  WAKER_DLQ ──► consumer ──► DO 死信表（页面可重放）
watchdog Cron（全仓唯一，每小时）──► ping WakerDO 校正 alarm
```

绑定契约（B1 定死，后续子单沿用，改名需评审）：

| 类型 | 绑定名 | 目标 |
|---|---|---|
| Durable Object | `WAKER_DO` | 类 `WakerDO`（SQLite 后端，任务真源） |
| Queue（主） | `WAKER_QUEUE` | `waker-jobs` |
| Queue（死信） | `WAKER_DLQ` | `waker-dlq` |
| Cron | — | `0 * * * *`（watchdog，全仓唯一 1 个） |

硬约束：

1. 全仓只允许 1 个 Cron Trigger（watchdog）。`pnpm check:cron` 在 CI 里强制校验。
2. 真源只有 `WakerDO` 的 SQLite：不建 D1、不用共享 D1、不用 KV。同上校验。
3. 每个项目自己的 signing key 由平台运行时生成并存 DO，不进 env、不进 CI。

## 目录结构

```
src/index.ts            Worker 入口（fetch / scheduled / queue）
src/app.ts              Hono 路由骨架（/healthz + 后续 API 占位 501）
src/do/waker-do.ts      WakerDO：任务生命周期 RPC + alarm tick + 分发接缝（B3 扩展点）
src/do/schema.ts        SQLite 数据模型与迁移（版本账本在 waker_meta 表）
src/do/types.ts         冻结 RPC 契约的出入参类型
src/do/errors.ts        WakerError + 返回信封（ok / failure）
src/do/policies.ts      misfire 补跑决策、确定性抖动（纯逻辑）
src/do/instance.ts      唯一实例取用入口（idFromName('waker')）
src/cron/dialect.ts     CF Cron Triggers 方言校验 + 规范化
src/cron/schedule.ts    croner 封装（alternativeWeekdays / 时区 / 下次执行时刻）
src/queue/consumer.ts   Queue consumer 骨架（B3：主队列 / 死信队列）
src/env.ts              绑定与密钥的类型声明
scripts/check-single-cron.mjs  硬约束守卫（Cron 数量 / 禁 D1·KV）
scripts/ci/gen-secrets-file.sh 密钥管线（逐键非空 → secrets.json 0600）
.github/workflows/ci.yml        CI：typecheck / lint / 守卫 / test / build
.github/workflows/deploy.yml    手动部署（用户关口，凭据未配齐即跳过）
```

## 数据模型（真源：WakerDO 的 SQLite）

| 表 | 用途 |
|---|---|
| `jobs` | 任务：`kind` 分 `cron` / `one_shot`；策略字段 `misfire_policy` / `concurrency_policy` / `max_retries` / `backoff_seconds` / `timeout_seconds` / `jitter_seconds`；`next_run_at` 驱动 alarm |
| `executions` | 执行记录：一次到期槽位一行，`scheduled_for`（名义时刻）/ `dispatch_at`（含抖动）/ `status` / `attempt` / 结果字段 |
| `dead_letters` | 死信：主队列重试用尽后转存，供管理面重放（写入语义归 B3） |
| `projects` | 接入项目（语义归 B4），令牌只存哈希 |
| `signing_keys` | 每项目独立回调签名密钥，可轮换（语义归 B4） |
| `waker_meta` | schema 版本账本（DO 的 SQLite 不允许读写 `PRAGMA user_version`，故用表记版本） |

调度模型要点：

- `next_run_at` 是「下一次名义调度时刻」，alarm 只按它排序取最早的一次唤醒；
- alarm 触发时取**全部** `next_run_at <= now` 的任务（天然回看补发，不丢分钟），按 `misfirePolicy` 折算要补几次；
- 每次任务变更 / tick 后重算最早到期并 `setAlarm`；watchdog（唯一 Cron Trigger）每小时调 `syncAlarm` 兜底 alarm 丢失；
- `executions.dispatch_at = scheduled_for + 抖动`，抖动按 `(jobId, 槽位)` 做确定性哈希，防惊群且可复现；
- B2 不投递 Queue：执行记录停在 `pending`，`WakerDO.#dispatchPending` 是 B3 的唯一扩展点
  （B3 换成 `WAKER_QUEUE.sendBatch(..., { delaySeconds })` 并把状态推进到 `dispatched`）。

## cron 方言（CF 官方 Cron Triggers 语法）

解析器在 `src/cron/`，真源是 CF 文档 *Cron Triggers → Supported cron expressions*：

- 只收 5 字段（分 时 日 月 星期）；秒字段、年字段、`?`、`@` 宏在解析期拒绝；
- 星期编号 **1=周日 … 7=周六**（croner 必须开 `alternativeWeekdays: true`，否则整体错位一天且不报错）；
- 扩展形式：DOM 的 `L` / `LW` / `nW`，DOW 的 `6L` / `friL` / `MON#1`；
- `friL` 这类 CF 拼写会规范化成引擎内部形式（`6#L`），**不因库拼写差异拒收合法 CF 表达式**；
- 时区是任务的独立字段（默认 UTC），语义与 CF 原生一致；
- DOM 与 DOW 同时受限时取「或」语义（Vixie / Quartz 一致，croner 默认 `domAndDow: false`）。

## RPC 契约（B2 冻结）

`WakerDO` 用 CF 原生 RPC（`extends DurableObject`），方法一律返回信封
`{ ok: true, value } | { ok: false, error: { code, message, details? } }`——错误码跟着返回值走，
不依赖异常反序列化（CF 文档明确 RPC 错误不保证 `instanceof`，只保证可序列化自有属性）。

| 方法 | 入参 | 成功返回值 |
|---|---|---|
| `createJob` | `CreateJobInput` | `JobView` |
| `cancelJob` / `pauseJob` / `resumeJob` | `JobRef` | `JobView` |
| `manualTrigger` | `JobRef & { payload? }` | `{ jobId, executionId, scheduledFor, dispatchAt }` |
| `getJob` | `JobRef` | `JobView \| null` |
| `listJobs` | `{ projectId?, status?, kind?, limit?, cursor? }` | `{ jobs, nextCursor }` |
| `syncAlarm`（内部，watchdog 用） | — | `{ now, dueJobs, createdExecutions, skippedExecutions, pendingDispatches, nextWakeAt }` |

错误码：`invalid_argument` / `invalid_cron` / `invalid_timezone` / `invalid_run_at` / `invalid_policy` /
`duplicate_job` / `job_not_found` / `job_cancelled` / `job_not_resumable` / `internal`。
类型定义见 `src/do/types.ts`；调度器内部调用用 `unwrap()` 拆信封。

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 本地占位密钥，.dev.vars 已被 gitignore
pnpm dev                          # wrangler dev
pnpm verify                       # typecheck + lint + 守卫 + test + build
pnpm test                         # vitest：cron 方言 / 策略纯逻辑 / DO 集成（workerd 真跑）
```

DO 集成测试用 wrangler 的 `createTestHarness`（Miniflare → workerd），读的是本仓真实的
wrangler.toml：真 DO 绑定、真 SQLite 后端，断言直接查库，不是 mock。

`.dev.vars` 只放本地占位值；真实密钥只存在于 GitHub Secrets 与平台侧。

## 密钥与 CI/CD

密钥分两类：

- 组织级：secret `CLOUDFLARE_API_TOKEN` + variable `CLOUDFLARE_ACCOUNT_ID`（复用，不在本仓设置）。
- 本项目自身：secret `SETUP_SECRET`、`JWT_SECRET`（GitHub Secrets，需由用户在该仓 Settings 中配置）。

落地方式（舰队标准）：

```
GitHub Secrets ─► scripts/ci/gen-secrets-file.sh ─► $RUNNER_TEMP/secrets.json (0600)
                ─► wrangler deploy --secrets-file "$RUNNER_TEMP/secrets.json"
```

- 生成前逐键非空校验，任一为空即失败关闭：不生成文件、不部署，并报出缺哪把 key；
- 只打印键名，绝不打印密钥值；部署后无论成败都删除明文文件；
- CI 的非部署 job 使用占位值跑通 typecheck / test / build。

部署是**用户关口**：`Deploy` 工作流只能手动触发，且需要输入 `confirm=deploy`，凭据未配齐时 `preflight` 报缺键、`deploy` job 跳过。团队不自行合并、不自行部署。

## 排期

| 阶段 | 内容 |
|---|---|
| B1 | 脚手架、wrangler、CI/CD、密钥管线 |
| B2（本单） | WakerDO 内核 + SQLite 数据模型 + 任务生命周期 RPC + CF 方言 cron 解析器 |
| B3 | Queue 分发与回调协议（HMAC 签名、重试、死信） |
| B4 | 注册 API、项目管理与凭据、管理面 API |
| F1-F3 / B5 | 管理面前端、客户端 SDK |
