import { Hono } from 'hono'

import type { EmailProvider, ResendConfigInput, SmtpConfigInput } from '../do/auth-types'
import { getApiStub } from '../do/http-rpc'
import { isValidEmail, sendEmailWithConfig, testEmailMessage } from '../email/send'
import { currentUser, requireAdmin, sessionAuth, type ApiEnv } from './auth'
import { jsonError, readJson, respond } from './errors'

/**
 * 系统管理面（仅 admin）：用户管理 + 注册开关 + 邮件服务配置（SPEC §4.3 / §6.1）。
 *
 *   GET    /api/users                            → { users }
 *   PATCH  /api/users/:userId   {role?, isActive?}
 *   DELETE /api/users/:userId
 *   GET    /api/system/settings                  → { registrationEnabled, email:{provider,smtp,resend} }
 *   PUT    /api/system/settings/registration {enabled}
 *   PUT    /api/system/settings/email {provider, smtp?, resend?}
 *   POST   /api/system/settings/email/test {to}  → { sent:true }
 *
 * 两个 router 分别挂在 `/api/users` 与 `/api/system/settings` 上：**中间件必须只作用于自己的前缀**，
 * 否则 `use('*')` 会把 `/api` 下的全部路径（含公开登录路由）都吃掉。
 *
 * 敏感值（SMTP 密码 / Resend API Key）**永不回显**：视图只报 `passwordConfigured` /
 * `apiKeyConfigured`，入参留空表示不改。
 */
export const usersRoutes = new Hono<ApiEnv>()

usersRoutes.use('*', sessionAuth())
usersRoutes.use('*', requireAdmin())

// ───────────────────────── 用户管理 ─────────────────────────

usersRoutes.get('/', async (c) => {
  return respond(c, await getApiStub(c.env).authListUsers(), (value) => value)
})

usersRoutes.patch('/:userId', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const role = body.role
  if (role !== undefined && role !== 'admin' && role !== 'viewer') {
    return jsonError(c, 'invalid_argument', "role 只能是 'admin' 或 'viewer'")
  }
  const isActive = body.isActive
  if (isActive !== undefined && typeof isActive !== 'boolean') {
    return jsonError(c, 'invalid_argument', 'isActive 必须是布尔值')
  }

  return respond(
    c,
    await getApiStub(c.env).authUpdateUser({
      actorId: currentUser(c).id,
      userId: c.req.param('userId'),
      ...(role === undefined ? {} : { role }),
      ...(isActive === undefined ? {} : { isActive }),
    }),
    (user) => ({ user }),
  )
})

usersRoutes.delete('/:userId', async (c) => {
  return respond(
    c,
    await getApiStub(c.env).authDeleteUser({
      actorId: currentUser(c).id,
      userId: c.req.param('userId'),
    }),
    () => ({ success: true }),
  )
})

// ───────────────────────── 系统设置：注册开关 ─────────────────────────

export const systemSettingsRoutes = new Hono<ApiEnv>()

systemSettingsRoutes.use('*', sessionAuth())
systemSettingsRoutes.use('*', requireAdmin())

systemSettingsRoutes.get('/', async (c) => {
  return respond(c, await getApiStub(c.env).authGetSystemSettings(), (value) => value)
})

systemSettingsRoutes.put('/registration', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>
  if (typeof body.enabled !== 'boolean') {
    return jsonError(c, 'invalid_argument', 'enabled 必须是布尔值')
  }

  return respond(
    c,
    await getApiStub(c.env).authSetRegistrationEnabled({
      actorId: currentUser(c).id,
      enabled: body.enabled,
    }),
    (value) => value,
  )
})

// ───────────────────────── 系统设置：邮件服务 ─────────────────────────

systemSettingsRoutes.put('/email', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  const provider = body.provider
  if (provider !== 'none' && provider !== 'smtp' && provider !== 'resend') {
    return jsonError(c, 'invalid_argument', "provider 只能是 'none' / 'smtp' / 'resend'")
  }

  const smtp = body.smtp as SmtpConfigInput | undefined
  const resend = body.resend as ResendConfigInput | undefined

  return respond(
    c,
    await getApiStub(c.env).authUpdateEmailSettings({
      actorId: currentUser(c).id,
      settings: {
        provider: provider as EmailProvider,
        ...(smtp === undefined ? {} : { smtp }),
        ...(resend === undefined ? {} : { resend }),
      },
    }),
    (value) => value,
  )
})

/** 发送测试邮件：验证配置可用；失败明确回 `email_send_failed`（不假装发成功）。 */
systemSettingsRoutes.post('/email/test', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  const body = (parsed.value ?? {}) as Record<string, unknown>

  // 收件地址缺省发给当前管理员本人（更方便，也少一个任意收件人入口）。
  const to = typeof body.to === 'string' && body.to.length > 0 ? body.to : currentUser(c).email
  if (!isValidEmail(to)) return jsonError(c, 'invalid_argument', '收件地址不合法')

  const stub = getApiStub(c.env)
  const config = await stub.authGetEmailSendConfig()
  if (!config.ok) return jsonError(c, config.error.code, config.error.message, config.error.details)
  if (config.value.provider === 'none') {
    return jsonError(c, 'email_not_configured', '尚未配置邮件服务，请先选择 SMTP 或 Resend')
  }

  const sent = await sendEmailWithConfig(config.value, testEmailMessage(to))
  if (!sent.ok) return jsonError(c, 'email_send_failed', sent.error ?? '邮件发送失败')
  return c.json({ sent: true })
})
