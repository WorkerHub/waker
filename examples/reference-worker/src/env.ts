/**
 * 参考接入示例的运行时绑定。
 *
 * 双模式（父单规格补充二）：
 *   - `WAKER_MODE` 缺省 / `cron`：原生 CF Cron Trigger 模式，只用下面「基础」字段；
 *   - `WAKER_MODE=waker`：接入 waker 平台，额外注入 `WAKER_URL` + 两个 secret。
 *
 * 注意：这里没有任何敏感值写死 —— 令牌与 signing key 只经 `wrangler secret put` 注入。
 */
export interface ReferenceEnv {
  /** 模式开关：`cron`（默认，原生 Cron Trigger）/ `waker`（平台回调）。 */
  WAKER_MODE?: string
  /** 平台根地址（waker 模式，如 `https://waker.oneboy.app`）。 */
  WAKER_URL?: string
  /** 项目令牌（waker 模式，secret；调平台注册 API 用）。 */
  WAKER_TOKEN?: string
  /** 项目 signing key（waker 模式，secret；回调验签用，建项目时一次性展示）。 */
  WAKER_SIGNING_KEY?: string
  /** 示例 demo 路由的口令（示例专用；真实下游请接自己的鉴权）。 */
  DEMO_TOKEN?: string
  /** 幂等账本（下游自己的 D1；未绑定时退化为内存账本，仅本地/测试可用）。 */
  WAKER_DB?: D1Database
}
