# 参考接入示例：双模式共用一份任务逻辑

这是一个**下游项目形态**的示例 Worker：它既能在原生 CF Cron Trigger 模式（默认）下跑，
也能整体切到 waker 平台回调模式，而**业务代码一个字都不用改**。

| 模式 | 配置文件 | 调度来源 | SDK |
|---|---|---|---|
| 模式一（默认）原生 | `wrangler.cron.toml` | CF Cron Trigger（`[triggers]`） | **不加载**（`WAKER_MODE` 缺省 = `cron`，`createApp` 在健康检查后就返回） |
| 模式二 waker | `wrangler.waker.toml` | waker 平台（DO Alarm → Queue → HMAC 回调） | 挂载 `/_waker` receiver + 构造注册客户端 |

两种模式共用：

- **同一份任务处理逻辑**：`src/jobs.ts` 的 `runJob()`；
- **同一条 cron 表达式**：`DAILY_CLEANUP_CRON = '0 3 * * *'`，`wrangler.cron.toml` 的
  `[triggers]` 与 waker 模式的注册清单都取它，**逐字一致**（B2 冻结的 CF 官方方言）；
- **同一个任务名**：`daily-cleanup`（平台任务名 / manifest / receiver 的 key 都是它）。

## 文件

```
src/index.ts   Worker 入口：scheduled()（原生模式）+ fetch（模式切换点）
src/app.ts     HTTP 面：健康检查 / demo 接口；waker 模式才 import SDK 并挂载 /_waker
src/jobs.ts    业务逻辑（两入口共用）+ 声明式清单 + cron → 任务名的映射
src/env.ts     绑定与变量
wrangler.cron.toml   模式一：原生 Cron Trigger
wrangler.waker.toml  模式二：无 triggers、WAKER_MODE=waker、WAKER_URL、D1 幂等账本
migrations/0001_waker_executions.sql  下游自己的幂等表（SDK 的 executionLedgerDdl()）
```

## 完整链路（本地 smoke）

`pnpm test` 里的 `tests/reference-example.test.ts` 会把整条链路真跑一遍：

1. **注册**：`POST /admin/sync-manifest` → SDK 调平台 `PUT /v1/manifest` → 平台落库 `daily-cleanup`；
2. **调度**：平台侧手动触发 `daily-cleanup`（线上由 alarm 到期驱动）；
3. **回调**：平台 Queue consumer 同步 POST 本示例的 `/_waker/execute`，receiver 验签（HMAC + 5 分钟时间窗）
   → `executionId` 幂等落表 → `runJob()` 跑业务 → 2xx；
4. **自续**：`POST /demo/reminders` 用 SDK 建一个 one-shot（`reminder-tick-<label>`），
   handler 在窗口内返回 `nextRunAt`，平台校验后以同一 job 系列续期，下一次到期再回调。

同一条测试还断言了双模式：`WAKER_MODE` 缺省时 `/_waker/execute` 是 404（SDK 未挂载），
而 `scheduled({ cron: '0 3 * * *' })` 走的是**同一份** `runJob()`，产出与回调模式一致。

## 手动跑一遍（可选）

```bash
# 模式一：原生 Cron Trigger
wrangler dev -c examples/reference-worker/wrangler.cron.toml
curl 'http://127.0.0.1:8787/healthz'       # {"ok":true,...,"mode":"cron"}
curl 'http://127.0.0.1:8787/_waker/execute' -X POST   # 404：原生模式下 SDK 没挂载

# 模式二：waker
# 1) 平台管理面建项目（系统管理 → 项目管理），回调地址填本 Worker 的公开地址；
#    记下一次性展示的「项目令牌」与「signing key」。
# 2) 注入凭据（不要写进配置文件）：
wrangler secret put WAKER_TOKEN       -c examples/reference-worker/wrangler.waker.toml
wrangler secret put WAKER_SIGNING_KEY -c examples/reference-worker/wrangler.waker.toml
# 3) 跑起来并同步声明式清单
wrangler dev -c examples/reference-worker/wrangler.waker.toml
curl -X POST 'http://127.0.0.1:8787/admin/sync-manifest' -H "x-demo-token: $DEMO_TOKEN"
# 4) 建一个自续的一次性任务
curl -X POST 'http://127.0.0.1:8787/demo/reminders' -H "x-demo-token: $DEMO_TOKEN" \
     -H 'content-type: application/json' -d '{"label":"demo","dueInMs":15000,"intervalMs":60000}'
# 5) 看两条入口的业务记录
curl 'http://127.0.0.1:8787/demo/runs'
```

## 说明与边界

- **demo 接口只用于演示**：`/admin/sync-manifest`、`/demo/*` 用 `DEMO_TOKEN` 这种示例级口令保护，
  真实下游请接自己的鉴权体系；这些路由只在 waker 模式下存在。
- **幂等账本用下游自己的 D1**（`wrangler.waker.toml` 的 `WAKER_DB`），与平台真源（WakerDO 的 SQLite）无关；
  本地/测试没有 D1 时 SDK 会退化成内存账本，仅够跑通链路。
- **示例不迁移任何真实下游项目**：eNotify / post / shortlink 的正式接入是各自独立的单。
- **切回模式一**：换回 `wrangler.cron.toml` 重新部署即可，代码零改动（平台侧把该项目的任务停用即可）。
