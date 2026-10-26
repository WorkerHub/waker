# waker

全舰队统一调度平台。用 **1 个 watchdog Cron Trigger + Durable Object Alarm + Queue** 取代各项目自有的 Cron Triggers，支持声明式 cron 任务与 one-shot 自续任务。

- Worker：`waker`
- 域名：`waker.oneboy.app`
- 规格：父单 ONE-373 内嵌 SPEC.md v1.0（唯一规格源）

> 当前状态：**调度内核 + 执行引擎已就位（B1 + B2 + B3）**。WakerDO 的 SQLite 数据模型、任务生命周期 RPC、
> alarm 自愈、CF 方言 cron 解析器，以及 Queue 分发 → 同步回调（HMAC 签名）→ 重试/死信 → 自续的整条执行链路
> 已完成并有测试覆盖；注册 API 与凭据（B4）、执行记录 / 死信查询 RPC（B6）、管理面与前端（F1-F3）、
> SDK（B5）仍为后续子单。

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
src/app.ts              Hono 路由表（/healthz + /v1 注册 API + /api 管理面 API）
src/api/auth.ts         两套鉴权：项目令牌（bearerAuth）+ 管理面会话 JWT（hono/jwt）
src/api/registration.ts 注册 API 路由（/v1/whoami /v1/jobs /v1/manifest）
src/api/management.ts   管理面 API 路由（项目 / 凭据轮换 / 任务 / 系统状态）
src/api/errors.ts       RPC 错误码 → HTTP 状态码与统一错误体
src/do/waker-do.ts      WakerDO：任务生命周期 RPC + alarm tick + Queue 分发 + 执行结果回填/自续/死信
src/do/schema.ts        SQLite 数据模型与迁移（版本账本在 waker_meta 表）
src/do/types.ts         冻结 RPC 契约的出入参类型
src/do/errors.ts        WakerError + 返回信封（ok / failure）
src/do/policies.ts      misfire 补跑决策、确定性抖动（纯逻辑）
src/do/instance.ts      唯一实例取用入口（idFromName('waker')）
src/do/engine-rpc.ts    执行引擎 RPC 面（consumer 专用：认领/回填/死信/重放）
src/do/http-rpc.ts      HTTP 层用到的 RPC 面（编译期断言与 WakerDO 签名一致）
src/do/keyring.ts       项目令牌哈希 / signing key 生成与 AES-GCM 信封（WebCrypto 原生）
src/do/projects.ts      项目与凭据的数据访问层（只写哈希与密文）
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
| `projects` | 接入项目：`token_hash`（只存 `sha256(令牌)`，唯一索引直查）、`token_created_at` / `token_rotated_at`、`callback_url`（项目根地址，执行期拼 `/_waker/execute`） |
| `signing_keys` | 每项目独立回调签名密钥：`secret` 自迁移 v3 起存 AES-256-GCM 信封（明文不落库）、`fingerprint`（展示用）、`algorithm`；轮换置 `revoked_at` / `rotated_at` |
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

B4 追加（任务更新 / 清单对账 / 项目管理，仍是纯加法，B2/B3 的方法表与错误码零改动）：

| 方法 | 入参 | 成功返回值 |
|---|---|---|
| `updateJob` | `{ jobId, cron?, runAt?, timezone?, payload?, policies?, enabled? }` | `JobView`（不换 id；排期字段变了才重算 `nextRunAt`） |
| `syncManifest` | `{ projectId, jobs: ManifestJobInput[] }` | `{ projectId, created, updated, unchanged, paused, jobs }` |
| `createProject` | `{ name, callbackUrl }` | `{ project, token, signingKey }`（明文唯一一次） |
| `listProjects` / `getProject` | — / `{ projectId }` | `{ projects }` / `ProjectView \| null` |
| `updateProject` | `{ projectId, name?, callbackUrl? }` | `ProjectView` |
| `rotateProjectToken` | `{ projectId }` | `{ project, token }` |
| `rotateSigningKey` | `{ projectId }` | `{ project, signingKey }` |
| `verifyProjectToken` | `{ token }` | `{ projectId, projectName, callbackUrl } \| null` |
| `getSystemStatus` | — | `{ now, schemaVersion, watchdogLastRunAt, watchdogLastDueJobs, nextWakeAt, counts }` |

B6 追加（执行记录 / 死信查询，同样纯加法；只读，不改任何行）：

| 方法 | 入参 | 成功返回值 |
|---|---|---|
| `listExecutions` | `{ jobId?, projectId?, status?, trigger?, scheduledFrom?, scheduledTo?, limit?, cursor? }` | `{ executions: ExecutionView[], nextCursor }` |
| `listDeadLetters` | `{ jobId?, projectId?, replayState?, createdFrom?, createdTo?, limit?, cursor? }` | `{ deadLetters: DeadLetterView[], nextCursor }` |

