# `@workerhub/waker-client` —— waker 客户端 SDK

下游 Worker 接入 waker 平台用的 SDK，严格对齐三份冻结契约：

| 冻结契约 | SDK 落点 |
|---|---|
| 回调协议 v2（B3，`src/callback/protocol.ts`） | `src/protocol.ts` / `src/verify.ts` / `src/receiver.ts` |
| 注册 API（B4，`src/api/registration.ts`） | `src/client.ts` |
| CF Cron Triggers 方言（B2，`src/cron/`） | 声明式任务的 `cron` 字符串原样透传（不自行解析、不改写；校验由平台同一份解析器负责） |

与平台契约的一致性由 `tests/client-contract.test.ts` 逐项断言（常量 / 头名 / 签名规范串 /
请求响应结构都与平台实现对比），任何一边改了另一边没跟上，测试会直接失败。

## 怎么用

SDK 是**源码形态**、零额外依赖（唯一 peer 是 `hono`）：直接把 `client/src` 拷进下游项目
（例如 `src/waker/`），或在 monorepo 里按路径引用即可。它不 import 平台的任何内部模块。

```ts
import { Hono } from 'hono'
import {
  createWakerClientFromEnv,
  createD1ExecutionLedger,
  createMemoryExecutionLedger,
  mountWakerReceiver,
} from './waker'

const app = new Hono<{ Bindings: Env }>()

// 只在 WAKER_MODE=waker 时挂载；原生模式下这里什么都不做（返回 false）。
mountWakerReceiver(app, {
  env,                                  // signing key 默认取 env.WAKER_SIGNING_KEY
  jobs: {
    'daily-cleanup': async (ctx) => {
      await cleanup()
      return {}                         // 不带 nextRunAt = 本次完结
    },
    'reminder-tick-abc': async (ctx) => {
      const next = computeNext(ctx.payload)
      return next === null ? {} : { nextRunAt: next }   // 带 nextRunAt = 自续
    },
  },
  ledger: env.WAKER_DB ? createD1ExecutionLedger(env.WAKER_DB) : createMemoryExecutionLedger(),
})

// 运行时建 / 取消一次性任务（同一把项目令牌）
const waker = createWakerClientFromEnv(env)   // 原生模式返回 null
if (waker !== null) {
  await waker.createOneShot({ name: `letter-${id}`, runAt: deliverAt, payload: { letterId: id } })
}
```

路由挂载点是 `/_waker/execute`（`app.route('/_waker', createWakerReceiver(...))` 的等价写法由
`mountWakerReceiver` 内部完成）。

## API 一览

### receiver（`src/receiver.ts`）

| 导出 | 说明 |
|---|---|
| `createWakerReceiver({ jobs, signingKey?, ledger?, now?, toleranceSeconds?, onJobError? })` | 建一个只处理 `POST /execute` 的 Hono 子应用 |
| `mountWakerReceiver(app, { env, mode?, jobs, ledger?, ... })` | 可选接入入口：仅 `WAKER_MODE=waker` 时挂载到 `/_waker`，返回是否挂载 |
| `WakerJobContext` | handler 入参：`jobName` / `executionId`（幂等键）/ `jobId` / `payload` / `trigger` / `misfire` / `attempt` / `timeoutSeconds` … |
| `WakerJobs` | 任务分发：静态 map，或 `(jobName) => handler \| null` 解析函数（one-shot 名字常按业务 id 动态生成） |

行为（与协议 v2 一致）：

- 验签用**未解析的原始 body**，HMAC-SHA256，时间窗 300s；
- 验签失败 / 过期 → `401`；结构不对 → `400`；任务名未声明 → `404`；业务抛错 → `500` 并释放幂等占位
  （平台的同 `executionId` 重试会真的重跑）；
- 业务返回 `{ nextRunAt }` → 原样回给平台（平台自己校验「合法时间戳 / 严格晚于本次执行时刻 / ≤366 天」）；
- `ledger` 命中重复投递 → 回 `2xx` + `duplicate: true` + 首次响应体回放（自续的 `nextRunAt` 不丢）。

### 幂等账本（`src/ledger.ts`）

| 导出 | 说明 |
|---|---|
| `createD1ExecutionLedger(db, { table?, staleClaimSeconds? })` | 生产用：`INSERT … ON CONFLICT DO NOTHING` + `meta.changes` 原子认领（下游自己的 D1，与平台真源无关） |
| `createMemoryExecutionLedger()` | 本地 / 测试用（单 isolate 有效） |
| `executionLedgerDdl(table?)` | 建表 SQL（D1 migration 用） |

语义：`claim → 跑业务 → complete`；业务失败 `release`；占位超过 `staleClaimSeconds`（默认 600s）
视为上次执行已崩溃，允许接管，避免一条执行被永久当成「已处理」。

### 注册 / one-shot 客户端（`src/client.ts`）

| 导出 | 说明 |
|---|---|
| `createWakerClient({ baseUrl, token, fetch?, timeoutMs? })` | 项目令牌客户端（`Authorization: Bearer <项目令牌>`） |
| `createWakerClientFromEnv(env, { required? })` | 可选接入入口：原生模式返回 `null`；waker 模式读 `WAKER_URL` + `WAKER_TOKEN` |
| `WakerApiError` | 平台错误：`status` + 契约错误码 `code`（`unauthorized` / `invalid_cron` / `job_not_found` …） |

方法：`whoami()` / `listJobs(query?)` / `createJob(input)` / `createOneShot({ name, runAt, payload?, policies? })` /
`cancelJob(name)` / `syncManifest(jobs)`（部署期清单对账，幂等）。

`runAt` 接受 epoch 毫秒、ISO 8601 字符串或 `Date`；`cron` 表达式按 B2 的 CF 官方方言**原样透传**。

### 双模式（`src/modes.ts`）

| 导出 | 说明 |
|---|---|
| `resolveWakerMode(env)` / `isWakerEnabled(env)` | 读 `WAKER_MODE`；**缺省或未知取值一律按 `cron`**（可选接入默认关闭） |
| `WAKER_MODE_ENV` / `WAKER_URL_ENV` / `WAKER_TOKEN_ENV` / `WAKER_SIGNING_KEY_ENV` | 变量名常量 |

原生模式下的三件事：①接收器不挂载；②注册客户端不构造；③`scheduled()` 是下游自己的代码，
SDK 从不接管。参考示例进一步用动态 `import()` 保证原生模式下 SDK 模块连求值都不发生。

## 需要的环境变量（waker 模式）

| 名称 | 来源 | 用途 |
|---|---|---|
| `WAKER_MODE` | `[vars]` | `waker`（缺省 `cron`） |
| `WAKER_URL` | `[vars]` | 平台根地址，如 `https://waker.oneboy.app` |
| `WAKER_TOKEN` | **secret** | 项目令牌（注册 API 鉴权） |
| `WAKER_SIGNING_KEY` | **secret** | 项目 signing key（回调验签） |

两个 secret 都在管理面「项目管理」建项目时**一次性展示**，只经 `wrangler secret put` 注入，
绝不写进仓库、日志或队列消息。轮换后旧值立即失效。

## 测试

```bash
pnpm test        # 含 SDK 单测 / 契约对齐 / 真实平台注册 API 集成 / 参考示例全链路
```
