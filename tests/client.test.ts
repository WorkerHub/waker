import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import * as platformProtocol from '../src/callback/protocol'
import { buildCallbackBody } from '../src/callback/client'
import { signCallback } from '../src/callback/sign'
import * as sdk from '../client/src/index'

/**
 * B5 SDK 单测：**契约对齐 + 验签 + 幂等 + 可选接入**。
 *
 * 这里不 mock 平台：签名用平台实现签、SDK 验；反过来 SDK 相关断言也直接对着平台的
 * 冻结常量比对。任何一边改了契约另一边没跟上，这个文件会先红。
 */

const SECRET = 'client-test-signing-secret-placeholder'
const OTHER_SECRET = 'client-test-other-secret-placeholder'

/** 用平台实现组一次真实回调请求（签名、头、请求体都走 B3 的代码）。 */
async function signedCallback(options: {
  secret?: string
  timestamp?: string
  jobName?: string
  payload?: sdk.JsonValue
  nextRunAtOverride?: number
  executionId?: string
  jobId?: string
  nowSeconds?: number
}): Promise<{ bodyText: string; headers: Record<string, string>; body: sdk.CallbackRequestBody }> {
  const executionId = options.executionId ?? crypto.randomUUID()
  const jobId = options.jobId ?? 'job-1'
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))

  const body = buildCallbackBody({
    executionId,
    jobId,
    projectId: 'proj-1',
    jobName: options.jobName ?? 'daily-cleanup',
    kind: 'cron',
    trigger: 'schedule',
    misfire: false,
    attempt: 0,
    scheduledFor: Date.now(),
    dispatchedAt: Date.now(),
    timeoutSeconds: 30,
    payload: options.payload ?? { hello: 'world' },
  })
  const bodyText = JSON.stringify(body)
  const signature = await signCallback({
    secret: options.secret ?? SECRET,
    timestamp,
    executionId,
    jobId,
    body: bodyText,
  })

  return {
    bodyText,
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [sdk.CALLBACK_HEADERS.timestamp]: timestamp,
      [sdk.CALLBACK_HEADERS.executionId]: executionId,
      [sdk.CALLBACK_HEADERS.jobId]: jobId,
      [sdk.CALLBACK_HEADERS.projectId]: 'proj-1',
      [sdk.CALLBACK_HEADERS.attempt]: '0',
      [sdk.CALLBACK_HEADERS.signature]: signature,
      [sdk.CALLBACK_HEADERS.protocolVersion]: '2',
    },
  }
}

/** 直接打 receiver 子应用：子应用里注册的是 `/execute`（挂载到 `/_waker` 后才是完整路径）。 */
function postCallback(
  app: Hono<{ Bindings: Record<string, unknown> }>,
  request: { bodyText: string; headers: Record<string, string> },
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://downstream.test/execute`, {
        method: 'POST',
        headers: request.headers,
        body: request.bodyText,
      }),
      { WAKER_SIGNING_KEY: SECRET },
    ),
  )
}

describe('契约对齐（与平台 src/callback/protocol.ts 逐项比对）', () => {
  it('协议版本 / 路径 / 前缀 / 时间窗 / 自续上限一致', () => {
    expect(sdk.CALLBACK_PROTOCOL_VERSION).toBe(platformProtocol.CALLBACK_PROTOCOL_VERSION)
    expect(sdk.CALLBACK_PATH).toBe(platformProtocol.CALLBACK_PATH)
    expect(`${sdk.CALLBACK_MOUNT_PATH}/execute`).toBe(platformProtocol.CALLBACK_PATH)
    expect(sdk.CALLBACK_SIGNATURE_PREFIX).toBe(platformProtocol.CALLBACK_SIGNATURE_PREFIX)
    expect(sdk.CALLBACK_SIGNATURE_ALGORITHM).toBe(platformProtocol.CALLBACK_SIGNATURE_ALGORITHM)
    expect(sdk.CALLBACK_TIMESTAMP_TOLERANCE_SECONDS).toBe(
      platformProtocol.CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
    )
    expect(sdk.MAX_SELF_RENEWAL_HORIZON_MS).toBe(platformProtocol.MAX_SELF_RENEWAL_HORIZON_MS)
  })

  it('签名头名逐字一致（含大小写）', () => {
    expect(sdk.CALLBACK_HEADERS).toEqual(platformProtocol.CALLBACK_HEADERS)
  })

  it('签名规范串逐字节一致', () => {
    const input = {
      timestamp: '1730000000',
      executionId: 'exec-1',
      jobId: 'job-1',
      body: '{"protocolVersion":2}',
    }
    expect(sdk.buildSignaturePayload(input)).toBe(platformProtocol.buildSignaturePayload(input))
  })

  it('回调地址规范化一致', () => {
    for (const base of [
      'https://enotify.example.com',
      'https://enotify.example.com/',
      'https://enotify.example.com/_waker/execute',
    ]) {
      expect(sdk.resolveCallbackUrl(base)).toBe(platformProtocol.resolveCallbackUrl(base))
    }
  })
})

