import { describe, expect, it } from 'vitest'

import {
  CALLBACK_HEADERS,
  CALLBACK_PATH,
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_SIGNATURE_PREFIX,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  MAX_SELF_RENEWAL_HORIZON_MS,
  buildSignaturePayload,
  resolveCallbackUrl,
} from '../src/callback/protocol'
import { extractNextRunAt } from '../src/callback/client'
import {
  bytesToHex,
  hexToBytes,
  resetSignatureKeyCache,
  signCallback,
  verifyCallbackSignature,
} from '../src/callback/sign'
import { MAX_QUEUE_DELAY_SECONDS, queueDelaySeconds, retryDelaySeconds } from '../src/queue/backoff'

const SECRET = '{{SECRET_yzw4zxai}}'
const OTHER_SECRET = '{{SECRET_m5h4tlbk}}'

describe('回调协议 v2 · 签名', () => {
  it('签名/验签闭环通过，签名头格式为 v2=<64 位 hex>', async () => {
    const timestamp = '1730000000'
    const signature = await signCallback({
      secret: SECRET,
      timestamp,
      executionId: 'exec-1',
      jobId: 'job-1',
      body: '{"a":1}',
    })

    expect(signature.startsWith(CALLBACK_SIGNATURE_PREFIX)).toBe(true)
    expect(signature.slice(CALLBACK_SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)

    await expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp,
        executionId: 'exec-1',
        jobId: 'job-1',
        body: '{"a":1}',
        signature,
        now: Number(timestamp) * 1000,
      }),
    ).resolves.toEqual({ ok: true })
  })

  it('换密钥 / 改 body / 改 executionId / 改 jobId 一律验签失败', async () => {
    const timestamp = '1730000000'
    const body = '{"a":1}'
    const signature = await signCallback({
      secret: SECRET,
      timestamp,
      executionId: 'exec-1',
      jobId: 'job-1',
      body,
    })
    const now = Number(timestamp) * 1000

    const cases = [
      { secret: OTHER_SECRET, timestamp, executionId: 'exec-1', jobId: 'job-1', body },
      { secret: SECRET, timestamp, executionId: 'exec-1', jobId: 'job-1', body: '{"a":2}' },
      { secret: SECRET, timestamp, executionId: 'exec-2', jobId: 'job-1', body },
      { secret: SECRET, timestamp, executionId: 'exec-1', jobId: 'job-2', body },
      { secret: SECRET, timestamp, executionId: 'exec-1', jobId: 'job-1', body: `${body} ` },
    ]

    for (const input of cases) {
      await expect(
        verifyCallbackSignature({ ...input, signature, now }),
      ).resolves.toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('时间窗外的请求判为重放（stale_timestamp），窗口内放行', async () => {
    const timestamp = '1730000000'
    const body = '{}'
    const signature = await signCallback({
      secret: SECRET,
      timestamp,
      executionId: 'exec-1',
      jobId: 'job-1',
      body,
    })
    const base = { secret: SECRET, timestamp, executionId: 'exec-1', jobId: 'job-1', body, signature }
    const toleranceMs = CALLBACK_TIMESTAMP_TOLERANCE_SECONDS * 1000

    // 正好在窗内（含边界）→ 通过。
    await expect(
      verifyCallbackSignature({ ...base, now: Number(timestamp) * 1000 + toleranceMs }),
    ).resolves.toEqual({ ok: true })

    // 晚 1 秒 → 重放。
    await expect(
      verifyCallbackSignature({ ...base, now: Number(timestamp) * 1000 + toleranceMs + 1000 }),
    ).resolves.toEqual({ ok: false, reason: 'stale_timestamp' })

    // 早于时间窗（时钟漂移到未来同样算过期，双向夹住）。
    await expect(
      verifyCallbackSignature({ ...base, now: Number(timestamp) * 1000 - toleranceMs - 1000 }),
    ).resolves.toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('缺签名 / 格式非法 / 缺被签字段分别报对应原因', async () => {
    const base = {
      secret: SECRET,
      timestamp: '1730000000',
      executionId: 'exec-1',
      jobId: 'job-1',
      body: '{}',
      now: 1730000000_000,
    }

    await expect(verifyCallbackSignature({ ...base, signature: '' })).resolves.toEqual({
      ok: false,
      reason: 'missing_signature',
    })
    await expect(verifyCallbackSignature({ ...base, signature: 'abc123' })).resolves.toEqual({
      ok: false,
      reason: 'malformed_signature',
    })
    await expect(verifyCallbackSignature({ ...base, signature: 'v2=xyz' })).resolves.toEqual({
      ok: false,
      reason: 'malformed_signature',
    })
    await expect(
      verifyCallbackSignature({ ...base, executionId: '', signature: 'v2=00' }),
    ).resolves.toEqual({ ok: false, reason: 'missing_signed_field' })
  })

  it('规范串逐字节固定（timestamp\\nexecutionId\\njobId\\nbody）', () => {
    expect(
      buildSignaturePayload({
        timestamp: '1730000000',
        executionId: 'e1',
        jobId: 'j1',
        body: '{"x":1}',
      }),
    ).toBe('1730000000\ne1\nj1\n{"x":1}')
  })

  it('签名头常量冻结（下游按这些名字取值）', () => {
    expect(CALLBACK_HEADERS).toEqual({
      timestamp: 'X-Waker-Timestamp',
      executionId: 'X-Waker-Execution-Id',
      jobId: 'X-Waker-Job-Id',
      projectId: 'X-Waker-Project-Id',
      attempt: 'X-Waker-Attempt',
      signature: 'X-Waker-Signature',
      protocolVersion: 'X-Waker-Protocol-Version',
    })
    expect(CALLBACK_PROTOCOL_VERSION).toBe(2)
    expect(CALLBACK_PATH).toBe('/_waker/execute')
    expect(CALLBACK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300)
    expect(MAX_SELF_RENEWAL_HORIZON_MS).toBe(366 * 24 * 60 * 60 * 1000)
  })

  it('hex 编解码往返，非法 hex 返回 null', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255])
    expect(bytesToHex(bytes)).toBe('00010f10ff')
    expect(hexToBytes('00010f10ff')).toEqual(bytes)
    expect(hexToBytes('abc')).toBeNull()
    expect(hexToBytes('zz')).toBeNull()
    expect(hexToBytes('')).toBeNull()
  })

  it('密钥句柄缓存清空后签名结果不变（只是丢弃缓存）', async () => {
    const input = {
      secret: SECRET,
      timestamp: '1730000000',
      executionId: 'exec-1',
      jobId: 'job-1',
      body: '{}',
    }
    const first = await signCallback(input)
    resetSignatureKeyCache()
    const second = await signCallback(input)
    expect(second).toBe(first)
  })
})

