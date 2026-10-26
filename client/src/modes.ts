/**
 * 双模式（可选接入）—— 父单规格补充二（2026-10-26，SPEC §0/§5/§9）。
 *
 * 下游项目默认走**原生 CF Cron Trigger**（`WAKER_MODE=cron`，缺省值），
 * 想改用平台调度时把它切成 `WAKER_MODE=waker` 并注入 `WAKER_URL` + 项目令牌 + signing key。
 *
 * 「可选接入」在 SDK 层面落到三件事上：
 *   1. **默认关闭**：`WAKER_MODE` 缺失 / 取值不认识 → 一律按 `cron`（原生模式）处理，
 *      下游不需要为了「不启用」写任何额外代码；
 *   2. **不加载**：`cron` 模式下 receiver 不挂载、注册客户端不构造（见
 *      {@link mountWakerReceiver} / `createWakerClientFromEnv` 返回 null），
 *      参考示例进一步用动态 `import()` 保证 SDK 模块在原生模式下**连求值都不发生**；
 *   3. **原生 scheduled() 不受影响**：模式只影响 HTTP 侧的接线，`scheduled()` 是下游自己的
 *      代码路径，SDK 从不接管它。
 */

/** 两种模式：原生 CF Cron Trigger（默认） / waker 回调。 */
export type WakerMode = 'cron' | 'waker'

/** 模式开关的环境变量名（部署期由 wrangler `[vars]` 或 secrets 注入）。 */
export const WAKER_MODE_ENV = 'WAKER_MODE'

/** 平台地址（waker 模式下 SDK 调注册 API 用）。 */
export const WAKER_URL_ENV = 'WAKER_URL'

/** 项目令牌（注册 API 鉴权用；只从 secrets 注入，绝不进仓库）。 */
export const WAKER_TOKEN_ENV = 'WAKER_TOKEN'

/** 项目 signing key（回调验签用；只从 secrets 注入）。 */
export const WAKER_SIGNING_KEY_ENV = 'WAKER_SIGNING_KEY'

export const WAKER_MODE_CRON: WakerMode = 'cron'
export const WAKER_MODE_WAKER: WakerMode = 'waker'

/** 最小 env 外形：只要可读的键值表，不绑定任何框架泛型。 */
export type WakerEnvLike = Record<string, unknown> | null | undefined

/**
 * 解析当前模式。
 *
 * 未知取值按 `cron` 处理（**不是**抛错也不是猜成 waker）：可选接入的默认必须是「不动下游」，
 * 部署期写错变量最多是「没启用」，不会出现「悄悄改成回调模式却没配密钥」的半死状态。
 */
export function resolveWakerMode(env: WakerEnvLike): WakerMode {
  const raw = env?.[WAKER_MODE_ENV]
  if (typeof raw !== 'string') return WAKER_MODE_CRON
  return raw.trim().toLowerCase() === WAKER_MODE_WAKER ? WAKER_MODE_WAKER : WAKER_MODE_CRON
}

/** 是否启用 waker（= 模式为 `waker`）。 */
export function isWakerEnabled(env: WakerEnvLike): boolean {
  return resolveWakerMode(env) === WAKER_MODE_WAKER
}

/** 从 env 里取一个非空字符串（缺失 / 空白 → null）。 */
export function readEnvString(env: WakerEnvLike, key: string): string | null {
  const raw = env?.[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}