describe('HMAC 验签', () => {
  it('平台签名的回调，SDK 验签通过', async () => {
    const request = await signedCallback({})
    const result = await sdk.verifyWakerSignature({
      secret: SECRET,
      signature: request.headers[sdk.CALLBACK_HEADERS.signature] ?? '',
      timestamp: request.headers[sdk.CALLBACK_HEADERS.timestamp] ?? '',
      executionId: request.body.executionId,
      jobId: request.body.jobId,
      body: request.bodyText,
    })
    expect(result).toEqual({ ok: true })
  })

  it('换了 secret 必须失败', async () => {
    const request = await signedCallback({})
    const result = await sdk.verifyWakerSignature({
      secret: OTHER_SECRET,
      signature: request.headers[sdk.CALLBACK_HEADERS.signature] ?? '',
      timestamp: request.headers[sdk.CALLBACK_HEADERS.timestamp] ?? '',
      executionId: request.body.executionId,
      jobId: request.body.jobId,
      body: request.bodyText,
    })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('body 被改动必须失败（原始 body 参与签名）', async () => {
    const request = await signedCallback({})
    const result = await sdk.verifyWakerSignature({
      secret: SECRET,
      signature: request.headers[sdk.CALLBACK_HEADERS.signature] ?? '',
      timestamp: request.headers[sdk.CALLBACK_HEADERS.timestamp] ?? '',
      executionId: request.body.executionId,
      jobId: request.body.jobId,
      body: request.bodyText.replace('world', 'tampered'),
    })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('超过 5 分钟时间窗必须拒收（防重放）', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - sdk.CALLBACK_TIMESTAMP_TOLERANCE_SECONDS - 10)
    const request = await signedCallback({ timestamp: stale })
    const result = await sdk.verifyWakerSignature({
      secret: SECRET,
      signature: request.headers[sdk.CALLBACK_HEADERS.signature] ?? '',
      timestamp: stale,
      executionId: request.body.executionId,
      jobId: request.body.jobId,
      body: request.bodyText,
    })
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('签名格式不对 / 缺字段分别给出原因', async () => {
    const request = await signedCallback({})
    const base = {
      secret: SECRET,
      timestamp: request.headers[sdk.CALLBACK_HEADERS.timestamp] ?? '',
      executionId: request.body.executionId,
      jobId: request.body.jobId,
      body: request.bodyText,
    }
    expect(await sdk.verifyWakerSignature({ ...base, signature: '' })).toEqual({
      ok: false,
      reason: 'missing_signature',
    })
    expect(await sdk.verifyWakerSignature({ ...base, signature: 'v1=abcd' })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    })
    expect(
      await sdk.verifyWakerSignature({ ...base, signature: 'v2=zz', executionId: '' }),
    ).toEqual({ ok: false, reason: 'missing_signed_field' })
  })
})

describe('receiver', () => {
  it('验签通过 → 跑 handler → 2xx，并把 nextRunAt 透传', async () => {
    const received: sdk.WakerJobContext[] = []
    const nextRunAt = Date.now() + 60_000
    const receiver = sdk.createWakerReceiver({
      jobs: {
        'reminder-tick-1': async (context) => {
          received.push(context)
          return { nextRunAt, delivered: true }
        },
      },
    })
    const request = await signedCallback({ jobName: 'reminder-tick-1', payload: { letterId: 'L1' } })
    const response = await postCallback(receiver, request)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, nextRunAt, delivered: true })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      jobName: 'reminder-tick-1',
      executionId: request.body.executionId,
      jobId: 'job-1',
      payload: { letterId: 'L1' },
      attempt: 0,
    })
  })

  it('验签失败 / 时间窗过期 → 401；任务名未声明 → 404', async () => {
    const receiver = sdk.createWakerReceiver({ jobs: { 'daily-cleanup': async () => ({}) } })

    const wrongSecret = await signedCallback({ secret: OTHER_SECRET })
    expect((await postCallback(receiver, wrongSecret)).status).toBe(401)

    const stale = String(Math.floor(Date.now() / 1000) - 3600)
    const staleRequest = await signedCallback({ timestamp: stale })
    expect((await postCallback(receiver, staleRequest)).status).toBe(401)

    const unknown = await signedCallback({ jobName: 'nobody-declared-this' })
    const unknownResponse = await postCallback(receiver, unknown)
    expect(unknownResponse.status).toBe(404)
    expect(await unknownResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'unknown_job' },
    })
  })

  it('缺签名头 → 400；协议版本不对 → 400', async () => {
    const receiver = sdk.createWakerReceiver({ jobs: { 'daily-cleanup': async () => ({}) } })

    const missing = await signedCallback({})
    const headers = { ...missing.headers }
    delete headers[sdk.CALLBACK_HEADERS.signature]
    const missingResponse = await receiver.fetch(
      new Request(`http://downstream.test/execute`, {
        method: 'POST',
        headers,
        body: missing.bodyText,
      }),
      { WAKER_SIGNING_KEY: SECRET },
    )
    expect(missingResponse.status).toBe(400)

    const wrongVersion = await signedCallback({})
    const body = { ...wrongVersion.body, protocolVersion: 1 }
    const bodyText = JSON.stringify(body)
    const timestamp = wrongVersion.headers[sdk.CALLBACK_HEADERS.timestamp] ?? ''
    const signature = await signCallback({
      secret: SECRET,
      timestamp,
      executionId: wrongVersion.body.executionId,
      jobId: wrongVersion.body.jobId,
      body: bodyText,
    })
    const versionResponse = await receiver.fetch(
      new Request(`http://downstream.test/execute`, {
        method: 'POST',
        headers: { ...wrongVersion.headers, [sdk.CALLBACK_HEADERS.signature]: signature },
        body: bodyText,
      }),
      { WAKER_SIGNING_KEY: SECRET },
    )
    expect(versionResponse.status).toBe(400)
    expect(await versionResponse.json()).toMatchObject({
      error: { code: 'unsupported_protocol' },
    })
  })

  it('没有 signing key 时 fail closed（500，绝不静默放行）', async () => {
    const receiver = sdk.createWakerReceiver({ jobs: { 'daily-cleanup': async () => ({}) } })
    const request = await signedCallback({})
    const response = await receiver.fetch(
      new Request(`http://downstream.test/execute`, {
        method: 'POST',
        headers: request.headers,
        body: request.bodyText,
      }),
      {},
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'signing_key_missing' } })
  })

  it('同一 executionId 重复投递只跑一次，并回放首次的 nextRunAt', async () => {
    let calls = 0
    const nextRunAt = Date.now() + 30_000
    const receiver = sdk.createWakerReceiver({
      jobs: {
        'daily-cleanup': async () => {
          calls += 1
          return { nextRunAt }
        },
      },
      ledger: sdk.createMemoryExecutionLedger(),
    })

    const request = await signedCallback({})
    const first = await postCallback(receiver, request)
    const second = await postCallback(receiver, request)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(calls).toBe(1)
    expect(await second.json()).toEqual({ ok: true, nextRunAt, duplicate: true })
  })

  it('业务失败释放占位：平台的同 executionId 重试会真的重跑', async () => {
    let calls = 0
    const receiver = sdk.createWakerReceiver({
      jobs: {
        'daily-cleanup': async () => {
          calls += 1
          if (calls === 1) throw new Error('业务第一次失败')
          return { recovered: true }
        },
      },
      ledger: sdk.createMemoryExecutionLedger(),
    })

    const request = await signedCallback({})
    const first = await postCallback(receiver, request)
    expect(first.status).toBe(500)
    expect(await first.json()).toMatchObject({ error: { code: 'job_failed' } })

    const retry = await postCallback(receiver, request)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ok: true, recovered: true })
    expect(calls).toBe(2)
  })

  it('`jobs` 支持解析函数（one-shot 名字按业务 id 动态生成）', async () => {
    const seen: string[] = []
    const receiver = sdk.createWakerReceiver({
      jobs: (jobName) => {
        if (!jobName.startsWith('letter-')) return null
        return async (context) => {
          seen.push(context.jobName)
          return {}
        }
      },
    })

    const request = await signedCallback({ jobName: 'letter-42' })
    const response = await postCallback(receiver, request)
    expect(response.status).toBe(200)
    expect(seen).toEqual(['letter-42'])
  })
})

