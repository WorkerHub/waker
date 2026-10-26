import { Hono } from 'hono'

import { issueSession, issueTwoFactorToken, verifyTwoFactorToken } from '../auth/session'
import type { UserView } from '../do/auth-types'
import { getApiStub } from '../do/http-rpc'
import { otpEmailMessage, sendEmailWithConfig } from '../email/send'
import { clientIp, requestOrigin, type ApiEnv } from './auth'
import { jsonError, readJson, respond } from './errors'

/**
 * 公开鉴权面（无需会话）：初始化 / 注册 / 两步登录。
 *
 * 契约（ONE-462 冻结，前端按此对接）：
 *
 *   GET  /api/setup/state                  → { schemaVersion, initialized, adminExists, registrationEnabled, emailProvider }
 *   POST /api/setup            {setupSecret}                → { schemaVersion, adminExists:false, bootstrapToken, expiresAt }
 *   POST /api/setup/admin      {bootstrapToken,email,password,displayName} → { user, session }
 *   POST /api/auth/setup       {setupSecret}                → 首个管理员存在后 403 already_initialized
 *   POST /api/auth/register    {email,password,displayName} → { user, session }
 *   POST /api/auth/login       {email,password}             → { requiresTwoFactor:false, user, session }
 *                                                          |  { requiresTwoFactor:true, user, methods, tempToken, expiresAt }
 *   POST /api/auth/2fa/verify  {tempToken,method,code}      → { user, session }   （method=totp|email_otp）
 *   POST /api/auth/2fa/otp/send {tempToken}                 → { sent:true, expiresAt }
 *   POST /api/auth/2fa/passkey/options {tempToken}          → WebAuthn PublicKeyCredentialRequestOptions
 *   POST /api/auth/2fa/passkey/verify  {tempToken,response} → { user, session }
 *
 * 所有失败都是冻结错误体 `{ error: { code, message, details? } }`（`api/errors.ts` 映射状态码）。
 */
export const authRoutes = new Hono<ApiEnv>()

/** 初始化状态（公开：前端据此决定显示 setup 页还是登录页）。 */
authRoutes.get('/setup/state', async (c) => {
  return respond(c, await getApiStub(c.env).authSetupState(), (value) => value)
})

/** 初始化第 1 步：校验 SETUP_SECRET，拿一次性 bootstrap 令牌（≤10 分钟）。 */
authRoutes.post('/setup', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const result = await getApiStub(c.env).authBeginSetup({
    setupSecret: body.setupSecret,
    ip: clientIp(c),
  })
  return respond(c, result, (value) => value)
})

/** 初始化第 2 步：凭 bootstrap 令牌创建首个管理员（成功后立即可用会话）。 */
authRoutes.post('/setup/admin', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const result = await getApiStub(c.env).authCreateFirstAdmin({
    bootstrapToken: body.bootstrapToken,
    email: body.email,
    password: body.password,
    displayName: body.displayName,
  })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)

  const session = await issueSession(c.env, { userId: result.value.id, role: result.value.role })
  return c.json({ user: result.value, session }, 201)
})

/**
 * 旧入口 `POST /api/auth/setup`：SPEC §3.2 要求首个管理员建成后**一律 403**。
 *
 * 之前它用 SETUP_SECRET 换 `sub:'owner'` 的 12 小时会话（后门路径），已随本单删除；
 * 未初始化时它退化成 `POST /api/setup` 的别名（同样的 bootstrap 令牌语义），
 * 让「存量页面还在调用旧路径」的用户至少拿到明确下一步，而不是 404/500。
 */
authRoutes.post('/auth/setup', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const result = await getApiStub(c.env).authBeginSetup({
    setupSecret: body.setupSecret,
    ip: clientIp(c),
  })
  return respond(c, result, (value) => value)
})

/** 注册：开关打开时注册即登录（viewer）；首个管理员存在前走初始化流程。 */
authRoutes.post('/auth/register', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const result = await getApiStub(c.env).authRegister({
    email: body.email,
    password: body.password,
    displayName: body.displayName,
    ip: clientIp(c),
  })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)

  const session = await issueSession(c.env, { userId: result.value.id, role: result.value.role })
  return c.json({ user: result.value, session }, 201)
})

