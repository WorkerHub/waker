/**
 * 常量时间比较（`SETUP_SECRET` 校验用）—— 从 `api/auth.ts` 原样搬来，
 * 供 DO 侧的初始化校验复用（DO 不该为了一个比较去 import HTTP 层）。
 *
 * 做法：用运行时原生 HMAC 计算两边的认证标签，再用 `crypto.subtle.verify` 比较 ——
 * 规范要求 verify 是常量时间实现，因此不泄漏「前缀匹配了多少位」。
 * 不手写逐字节比较（那正是计时侧信道来源）。
 */
const encoder = new TextEncoder()

export async function constantTimeEquals(
  presented: string,
  expected: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const tag = await crypto.subtle.sign('HMAC', key, encoder.encode(presented))
  return crypto.subtle.verify('HMAC', key, tag, encoder.encode(expected))
}