describe('可选接入（双模式）', () => {
  function appWithSdk(env: Record<string, unknown>): { app: Hono<{ Bindings: Record<string, unknown> }>; mounted: boolean } {
    const app = new Hono<{ Bindings: Record<string, unknown> }>()
    app.get('/healthz', (c) => c.json({ ok: true }))
    const mounted = sdk.mountWakerReceiver(app, {
      env,
      jobs: { 'daily-cleanup': async () => ({}) },
    })
    return { app, mounted }
  }

  it('WAKER_MODE 缺省 / 未知取值 → cron 模式：不挂载 receiver，其它路由照常', async () => {
    for (const env of [{}, { WAKER_MODE: 'cron' }, { WAKER_MODE: 'typo-mode' }]) {
      const { app, mounted } = appWithSdk(env)
      expect(mounted).toBe(false)
      expect(sdk.resolveWakerMode(env)).toBe('cron')
      expect(sdk.isWakerEnabled(env)).toBe(false)

      const health = await app.fetch(new Request('http://downstream.test/healthz'), env)
      expect(health.status).toBe(200)

      const callback = await app.fetch(
        new Request(`http://downstream.test${sdk.CALLBACK_PATH}`, { method: 'POST' }),
        env,
      )
      expect(callback.status).toBe(404)
    }
  })

  it('WAKER_MODE=waker → 挂载 receiver，缺 signing key 时启动期 fail fast', async () => {
    const { app, mounted } = appWithSdk({ WAKER_MODE: 'waker', WAKER_SIGNING_KEY: SECRET })
    expect(mounted).toBe(true)
    expect(sdk.isWakerEnabled({ WAKER_MODE: 'waker' })).toBe(true)

    const request = await signedCallback({})
    const response = await app.fetch(
      new Request(`http://downstream.test${sdk.CALLBACK_PATH}`, {
        method: 'POST',
        headers: request.headers,
        body: request.bodyText,
      }),
      { WAKER_MODE: 'waker', WAKER_SIGNING_KEY: SECRET },
    )
    expect(response.status).toBe(200)

    expect(() => appWithSdk({ WAKER_MODE: 'waker' })).toThrow(/signing key/)
  })

  it('注册客户端：原生模式返回 null（不构造、不发请求）', () => {
    expect(sdk.createWakerClientFromEnv({})).toBeNull()
    expect(sdk.createWakerClientFromEnv({ WAKER_MODE: 'cron', WAKER_URL: 'x', WAKER_TOKEN: 'y' })).toBeNull()
    expect(sdk.createWakerClientFromEnv({ WAKER_MODE: 'waker' })).toBeNull()
    expect(() =>
      sdk.createWakerClientFromEnv({ WAKER_MODE: 'waker' }, { required: true }),
    ).toThrow(/WAKER_URL/)
    expect(
      sdk.createWakerClientFromEnv({
        WAKER_MODE: 'waker',
        WAKER_URL: 'https://waker.test',
        WAKER_TOKEN: 'token',
      }),
    ).not.toBeNull()
  })
})