describe('回调投递 · 响应解析与地址规范化', () => {
  it('nextRunAt 只接受数字 / ISO 字符串，其余视为未声明', () => {
    expect(extractNextRunAt({ nextRunAt: 1730000000000 })).toBe(1730000000000)
    expect(extractNextRunAt({ nextRunAt: '2030-01-01T00:00:00Z' })).toBe('2030-01-01T00:00:00Z')
    expect(extractNextRunAt({ nextRunAt: null })).toBeNull()
    expect(extractNextRunAt({})).toBeNull()
    expect(extractNextRunAt({ nextRunAt: true })).toBeNull()
    expect(extractNextRunAt({ nextRunAt: Number.NaN })).toBeNull()
    expect(extractNextRunAt({ nextRunAt: '   ' })).toBeNull()
    expect(extractNextRunAt('not-an-object')).toBeNull()
    expect(extractNextRunAt(null)).toBeNull()
  })

  it('callback_url 规范化：自动拼 /_waker/execute，重复拼接幂等', () => {
    expect(resolveCallbackUrl('https://a.example.com')).toBe('https://a.example.com/_waker/execute')
    expect(resolveCallbackUrl('https://a.example.com/')).toBe('https://a.example.com/_waker/execute')
    expect(resolveCallbackUrl(' https://a.example.com// ')).toBe('https://a.example.com/_waker/execute')
    expect(resolveCallbackUrl('https://a.example.com/_waker/execute')).toBe(
      'https://a.example.com/_waker/execute',
    )
  })
})

describe('Queue 退避折算', () => {
  it('重试等待按 backoff * 2^(失败次数-1) 指数增长并夹到 24h', () => {
    expect(retryDelaySeconds(0, 0)).toBe(0)
    expect(retryDelaySeconds(1, 0)).toBe(1)
    expect(retryDelaySeconds(1, 1)).toBe(2)
    expect(retryDelaySeconds(1, 3)).toBe(8)
    expect(retryDelaySeconds(30, 5)).toBe(960)
    expect(retryDelaySeconds(3600, 5)).toBe(MAX_QUEUE_DELAY_SECONDS)
    expect(retryDelaySeconds(86_400, 0)).toBe(MAX_QUEUE_DELAY_SECONDS)
    // 极端入参不溢出、不返回负数。
    expect(retryDelaySeconds(86_400, 100)).toBe(MAX_QUEUE_DELAY_SECONDS)
    expect(retryDelaySeconds(-5, 2)).toBe(0)
  })

  it('delaySeconds = ceil((dispatchAt - now)/1000)，过去的时间夹到 0', () => {
    expect(queueDelaySeconds(1_000_000, 1_000_000)).toBe(0)
    expect(queueDelaySeconds(1_000_500, 1_000_000)).toBe(1)
    expect(queueDelaySeconds(1_000_001, 1_000_000)).toBe(1)
    expect(queueDelaySeconds(999_000, 1_000_000)).toBe(0)
    expect(queueDelaySeconds(1_000_000 + MAX_QUEUE_DELAY_SECONDS * 1000 * 2, 1_000_000)).toBe(
      MAX_QUEUE_DELAY_SECONDS,
    )
    expect(queueDelaySeconds(Number.NaN, 1_000_000)).toBe(0)
  })
})