/** 登录第 1 步（密码）：无已启用第二因素 → 直接发正式会话。 */
authRoutes.post('/auth/login', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const result = await getApiStub(c.env).authBeginLogin({
    email: body.email,
    password: body.password,
    ip: clientIp(c),
  })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)

  const login = result.value
  if (!login.requiresTwoFactor || login.sessionRef === null) {
    const session = await issueSession(c.env, { userId: login.user.id, role: login.user.role })
    return c.json({ requiresTwoFactor: false, user: login.user, session })
  }

  const temp = await issueTwoFactorToken(c.env, {
    userId: login.user.id,
    sessionRef: login.sessionRef,
  })
  return c.json({
    requiresTwoFactor: true,
    user: login.user,
    methods: login.methods,
    tempToken: temp.token,
    expiresAt: temp.expiresAt,
  })
})

/** 登录第 2 步（TOTP / 邮件 OTP）：通过才发正式会话。 */
authRoutes.post('/auth/2fa/verify', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const tempToken = typeof body.tempToken === 'string' ? body.tempToken : ''
  const claims = await verifyTwoFactorToken(c.env, tempToken)
  if (claims === null) return jsonError(c, 'two_factor_required', '两步登录已超时，请重新登录')

  const method = body.method
  if (method === 'passkey') {
    return jsonError(c, 'invalid_argument', 'Passkey 请走 /api/auth/2fa/passkey/options 与 /verify')
  }
  if (method !== 'totp' && method !== 'email_otp') {
    return jsonError(c, 'invalid_argument', "method 只能是 'totp' / 'email_otp' / 'passkey'")
  }

  const stub = getApiStub(c.env)
  const result =
    method === 'totp'
      ? await stub.authVerifyTotp({ sessionRef: claims.sid, code: body.code })
      : await stub.authVerifyEmailOtp({ sessionRef: claims.sid, code: body.code })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)

  const session = await issueSession(c.env, { userId: result.value.id, role: result.value.role })
  return c.json({ user: result.value, session })
})

/**
 * 发送登录用邮件验证码。
 *
 * 失败关闭（SPEC §6.2）：provider 未配置 → 明确报错且**不生成挑战**；
 * 发送失败 → 撤销刚生成的挑战（`authDiscardChallenge`）再回错，库里不留可用码。
 */
authRoutes.post('/auth/2fa/otp/send', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const tempToken = typeof body.tempToken === 'string' ? body.tempToken : ''
  const claims = await verifyTwoFactorToken(c.env, tempToken)
  if (claims === null) return jsonError(c, 'two_factor_required', '两步登录已超时，请重新登录')

  const stub = getApiStub(c.env)
  const code = await stub.authSendLoginEmailOtp({ sessionRef: claims.sid })
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

/** Passkey 登录：先取 authentication options，再提交断言结果。 */
authRoutes.post('/auth/2fa/passkey/options', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const claims = await verifyTwoFactorToken(
    c.env,
    typeof body.tempToken === 'string' ? body.tempToken : '',
  )
  if (claims === null) return jsonError(c, 'two_factor_required', '两步登录已超时，请重新登录')

  const { rpId } = requestOrigin(c)
  return respond(
    c,
    await getApiStub(c.env).authPasskeyLoginOptions({ sessionRef: claims.sid, rpId }),
    (options) => options,
  )
})

authRoutes.post('/auth/2fa/passkey/verify', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const claims = await verifyTwoFactorToken(
    c.env,
    typeof body.tempToken === 'string' ? body.tempToken : '',
  )
  if (claims === null) return jsonError(c, 'two_factor_required', '两步登录已超时，请重新登录')

  const { rpId, origin } = requestOrigin(c)
  const result = await getApiStub(c.env).authPasskeyLoginVerify({
    sessionRef: claims.sid,
    rpId,
    origin,
    response: body.response,
  })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)

  const session = await issueSession(c.env, { userId: result.value.id, role: result.value.role })
  return c.json({ user: result.value, session })
})

/** 便于测试 / 前端判断：当前用户是否会拿到会话（不放行任何绕过路径，仅形状统一）。 */
export interface SessionResponse {
  user: UserView
  session: { token: string; expiresAt: number }
}