describe('幂等账本', () => {
  it('claim / complete / release 语义（内存实现）', async () => {
    const ledger = sdk.createMemoryExecutionLedger()
    const input = { executionId: 'e1', jobId: 'j1', jobName: 'daily-cleanup', scheduledFor: 1 }

    expect(await ledger.claim(input)).toMatchObject({ claimed: true })
    expect((await ledger.claim(input)).claimed).toBe(false)

    await ledger.complete('e1', { ok: true, nextRunAt: 123 })
    const hit = await ledger.claim(input)
    expect(hit.claimed).toBe(false)
    expect(hit.existing?.status).toBe('succeeded')
    expect(hit.existing?.response).toEqual({ ok: true, nextRunAt: 123 })

    const failing = sdk.createMemoryExecutionLedger()
    await failing.claim({ ...input, executionId: 'e2' })
    await failing.release('e2')
    expect((await failing.claim({ ...input, executionId: 'e2' })).claimed).toBe(true)
  })

  it('过期占位允许接管（上次执行崩溃不会永久占坑）', async () => {
    let now = 1_000_000
    const ledger = sdk.createMemoryExecutionLedger({ now: () => now, staleClaimSeconds: 60 })
    const input = { executionId: 'e1', jobId: 'j1', jobName: 'daily-cleanup', scheduledFor: 1 }

    expect((await ledger.claim(input)).claimed).toBe(true)
    now += 61_000
    expect((await ledger.claim(input)).claimed).toBe(true)
  })

  it('DDL 里带着幂等表的关键列（下游 D1 迁移用）', () => {
    const ddl = sdk.executionLedgerDdl()
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS waker_executions')
    expect(ddl).toContain('execution_id TEXT PRIMARY KEY')
    expect(ddl).toContain('response_json')
  })
})
