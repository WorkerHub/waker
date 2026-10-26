/**
 * 平台自身的常量（设置 / 关于 / 系统管理页共用）。
 *
 * 这些都是**构建期就知道的事实**（名字、域名、仓库、规格版本），不是运行期数据：
 * 运行期状态一律走 `GET /api/system/status`，页面不在这份文件里编造任何状态。
 */

export const PLATFORM_NAME = 'waker'
export const PLATFORM_TAGLINE = '全舰队统一调度平台'
export const PLATFORM_DOMAIN = 'waker.oneboy.app'
export const PLATFORM_REPO_URL = 'https://github.com/WorkerHub/waker'
export const PLATFORM_SPEC = 'SPEC.md v1.0（2026-10-26 定稿）'

/** 构建期注入的 `git describe` 版本号（与页脚同一个来源）。 */
export const PLATFORM_VERSION = __APP_VERSION__

/**
 * 平台状态里展示的部署事实（定点值，不是读回来的运行期状态）：
 * 全平台只有 1 个 watchdog Cron Trigger、1 个 WakerDO 实例（单个 SQLite 真源）。
 */
export const PLATFORM_RUNTIME = {
  cronTriggers: '1（watchdog，每小时）',
  doInstance: 'waker（WakerDO 单实例，SQLite）',
  mainQueue: 'waker-jobs',
  deadLetterQueue: 'waker-dlq',
} as const
