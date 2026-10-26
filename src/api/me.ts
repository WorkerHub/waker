import { Hono } from 'hono'
import type { Context } from 'hono'

import { getApiStub } from '../do/http-rpc'
import type { TwoFactorMethod } from '../do/auth-types'
import { otpEmailMessage, sendEmailWithConfig } from '../email/send'
import { currentUser, requestOrigin, sessionAuth, type ApiEnv } from './auth'
import { jsonError, readJson, respond } from './errors'

/**
 * 本人设置（SPEC §5.3）—— 「设置」页安全区，**viewer 也能用**（权限矩阵里唯一的写白名单）。
 *
 *   GET    /api/me                              → { user, twoFactor, availableMethods }
 *   PATCH  /api/me                    {displayName}
 *   POST   /api/me/password           {currentPassword,newPassword}       （复验密码）
 *   POST   /api/me/2fa/totp/setup                        → { secret, uri }
 *   POST   /api/me/2fa/totp/enable    {code}
 *   POST   /api/me/2fa/totp/disable   {password}          （复验密码）
 *   POST   /api/me/2fa/email-otp/send                    → { sent:true, expiresAt }
 *   POST   /api/me/2fa/email-otp/enable {code}            （必须先 send-verify）
 *   POST   /api/me/2fa/email-otp/disable {password}       （复验密码）
 *   GET    /api/me/2fa/passkeys                          → { passkeys }
 *   POST   /api/me/2fa/passkey/options                   → WebAuthn 注册 options
 *   POST   /api/me/2fa/passkey/verify {response,name}     → { passkey }
 *   PATCH  /api/me/2fa/passkeys/:credentialId {name}      → { passkeys }
 *   DELETE /api/me/2fa/passkeys/:credentialId {password}  → { passkeys }
 *   PUT    /api/me/2fa/preferred       {method}           → { user, twoFactor, availableMethods }
 */
export const meRoutes = new Hono<ApiEnv>()

meRoutes.use('*', sessionAuth())

meRoutes.get('/', async (c) => {
  return respond(c, await getApiStub(c.env).authGetMe({ userId: currentUser(c).id }), (value) => value)
})

meRoutes.patch('/', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  return respond(
    c,
    await getApiStub(c.env).authUpdateProfile({ userId: currentUser(c).id, displayName: body.displayName }),
    (value) => value,
  )
})

meRoutes.post('/password', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  return respond(
    c,
    await getApiStub(c.env).authChangePassword({
      userId: currentUser(c).id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    }),
    () => ({ success: true }),
  )
})

// ───────────────────────── TOTP ─────────────────────────

meRoutes.post('/2fa/totp/setup', async (c) => {
  return respond(
    c,
    await getApiStub(c.env).authTotpSetupStart({ userId: currentUser(c).id }),
    (value) => value,
  )
})

meRoutes.post('/2fa/totp/enable', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authTotpSetupConfirm({ userId: currentUser(c).id, code: body.code }),
    (value) => value,
  )
})

meRoutes.post('/2fa/totp/disable', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authTotpDisable({ userId: currentUser(c).id, password: body.password }),
    (value) => value,
  )
})

// ───────────────────────── 邮件 OTP ─────────────────────────

/** 启用前必须先发码验码（SPEC §5.3）；provider 未配置时明确报错，绝不静默置位。 */
meRoutes.post('/2fa/email-otp/send', async (c) => {
  const stub = getApiStub(c.env)
  const code = await stub.authEmailOtpSetupSend({ userId: currentUser(c).id })
  if (!code.ok) return jsonError(c, code.error.code, code.error.message, code.error.details)

  const config = await stub.authGetEmailSendConfig()
  if (!config.ok) return jsonError(c, config.error.code, config.error.message, config.error.details)

  const sent = await sendEmailWithConfig(config.value, otpEmailMessage(code.value.email, code.value.code))
  if (!sent.ok) {
    await stub.authDiscardChallenge({ challengeId: code.value.challengeId })
    return jsonError(c, 'email_send_failed', sent.error ?? '邮件发送失败')
  }

  return c.json({ sent: true, expiresAt: code.value.expiresAt })
})

meRoutes.post('/2fa/email-otp/enable', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authEmailOtpEnable({ userId: currentUser(c).id, code: body.code }),
    (value) => value,
  )
})

meRoutes.post('/2fa/email-otp/disable', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authEmailOtpDisable({ userId: currentUser(c).id, password: body.password }),
    (value) => value,
  )
})

// ───────────────────────── Passkey ─────────────────────────

meRoutes.get('/2fa/passkeys', async (c) => {
  return respond(
    c,
    await getApiStub(c.env).authListPasskeys({ userId: currentUser(c).id }),
    (value) => value,
  )
})

meRoutes.post('/2fa/passkey/options', async (c) => {
  const { rpId } = requestOrigin(c)
  return respond(
    c,
    await getApiStub(c.env).authPasskeyRegisterOptions({ userId: currentUser(c).id, rpId }),
    (options) => options,
  )
})

meRoutes.post('/2fa/passkey/verify', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  const { rpId, origin } = requestOrigin(c)

  return respond(
    c,
    await getApiStub(c.env).authPasskeyRegisterVerify({
      userId: currentUser(c).id,
      rpId,
      origin,
      response: body.response,
      name: body.name,
    }),
    (passkey) => ({ passkey }),
    201,
  )
})

meRoutes.patch('/2fa/passkeys/:credentialId', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authRenamePasskey({
      userId: currentUser(c).id,
      credentialId: c.req.param('credentialId'),
      name: body.name,
    }),
    (value) => value,
  )
})

/** 删除 Passkey 是敏感变更：须复验当前密码（SPEC §5.3）。 */
meRoutes.delete('/2fa/passkeys/:credentialId', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  return respond(
    c,
    await getApiStub(c.env).authDeletePasskey({
      userId: currentUser(c).id,
      credentialId: c.req.param('credentialId'),
      password: body.password,
    }),
    (value) => value,
  )
})

meRoutes.put('/2fa/preferred', async (c) => {
  const body = (await bodyOrEmpty(c)) as Record<string, unknown>
  const method = body.method
  if (method !== 'totp' && method !== 'email_otp' && method !== 'passkey') {
    return jsonError(c, 'invalid_argument', "method 只能是 'totp' / 'email_otp' / 'passkey'")
  }
  return respond(
    c,
    await getApiStub(c.env).authSetPreferredMethod({
      userId: currentUser(c).id,
      method: method as TwoFactorMethod,
    }),
    (value) => value,
  )
})

/** 宽容解析可选 body：DELETE / 无 body 的 POST 都当 `{}`。 */
async function bodyOrEmpty(c: Context<ApiEnv>): Promise<unknown> {
  const parsed = await readJson(c)
  if (!parsed.ok) return {}
  return parsed.value ?? {}
}