查询语义（冻结，F2 按此对接）：

- **排序**：`listExecutions` = `scheduledFor DESC, id DESC`（最近的排最前；`scheduledFor` 是不可变列，
  翻页期间执行完成不会让已翻过的行动位）；`listDeadLetters` = **未重放优先** → `createdAt DESC` → `id DESC`
  （死信页第一屏是还没人管的那些，已重放的按死亡时刻倒序留痕）。
- **分页**：keyset 游标，`nextCursor` 原样回传即可；默认 `limit = 50`、上限 `200`（与 `listJobs` 一致）；
  `id` 是同一时刻多条时的稳定 tiebreak。死信分桶用的是可空列 `replayed_at`，游标里带桶标记
  （`p` / `r`）：游标落在未重放桶时桶内续页再接上已重放桶，落在已重放桶时只续该桶——
  这就是 B2 复评 blocking 修复的 NULL 区间语义，不会每页从头返回第 1 页。
- **时间区间**一律半开 `[from, to)`：`from` 含、`to` 不含（按天分页不会把 00:00:00.000 算两次）；
  `from > to` 报 `invalid_argument`，`from === to` 是合法空区间。
- **筛选值校验**：`status` / `trigger` / `replayState` 只收固定枚举，写错报 `invalid_argument`
  （不是静默返回空列表——否则「参数错了」会被伪装成「没有数据」）。
- `ExecutionView` 含时间 / 任务（`jobId` + 联表 `jobName`）/ 状态 / 耗时 / 重试次数（`attempt`）/
  错误信息 / 自续结果；**不含 `payload` 与 `signingKeyId`**（载荷不随列表批量下发）。
  死信条目复用 B3 的 `DeadLetterView`（含 `payload`、`replayedAt`、`replayedExecutionId`）。

错误码：`invalid_argument` / `invalid_cron` / `invalid_timezone` / `invalid_run_at` / `invalid_policy` /
`duplicate_job` / `duplicate_project` / `name_conflict` / `job_not_found` / `project_not_found` /
`job_cancelled` / `job_not_resumable` / `execution_not_found` / `dead_letter_not_found` /
`signing_key_missing` / `signing_key_unreadable` / `callback_target_missing` / `internal`。
B6 只用到 `invalid_argument`（两个查询都是只读、无「找不到」语义）。
类型定义见 `src/do/types.ts`；调度器内部调用用 `unwrap()` 拆信封。

## 注册 API（B4 冻结，供 B5 SDK / CI 对齐）

鉴权：`Authorization: Bearer <项目令牌>`（建项目时发放，只存 `sha256` 哈希）。
**项目身份只来自令牌**：请求体里若带 `projectId` 且与令牌项目不一致 → 400 `invalid_argument`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/whoami` | `{ project: { id, name } }`：令牌对应的项目身份 |
| GET | `/v1/jobs` | 本项目任务列表；query `status` / `kind` / `limit` / `cursor`（游标语义同 `listJobs`） |
| POST | `/v1/jobs` | 运行时创建任务（one-shot 为主）；body = `CreateJobInput` 去掉 `projectId`；201 `{ job }` |
| DELETE | `/v1/jobs/{name}` | 取消任务（幂等）；200 `{ job }`；未知名字 404 `job_not_found` |
| PUT | `/v1/manifest` | 部署期声明式同步 + 对账（幂等） |

清单请求体：

```jsonc
{ "jobs": [ { "name": "nightly-cleanup", "cron": "0 3 * * *", "timezone": "Asia/Shanghai",
              "payload": {}, "policies": {}, "enabled": true } ] }
