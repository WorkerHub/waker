# waker

全舰队统一调度平台。用 **1 个 watchdog Cron Trigger + Durable Object Alarm + Queue** 取代各项目自有的 Cron Triggers，支持声明式 cron 任务与 one-shot 自续任务。

- Worker：`waker`
- 域名：`waker.oneboy.app`
- 规格：父单 ONE-373 内嵌 SPEC.md v1.0（唯一规格源）

> 当前状态：**调度内核 + 执行引擎已就位（B1 + B2 + B3）**。WakerDO 的 SQLite 数据模型、任务生命周期 RPC、
> alarm 自愈、CF 方言 cron 解析器，以及 Queue 分发 → 同步回调（HMAC 签名）→ 重试/死信 → 自续的整条执行链路
> 已完成并有测试覆盖；注册 API 与凭据（B4）、管理面与前端（F1-F3）、SDK（B5）仍为后续子单。

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
src/do/waker-do.ts      WakerDO：任务生命周期 RPC + alarm tick + Queue 分发 + 执行结果回填/自续/死信
src/do/schema.ts        SQLite 数据模型与迁移（版本账本在 waker_meta 表）
src/do/types.ts         冻结 RPC 契约的出入参类型
src/do/errors.ts        WakerError + 返回信封（ok / failure）
src/do/policies.ts      misfire 补跑决策、确定性抖动（纯逻辑）
src/do/instance.ts      唯一实例取用入口（idFromName('waker')）
src/do/engine-rpc.ts    执行引擎 RPC 面（consumer 专用：认领/回填/死信/重放）
src/callback/protocol.ts  回调协议 v2 冻结常量与请求/响应结构
src/callback/sign.ts      HMAC-SHA256 签名与参考验签（WebCrypto 原生）
src/callback/client.ts    同步回调投递（超时 / 2xx 判定 / nextRunAt 提取）
src/cron/dialect.ts     CF Cron Triggers 方言校验 + 规范化
src/cron/schedule.ts    croner 封装（alternativeWeekdays / 时区 / 下次执行时刻）
src/queue/consumer.ts   Queue consumer：主队列（同步回调）/ 死信队列（转存死信表）
src/queue/backoff.ts    重试退避 → Queue delaySeconds 折算（纯逻辑）
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
| `dead_letters` | 死信：主队列重试用尽后由 DLQ consumer 转存，供管理面重放（`replayDeadLetter`） |
| `projects` | 接入项目（语义归 B4），令牌只存哈希；`callback_url` = 项目根地址（B3 用来拼回调地址） |
| `signing_keys` | 每项目独立回调签名密钥，可轮换（语义归 B4） |
| `waker_meta` | schema 版本账本（DO 的 SQLite 不允许读写 `PRAGMA user_version`，故用表记版本） |

调度模型要点：

- `next_run_at` 是「下一次名义调度时刻」，alarm 只按它排序取最早的一次唤醒；
- alarm 触发时取**全部** `next_run_at <= now` 的任务（天然回看补发，不丢分钟），按 `misfirePolicy` 折算要补几次；
- 每次任务变更 / tick 后重算最早到期并 `setAlarm`；watchdog（唯一 Cron Trigger）每小时调 `syncAlarm` 兜底 alarm 丢失；
- `executions.dispatch_at = scheduled_for + 抖动`，抖动按 `(jobId, 槽位)` 做确定性哈希，防惊群且可复现；
- 分发以库为准：`#dispatchPending` 扫 `status = 'pending'` 的执行，按 `dispatch_at` 折算 Queue
  `delaySeconds`（抖动/退避都用 Queue 原生延迟表达），投递成功后推进到 `dispatched`——
  消费者崩溃或「已发未落状态」的情况，下一 tick / watchdog 会自然补回，不丢任务；
- 重试计划也在库里：非 2xx 时由 DO 把执行改回 `pending`（`attempt + 1`、`dispatch_at = now + backoff·2^n`）
  再经 Queue 重投，不需要 consumer 自己重发消息；用尽 `maxRetries` 即判 `dead` 并转 `waker-dlq`。

