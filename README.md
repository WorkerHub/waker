# waker

全舰队统一调度平台。用 **1 个 watchdog Cron Trigger + Durable Object Alarm + Queue** 取代各项目自有的 Cron Triggers，支持声明式 cron 任务与 one-shot 自续任务。

- Worker：`waker`
- 域名：`waker.oneboy.app`
- 规格：父单 ONE-373 内嵌 SPEC.md v1.0（唯一规格源）

> 当前状态：**脚手架阶段（B1）**。仓库骨架、wrangler 配置、CI/CD、密钥管线已就位；调度内核、API、管理面均为后续子单，代码里只有占位空壳。

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
src/do/waker-do.ts      WakerDO 类壳（表结构与 alarm 逻辑见后续单）
src/queue/consumer.ts   Queue consumer 骨架（主队列 / 死信队列）
src/cron/watchdog.ts    watchdog 入口占位（后续单做 alarm 校正）
src/env.ts              绑定与密钥的类型声明
scripts/check-single-cron.mjs  硬约束守卫（Cron 数量 / 禁 D1·KV）
scripts/ci/gen-secrets-file.sh 密钥管线（逐键非空 → secrets.json 0600）
.github/workflows/ci.yml        CI：typecheck / lint / 守卫 / test / build
.github/workflows/deploy.yml    手动部署（用户关口，凭据未配齐即跳过）
```

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 本地占位密钥，.dev.vars 已被 gitignore
pnpm dev                          # wrangler dev
pnpm verify                       # typecheck + lint + 守卫 + test + build
```

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
| B1（本单） | 脚手架、wrangler、CI/CD、密钥管线 |
| 后续 | WakerDO 内核与 alarm、Queue 分发与回调协议、注册 API、管理面、前端、SDK |