```

应答 `{ projectId, created[], updated[], unchanged[], paused[], jobs[] }`：

- 清单里有、平台没有 → 新建（`kind = 'cron'`，`created`）；
- 内容或状态不一致 → 改写（`updated`；含从 `paused` 恢复、把已取消的 cron 按声明式复位）；
- 平台侧多出、清单里没有的**同项目 cron 任务** → 停用（`paused`：`status = paused` + `next_run_at` 清空）；
- 运行时 one-shot **不参与对账**：它是业务在运行时建的，CI 部署不该把用户正在跑的定时任务停掉；
- 清单名被同项目 one_shot 占用 → 409 `name_conflict`；
- 任一条目 cron 非法 → 400 `invalid_cron`（`details = { name, cron: { dialectCode, field } }`），**整批不写库**。

cron 校验复用 B2 冻结的 CF 方言解析器（`src/cron/`），注册 API 不另写一套解析。

## 管理面 API（B4 冻结，供 F1 / F3 对齐）

鉴权：`POST /api/auth/setup`（body `{ "setupSecret": "<SETUP_SECRET>" }`）换 12 小时会话 JWT，
应答 `{ session: { token, expiresAt } }`；其余 `/api/*` 需 `Authorization: Bearer <JWT>`
（Hono 原生 `hono/jwt` 签发与校验）。未鉴权一律 401 `unauthorized`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/setup` | SETUP_SECRET → 会话 JWT |
| GET | `/api/projects` | `{ projects: ProjectView[] }`（只有掩码，无明文） |
| POST | `/api/projects` | `{ name, callbackUrl }` → 201 `{ project, token, signingKey }`（**明文唯一一次**） |
| GET | `/api/projects/{id}` | `{ project }` |
| PATCH | `/api/projects/{id}` | `{ name?, callbackUrl? }` → `{ project }` |
| POST | `/api/projects/{id}/token/rotate` | `{ project, token }`（旧令牌立即失效） |
| POST | `/api/projects/{id}/signing-key/rotate` | `{ project, signingKey }`（旧 key 标记撤销） |
| GET | `/api/jobs?...` | `{ jobs, nextCursor }`（同 B2 `listJobs`） |
| POST | `/api/jobs` | 201 `{ job }`（body 含 `projectId`，项目必须存在） |
| GET | `/api/jobs/{id}` | `{ job }` |
| PATCH | `/api/jobs/{id}` | `{ cron?, runAt?, timezone?, payload?, policies?, enabled? }` → `{ job }` |
| POST | `/api/jobs/{id}/{pause\|resume\|cancel}` | `{ job }` |
| POST | `/api/jobs/{id}/trigger` | 202 `{ jobId, executionId, scheduledFor, dispatchAt }` |
| GET | `/api/system/status` | watchdog 上次校正 / schema 版本 / 计数 / 密钥状态位（只读，不含值） |

凭据规则（两条硬要求）：

- **项目令牌只存哈希**：`projects.token_hash = sha256(token)`，唯一索引直查；明文只在发放/轮换应答里
  出现一次，列表与详情只回 `tokenFingerprint`（哈希前 16 hex）。
- **signing key 加密存 DO**：`signing_keys.secret` 存 AES-256-GCM 信封；KEK 由 `JWT_SECRET` 经
  HKDF-SHA256 派生（不新增部署期 secret）。解密只在 `WakerDO.#resolveCallbackTarget` 内发生：
  明文不进队列消息、不进日志、不回 HTTP；解不开时报 `signing_key_unreadable` 并直接进死信
  （绝不拿密文当明文签出一个「看起来正常」的错签名）。

错误体固定为 `{ "error": { "code", "message", "details"? } }`，`code` 与 RPC 错误码一一对应
（B4 新增 `project_not_found` / `duplicate_project` / `name_conflict` / `signing_key_unreadable`）。

未挂载的管理面子路径（如 `/api/executions`、`/api/dead-letters`）仍回 501 `not_implemented`：
B6 的 `listExecutions` / `listDeadLetters` 查询 RPC 已就位并有测试覆盖，HTTP 路由由后续管理面单挂载
（本单范围只有 DO 查询 RPC，不动管理面路由）。

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

B4 的用例：

- `tests/api.test.ts`：注册 API / 管理面 / 清单对账 / 凭据轮换，**全走 `worker.fetch` 的 HTTP 入口**
  （真路由、真中间件、真鉴权），并同时断言库里的真实形态（令牌只存哈希、signing key 只存密文）；
  最后一条是端到端：建项目拿明文 key → 改回调地址 → 建任务 → 手动触发 → 下游用那份明文验签通过。
- `tests/keyring.test.ts`：令牌生成/哈希/掩码、AES-GCM 信封往返、换密钥与密文篡改必须解不开（fail closed）。
- 测试用 `SETUP_SECRET` / `JWT_SECRET` 由 `createTestHarness` 的 `secrets` 选项注入（占位值），
  与线上 `wrangler deploy --secrets-file` 注入的是同一组绑定名，代码路径一致。

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
| B6 | 查询 RPC：`listExecutions` / `listDeadLetters`（执行记录页 / 死信页） |
| B3 | 执行引擎：Queue 分发 + 回调协议 v2（HMAC）+ 重试/DLQ + 自续 |
| B4 | 注册 API + 清单对账、项目管理与凭据（令牌哈希 / signing key 加密）、管理面 API、watchdog 账本 |
| F1-F3 / B5 | 管理面前端、客户端 SDK |