## 回调协议 v2（B3 冻结）

语义按 SPEC §4：下游以 Hono 路由挂载 `/_waker/execute`，平台**同步** POST，`2xx = 成功`。
严禁 `waitUntil + 立即 OK`（那样分发方永远不知道成败，重试与死信都成摆设）。

请求头（下游验签材料，签名头命名在这里冻结）：

| 头 | 值 |
|---|---|
| `X-Waker-Timestamp` | epoch **秒**（十进制字符串），参与签名 |
| `X-Waker-Execution-Id` | 执行 id（= 下游幂等键），参与签名 |
| `X-Waker-Job-Id` | 任务 id，参与签名 |
| `X-Waker-Signature` | `v2=<小写 hex>` HMAC-SHA256 |
| `X-Waker-Project-Id` / `X-Waker-Attempt` / `X-Waker-Protocol-Version` | 排查用，不参与签名 |

签名规范串（逐字节，`\n` 分隔；body 必须是**未解析的原始请求体字符串**）：

```
<timestamp>\n<executionId>\n<jobId>\n<rawBody>
```

时间窗 `CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300`（秒）：下游必须拒收 `|now - timestamp| > 300` 的请求（防重放）。

请求体（JSON）：`{ protocolVersion: 2, executionId, jobId, projectId, jobName, kind, trigger, misfire,
attempt, scheduledFor, dispatchedAt, timeoutSeconds, payload }`。

响应体（2xx 时可带）：`{ nextRunAt?: number | ISO8601 }`。**只有 one-shot 会看它**：
平台校验「合法时间戳 → 严格晚于本次执行时刻 → 不超过 366 天」后以同一 job 系列续期；
校验失败不影响本次执行成功，只在执行记录 `renewal_error` 留原因。详情见 `src/callback/protocol.ts`。

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

B3 追加的执行引擎 RPC（consumer 专用，见 `src/do/engine-rpc.ts`）：

| 方法 | 入参 | 成功返回值 |
|---|---|---|
| `prepareExecution` | `{ executionId, attempt }` | `{ outcome: 'run' \| 'skip', reason, context, target, executionStatus }`（幂等/并发判定在此） |
| `recordExecutionResult` | `{ executionId, attempt, ok, httpStatus?, error?, startedAt, finishedAt, durationMs, nextRunAt? }` | `{ status, attempt, retryScheduled, retryAt, renewal }` |
| `recordDeadLetter` | `{ executionId, jobId?, projectId?, attempts?, error? }` | `DeadLetterView` |
| `replayDeadLetter` | `{ deadLetterId }` | `{ deadLetterId, jobId, executionId, scheduledFor, dispatchAt }` |

错误码：`invalid_argument` / `invalid_cron` / `invalid_timezone` / `invalid_run_at` / `invalid_policy` /
`duplicate_job` / `job_not_found` / `job_cancelled` / `job_not_resumable` /
`execution_not_found` / `dead_letter_not_found` / `signing_key_missing` / `callback_target_missing` / `internal`。
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
wrangler.toml：真 DO 绑定、真 SQLite 后端、真 Queue 与真 queue consumer，断言直接查库，不是 mock。
执行引擎的链路测试（`tests/engine.test.ts`）还会在 `127.0.0.1` 上真起一个下游 HTTP 服务，
用项目 signing key 从**下游视角**独立验签——所以「签名可用」是被第三方视角证明过的。

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
| B2 | WakerDO 数据模型 + 任务生命周期 RPC + CF 方言 cron 解析器 |
| B3（本单） | 执行引擎：Queue 分发 + 回调协议 v2（HMAC）+ 重试/DLQ + 自续 |
| B4 | 注册 API、项目管理与凭据、管理面 API |
| F1-F3 / B5 | 管理面前端、客户端 SDK |
