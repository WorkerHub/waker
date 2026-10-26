import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { totpCodeAt } from '../src/auth/totp'
import { MIGRATIONS } from '../src/do/schema'
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  bootstrapAdmin,
  http,
  startHarness,
  type TestContext,
} from './support/harness'
import { startFakeSmtp, type FakeSmtp } from './support/fake-smtp'

/**
 * SPEC §8.2–§8.5 验收：注册开关 / 角色矩阵 / 两步登录与 2FA / 邮件子系统 / 迁移与存量。
 *
 * 全部走真 workerd 的 HTTP 入口（真 DO、真 SQLite、真中间件、真 TCP 邮件发送），
 * 断言同时看「HTTP 响应」与「库里的真实形态」（哈希、密文、一次性状态）。
 */

interface ErrorBody {
  error: { code: string; message: string }
}

interface Session {
  token: string
  expiresAt: number
}

interface MeView {
  user: { id: string; email: string; role: string; displayName: string; isActive: boolean }
  twoFactor: {
    totpEnabled: boolean
    emailOtpEnabled: boolean
    passkeyEnabled: boolean
    preferredMethod: string | null
  }
  availableMethods: string[]
}

let ctx: TestContext
let smtp: FakeSmtp
let adminToken: string
let adminId: string

/** 供各 describe 复用的测试账号。 */
const VIEWER = { email: 'viewer@waker.test', password: 'admin-password-123', displayName: '只读同学' }

beforeAll(async () => {
  ctx = await startHarness()
  smtp = await startFakeSmtp()
  adminToken = await bootstrapAdmin(ctx)
  const me = await http<MeView>(ctx, '/api/me', { token: adminToken })
  adminId = me.body.user.id
})

afterAll(async () => {
  await ctx.harness.close()
  await smtp.close()
})

/** 登录限流是「按 IP 10 次/5 分钟」，用例各用各的源 IP，互不影响。 */
let ipSeq = 0
function nextIp(): string {
  ipSeq += 1
  return `10.9.${Math.floor(ipSeq / 200)}.${(ipSeq % 200) + 1}`
}

async function login(email: string, password: string): Promise<{
  status: number
  body: {
    requiresTwoFactor?: boolean
    methods?: string[]
    tempToken?: string
    session?: Session
    user?: { id: string; role: string }
    error?: { code: string }
  }
}> {
  return http(ctx, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
    headers: { 'cf-connecting-ip': nextIp() },
  })
}

async function rowCount(table: string): Promise<number> {
  const rows = await ctx.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

/** 从最近一封邮件里取 6 位验证码（正文由平台模板生成）。 */
function lastEmailCode(): string {
  const message = smtp.messages[smtp.messages.length - 1]
  if (message === undefined) throw new Error('假 SMTP 没有收到任何邮件')
  const match = /<strong>(\d{6})<\/strong>/.exec(message.html)
  if (match === null) throw new Error(`邮件正文里没有验证码：${message.html}`)
  return match[1]!
}

// ───────────────────────── §8.2 / §8.3 注册与角色 ─────────────────────────

describe('注册开关与角色矩阵（SPEC §8.2 / §8.3）', () => {
  it('注册默认关闭 → 403 registration_closed', async () => {
    const response = await http<ErrorBody>(ctx, '/api/auth/register', {
      method: 'POST',
      body: VIEWER,
    })
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('registration_closed')
  })

  it('管理员打开注册开关 → 注册得到 viewer，并当次拿到会话', async () => {
    const updated = await http<{ registrationEnabled: boolean }>(
      ctx,
      '/api/system/settings/registration',
      { method: 'PUT', token: adminToken, body: { enabled: true } },
    )
    expect(updated.status).toBe(200)
    expect(updated.body.registrationEnabled).toBe(true)

    const registered = await http<{ user: { role: string }; session: Session }>(
      ctx,
      '/api/auth/register',
      { method: 'POST', body: VIEWER, headers: { 'cf-connecting-ip': nextIp() } },
    )
    expect(registered.status).toBe(201)
    expect(registered.body.user.role).toBe('viewer')
    expect(registered.body.session.token.split('.')).toHaveLength(3)

    const rows = await ctx.sql.exec(`SELECT password_hash, role FROM users WHERE email = ?`, VIEWER.email)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('viewer')
    // 密码只存 PBKDF2 哈希（salt:hash），绝不落明文
    expect(String(rows[0]!.password_hash)).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/)
    expect(String(rows[0]!.password_hash)).not.toContain(VIEWER.password)
  })

  it('重复注册同一邮箱 → 409 duplicate_email', async () => {
    const response = await http<ErrorBody>(ctx, '/api/auth/register', {
      method: 'POST',
      body: { ...VIEWER, email: VIEWER.email.toUpperCase() },
      headers: { 'cf-connecting-ip': nextIp() },
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('duplicate_email')
  })

  it('viewer：读接口正常，写接口一律 403（接口层强制，不靠前端隐藏）', async () => {
    const viewer = await login(VIEWER.email, VIEWER.password)
    const token = viewer.body.session!.token

    const read = await http(ctx, '/api/projects', { token })
    expect(read.status).toBe(200)

    const write = await http<ErrorBody>(ctx, '/api/projects', {
      method: 'POST',
      token,
      body: { name: 'viewer-项目', callbackUrl: 'https://downstream.example.com' },
    })
    expect(write.status).toBe(403)
    expect(write.body.error.code).toBe('forbidden')

    const users = await http<ErrorBody>(ctx, '/api/users', { token })
    expect(users.status).toBe(403)

    const settings = await http<ErrorBody>(ctx, '/api/system/settings', { token })
    expect(settings.status).toBe(403)

    // 系统状态是只读 GET，viewer 可以看
    const status = await http(ctx, '/api/system/status', { token })
    expect(status.status).toBe(200)
  })

  it('viewer 能改自己的昵称与密码，但改密码必须复验当前密码', async () => {
    const viewer = await login(VIEWER.email, VIEWER.password)
    const token = viewer.body.session!.token

    const renamed = await http<MeView>(ctx, '/api/me', {
      method: 'PATCH',
      token,
      body: { displayName: '只读同学（改名）' },
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body.user.displayName).toBe('只读同学（改名）')

    const missing = await http<ErrorBody>(ctx, '/api/me/password', {
      method: 'POST',
      token,
      body: { newPassword: '{{SECRET_4df5sffn}}' },
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('password_required')

    const wrong = await http<ErrorBody>(ctx, '/api/me/password', {
      method: 'POST',
      token,
      body: { currentPassword: 'wrong-password', newPassword: '{{SECRET_4df5sffn}}' },
    })
    expect(wrong.status).toBe(403)
    expect(wrong.body.error.code).toBe('invalid_password')

    const changed = await http(ctx, '/api/me/password', {
      method: 'POST',
      token,
      body: { currentPassword: VIEWER.password, newPassword: '{{SECRET_4df5sffn}}' },
    })
    expect(changed.status).toBe(200)

    VIEWER.password = '{{SECRET_4df5sffn}}'
    expect((await login(VIEWER.email, VIEWER.password)).status).toBe(200)
  })
})

// ───────────────────────── §8.3 用户管理与防自锁 ─────────────────────────

describe('用户管理与防自锁（SPEC §8.3）', () => {
  it('管理员能列出用户（只回脱敏视图，无密码哈希）', async () => {
    const response = await http<{ users: Array<Record<string, unknown>> }>(ctx, '/api/users', {
      token: adminToken,
    })
    expect(response.status).toBe(200)
    expect(response.body.users.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(response.body)).not.toContain('password')
  })

  it('最后一个 admin 不能自降级 / 自禁用 / 自删除', async () => {
    const demote = await http<ErrorBody>(ctx, `/api/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'viewer' },
    })
    expect(demote.status).toBe(403)
    expect(demote.body.error.code).toBe('forbidden')

    const disable = await http<ErrorBody>(ctx, `/api/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { isActive: false },
    })
    expect(disable.status).toBe(403)

    const remove = await http<ErrorBody>(ctx, `/api/users/${adminId}`, {
      method: 'DELETE',
      token: adminToken,
    })
    expect(remove.status).toBe(403)
  })

  it('有第二个 admin 后可以降级原 admin；再升回来', async () => {
    const viewerId = await userIdOf(VIEWER.email)
    const promoted = await http<{ user: { role: string } }>(ctx, `/api/users/${viewerId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'admin' },
    })
    expect(promoted.status).toBe(200)
    expect(promoted.body.user.role).toBe('admin')

    const demoted = await http<{ user: { role: string } }>(ctx, `/api/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'viewer' },
    })
    expect(demoted.status).toBe(200)
    expect(demoted.body.user.role).toBe('viewer')

    // 用刚升上来的 admin 会话把原管理员升回去（否则后续用例没有 admin 权限）
    const viewerSession = await login(VIEWER.email, VIEWER.password)
    const restored = await http<{ user: { role: string } }>(ctx, `/api/users/${adminId}`, {
      method: 'PATCH',
      token: viewerSession.body.session!.token,
      body: { role: 'admin' },
    })
    expect(restored.status).toBe(200)
    expect(restored.body.user.role).toBe('admin')

    // 把 viewer 降回 viewer，保持后续用例的角色前提
    const reDemoted = await http<{ user: { role: string } }>(ctx, `/api/users/${viewerId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'viewer' },
    })
    expect(reDemoted.body.user.role).toBe('viewer')
  })

  it('被禁用的用户：既有会话立即失效，登录也拒绝（401）', async () => {
    const viewerId = await userIdOf(VIEWER.email)
    const session = await login(VIEWER.email, VIEWER.password)
    const token = session.body.session!.token
    expect((await http(ctx, '/api/me', { token })).status).toBe(200)

    const disabled = await http<{ user: { isActive: boolean } }>(ctx, `/api/users/${viewerId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { isActive: false },
    })
    expect(disabled.status).toBe(200)
    expect(disabled.body.user.isActive).toBe(false)

    const stale = await http<ErrorBody>(ctx, '/api/me', { token })
    expect(stale.status).toBe(401)

    const blocked = await login(VIEWER.email, VIEWER.password)
    expect(blocked.status).toBe(401)
    expect(blocked.body.error!.code).toBe('invalid_credentials')

    // 启回来，后续用例继续用这个账号
    await http(ctx, `/api/users/${viewerId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { isActive: true },
    })
  })

  it('删除用户 → 库里连 2FA 配置一起清掉', async () => {
    const created = await http<{ user: { id: string } }>(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: 'toBeDeleted@waker.test', password: 'admin-password-123', displayName: '待删除' },
      headers: { 'cf-connecting-ip': nextIp() },
    })
    expect(created.status).toBe(201)
    const targetId = created.body.user.id
    expect(await rowCount('user_2fa')).toBeGreaterThan(0)

    const removed = await http(ctx, `/api/users/${targetId}`, { method: 'DELETE', token: adminToken })
    expect(removed.status).toBe(200)

    const rows = await ctx.sql.exec('SELECT id FROM users WHERE id = ?', targetId)
    expect(rows).toHaveLength(0)
    const twoFa = await ctx.sql.exec('SELECT user_id FROM user_2fa WHERE user_id = ?', targetId)
    expect(twoFa).toHaveLength(0)
  })
})

async function userIdOf(email: string): Promise<string> {
  const rows = await ctx.sql.exec('SELECT id FROM users WHERE email = ?', email)
  if (rows[0] === undefined) throw new Error(`用户不存在：${email}`)
  return String(rows[0].id)
}

// ───────────────────────── §8.4 两步登录：TOTP ─────────────────────────

describe('两步登录：TOTP（SPEC §8.4）', () => {
  let secret = ''

  it('绑定 TOTP：setup 给 secret + otpauth URI，输码确认才置位', async () => {
    const setup = await http<{ secret: string; uri: string }>(ctx, '/api/me/2fa/totp/setup', {
      method: 'POST',
      token: adminToken,
    })
    expect(setup.status).toBe(200)
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/)
    expect(setup.body.uri).toContain('otpauth://totp/waker:')
    expect(setup.body.uri).toContain('digits=6')
    secret = setup.body.secret

    // 待确认的 secret 以密文信封落库，明文不落库
    const pending = await ctx.sql.exec(
      `SELECT code_hash FROM auth_challenges WHERE kind = 'totp_setup'`,
    )
    expect(pending).toHaveLength(1)
    const stored = String(pending[0]!.code_hash)
    expect(stored.startsWith('waker-enc:v1:')).toBe(true)
    expect(stored).not.toContain(secret)

    const wrong = await http<ErrorBody>(ctx, '/api/me/2fa/totp/enable', {
      method: 'POST',
      token: adminToken,
      body: { code: '000000' },
    })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('two_factor_invalid')

    const enabled = await http<MeView>(ctx, '/api/me/2fa/totp/enable', {
      method: 'POST',
      token: adminToken,
      body: { code: totpCodeAt(secret, TEST_ADMIN_EMAIL) },
    })
    expect(enabled.status).toBe(200)
    expect(enabled.body.twoFactor.totpEnabled).toBe(true)
    expect(enabled.body.availableMethods).toContain('totp')

    // 落库的 totp_secret 是信封，不是 base32 明文
    const row = await ctx.sql.exec('SELECT totp_secret FROM user_2fa WHERE user_id = ?', adminId)
    const encrypted = String(row[0]!.totp_secret)
    expect(encrypted.startsWith('waker-enc:v1:')).toBe(true)
    expect(encrypted).not.toContain(secret)
  })

  it('启用后密码步只拿到临时令牌（不直接发会话），且方法列表含 totp', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(step.status).toBe(200)
    expect(step.body.requiresTwoFactor).toBe(true)
    expect(step.body.session).toBeUndefined()
    expect(step.body.methods).toContain('totp')
    expect(step.body.tempToken!.split('.')).toHaveLength(3)
  })

  it('临时令牌不能直接当会话用（只能走 2FA 步）', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const response = await http<ErrorBody>(ctx, '/api/projects', { token: step.body.tempToken! })
    expect(response.status).toBe(401)
  })

  it('错码被拒、对码通过；同一枚码不能用第二次（防重放 90s）', async () => {
    const first = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const wrong = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: first.body.tempToken, method: 'totp', code: '000000' },
    })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('two_factor_invalid')

    const code = totpCodeAt(secret, TEST_ADMIN_EMAIL)
    const ok = await http<{ session: Session }>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: first.body.tempToken, method: 'totp', code },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.session.token.split('.')).toHaveLength(3)

    // 重放：新开一次登录，用同一枚码
    const second = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const replay = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: second.body.tempToken, method: 'totp', code },
    })
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe('two_factor_invalid')
  })

  it('连续错 5 次 → 本次 2FA 会话作废（要重新登录）', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    let last: { status: number; body: ErrorBody } | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
        method: 'POST',
        body: { tempToken: step.body.tempToken, method: 'totp', code: '000000' },
      })
    }
    expect(last!.status).toBe(401)
    expect(last!.body.error.message).toContain('次数过多')

    const afterInvalidated = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: step.body.tempToken, method: 'totp', code: totpCodeAt(secret, TEST_ADMIN_EMAIL) },
    })
    expect(afterInvalidated.status).toBe(401)
    expect(afterInvalidated.body.error.code).toBe('two_factor_required')
  })

  it('解绑 TOTP 必须复验密码', async () => {
    const missing = await http<ErrorBody>(ctx, '/api/me/2fa/totp/disable', {
      method: 'POST',
      token: adminToken,
      body: {},
    })
    expect(missing.status).toBe(400)

    const disabled = await http<MeView>(ctx, '/api/me/2fa/totp/disable', {
      method: 'POST',
      token: adminToken,
      body: { password: TEST_ADMIN_PASSWORD },
    })
    expect(disabled.status).toBe(200)
    expect(disabled.body.twoFactor.totpEnabled).toBe(false)

    const row = await ctx.sql.exec('SELECT totp_secret, totp_enabled FROM user_2fa WHERE user_id = ?', adminId)
    expect(row[0]!.totp_secret).toBeNull()
    expect(Number(row[0]!.totp_enabled)).toBe(0)
  })
})

// ───────────────────────── §6 邮件子系统 + §8.4 邮件 OTP ─────────────────────────

describe('邮件子系统与邮件 OTP（SPEC §6 / §8.4）', () => {
  it('provider 未配置：enable 与 otp/send 都被明确挡住（不静默置位、不假装已发送）', async () => {
    const send = await http<ErrorBody>(ctx, '/api/me/2fa/email-otp/send', {
      method: 'POST',
      token: adminToken,
    })
    expect(send.status).toBe(409)
    expect(send.body.error.code).toBe('email_not_configured')

    const enable = await http<ErrorBody>(ctx, '/api/me/2fa/email-otp/enable', {
      method: 'POST',
      token: adminToken,
      body: { code: '123456' },
    })
    expect(enable.status).toBe(409)
    expect(enable.body.error.code).toBe('email_not_configured')

    const me = await http<MeView>(ctx, '/api/me', { token: adminToken })
    expect(me.body.twoFactor.emailOtpEnabled).toBe(false)
  })

  it('管理员配置 SMTP → 发送测试邮件（真 TCP 往返），凭据只以密文落库且不回显', async () => {
    const updated = await http<{
      registrationEnabled: boolean
      email: { provider: string; smtp: Record<string, unknown>; resend: Record<string, unknown> }
    }>(ctx, '/api/system/settings/email', {
      method: 'PUT',
      token: adminToken,
      body: {
        provider: 'smtp',
        smtp: {
          host: smtp.host,
          port: smtp.port,
          from: 'noreply@waker.test',
          fromName: 'waker 测试',
          secure: false,
        },
        resend: { apiKey: '{{SECRET_gdk3kg4h}}', from: 'noreply@waker.test', fromName: 'waker' },
      },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.email.provider).toBe('smtp')
    expect(updated.body.email.smtp.host).toBe(smtp.host)
    expect(updated.body.email.smtp.passwordConfigured).toBe(false)
    expect(updated.body.email.resend.apiKeyConfigured).toBe(true)
    // 敏感值绝不回显
    expect(JSON.stringify(updated.body)).not.toContain('{{SECRET_gdk3kg4h}}')

    const stored = await ctx.sql.exec(`SELECT value FROM waker_meta WHERE key = 'resend_config'`)
    expect(String(stored[0]!.value)).not.toContain('{{SECRET_gdk3kg4h}}')
    expect(String(stored[0]!.value)).toContain('waker-enc:v1:')

    const before = smtp.messages.length
    const tested = await http(ctx, '/api/system/settings/email/test', {
      method: 'POST',
      token: adminToken,
      body: { to: 'ops@waker.test' },
    })
    expect(tested.status, JSON.stringify(tested.body)).toBe(200)
    expect(smtp.messages.length).toBe(before + 1)
    expect(smtp.messages[before]!.to).toBe('ops@waker.test')
  })

  it('邮件 OTP：send-verify 验码通过才启用', async () => {
    const before = smtp.messages.length
    const sent = await http<{ sent: boolean }>(ctx, '/api/me/2fa/email-otp/send', {
      method: 'POST',
      token: adminToken,
    })
    expect(sent.status).toBe(200)
    expect(smtp.messages.length).toBe(before + 1)

    const code = lastEmailCode()
    // 验证码只存哈希：库里搜不到明文
    const rows = await ctx.sql.exec(`SELECT code_hash FROM auth_challenges WHERE kind = 'email_otp'`)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(String(row.code_hash)).not.toContain(code)
      expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/)
    }

    const enabled = await http<MeView>(ctx, '/api/me/2fa/email-otp/enable', {
      method: 'POST',
      token: adminToken,
      body: { code },
    })
    expect(enabled.status).toBe(200)
    expect(enabled.body.twoFactor.emailOtpEnabled).toBe(true)
  })

  it('启用后登录必须过邮件码；验后即消费（重用被拒）', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(step.body.requiresTwoFactor).toBe(true)
    expect(step.body.methods).toContain('email_otp')

    const before = smtp.messages.length
    const sent = await http(ctx, '/api/auth/2fa/otp/send', {
      method: 'POST',
      body: { tempToken: step.body.tempToken },
    })
    expect(sent.status).toBe(200)
    expect(smtp.messages.length).toBe(before + 1)
    const code = lastEmailCode()

    const ok = await http<{ session: Session }>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: step.body.tempToken, method: 'email_otp', code },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.session.token.split('.')).toHaveLength(3)

    // 同一枚码重放（新会话）→ 拒
    const second = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const replay = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: second.body.tempToken, method: 'email_otp', code },
    })
    expect(replay.status).toBe(401)
  })

  it('邮件码 5 分钟过期后拒绝（把 expires_at 回拨验证）', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const sent = await http(ctx, '/api/auth/2fa/otp/send', {
      method: 'POST',
      body: { tempToken: step.body.tempToken },
    })
    expect(sent.status).toBe(200)
    const code = lastEmailCode()

    await ctx.sql.exec(
      `UPDATE auth_challenges SET expires_at = ? WHERE kind = 'email_otp' AND consumed_at IS NULL`,
      Date.now() - 1000,
    )

    const expired = await http<ErrorBody>(ctx, '/api/auth/2fa/verify', {
      method: 'POST',
      body: { tempToken: step.body.tempToken, method: 'email_otp', code },
    })
    expect(expired.status).toBe(401)
    expect(expired.body.error.code).toBe('two_factor_invalid')
  })

  it('otp/send 限流 3 次/5 分钟/会话', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await http(ctx, '/api/auth/2fa/otp/send', {
        method: 'POST',
        body: { tempToken: step.body.tempToken },
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses[3]).toBe(429)
  })
})

// ───────────────────────── Passkey 记账（§8.4） ─────────────────────────

/**
 * 真实的 WebAuthn 断言需要真认证器（QA 用浏览器 + vaultwarden 实测，见 SPEC §8.6）；
 * 这里验平台侧必须正确的部分：凭证脱敏、options 里带上已注册凭证、未知凭证被拒、
 * 删光自动关闭 `passkey_enabled`、偏好回落。
 */
describe('Passkey 记账与偏好（SPEC §8.4）', () => {
  const credentialId = 'cred-test-1'
  const publicKey = btoa('fake-public-key-material')

  it('凭证脱敏返回，注册 options 把它列进 excludeCredentials', async () => {
    await ctx.sql.exec(
      'UPDATE user_2fa SET passkey_credentials = ?, passkey_enabled = 1 WHERE user_id = ?',
      JSON.stringify([{ id: credentialId, publicKey, counter: 0, name: '我的钥匙', createdAt: Date.now() }]),
      adminId,
    )

    const list = await http<{ passkeys: Array<{ id: string; name: string; createdAt: number }> }>(
      ctx,
      '/api/me/2fa/passkeys',
      { token: adminToken },
    )
    expect(list.status).toBe(200)
    expect(list.body.passkeys).toHaveLength(1)
    expect(list.body.passkeys[0]!.id).toBe(credentialId)
    expect(list.body.passkeys[0]!.name).toBe('我的钥匙')
    expect(JSON.stringify(list.body)).not.toContain(publicKey)

    const options = await http<{ challenge: string; excludeCredentials: Array<{ id: string }> }>(
      ctx,
      '/api/me/2fa/passkey/options',
      { method: 'POST', token: adminToken },
    )
    expect(options.status).toBe(200)
    expect(options.body.challenge.length).toBeGreaterThan(0)
    expect(options.body.excludeCredentials.map((item) => item.id)).toContain(credentialId)
  })

  it('登录方法列表含 passkey；authentication options 带 allowCredentials；未知凭证被拒', async () => {
    const step = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    expect(step.body.requiresTwoFactor).toBe(true)
    expect(step.body.methods).toContain('passkey')

    const options = await http<{ challenge: string; allowCredentials: Array<{ id: string }> }>(
      ctx,
      '/api/auth/2fa/passkey/options',
      { method: 'POST', body: { tempToken: step.body.tempToken } },
    )
    expect(options.status).toBe(200)
    expect(options.body.allowCredentials.map((item) => item.id)).toContain(credentialId)

    const unknown = await http<ErrorBody>(ctx, '/api/auth/2fa/passkey/verify', {
      method: 'POST',
      body: { tempToken: step.body.tempToken, response: { id: 'not-registered' } },
    })
    expect(unknown.status).toBe(401)
    expect(unknown.body.error.code).toBe('two_factor_invalid')
  })

  it('preferred_method 只能选已启用方法；删光 Passkey 自动关闭并回落偏好', async () => {
    const invalid = await http<ErrorBody>(ctx, '/api/me/2fa/preferred', {
      method: 'PUT',
      token: adminToken,
      body: { method: 'totp' },
    })
    expect(invalid.status).toBe(400)

    const preferred = await http<MeView>(ctx, '/api/me/2fa/preferred', {
      method: 'PUT',
      token: adminToken,
      body: { method: 'passkey' },
    })
    expect(preferred.status).toBe(200)
    expect(preferred.body.twoFactor.preferredMethod).toBe('passkey')
    // preferred 优先排序：passkey 排到方法列表首位
    expect(preferred.body.availableMethods[0]).toBe('passkey')

    const renamed = await http<{ passkeys: Array<{ id: string; name: string }> }>(
      ctx,
      `/api/me/2fa/passkeys/${credentialId}`,
      { method: 'PATCH', token: adminToken, body: { name: '改名后的钥匙' } },
    )
    expect(renamed.status).toBe(200)
    expect(renamed.body.passkeys[0]!.name).toBe('改名后的钥匙')

    const missingPassword = await http<ErrorBody>(ctx, `/api/me/2fa/passkeys/${credentialId}`, {
      method: 'DELETE',
      token: adminToken,
    })
    expect(missingPassword.status).toBe(400)

    const removed = await http<{ passkeys: unknown[] }>(ctx, `/api/me/2fa/passkeys/${credentialId}`, {
      method: 'DELETE',
      token: adminToken,
      body: { password: TEST_ADMIN_PASSWORD },
    })
    expect(removed.status).toBe(200)
    expect(removed.body.passkeys).toHaveLength(0)

    const me = await http<MeView>(ctx, '/api/me', { token: adminToken })
    expect(me.body.twoFactor.passkeyEnabled).toBe(false)
    expect(me.body.twoFactor.preferredMethod).toBe('email_otp')
  })
})

// ───────────────────────── §8.5 迁移与存量 ─────────────────────────

describe('迁移与存量（SPEC §8.5）', () => {
  it('v3 库升 v4：业务数据零变化、schemaVersion=4、v1–v3 迁移未被改写', async () => {
    // 先造一条业务数据（项目 + 任务），代表存量库
    const project = await http<{ project: { id: string } }>(ctx, '/api/projects', {
      method: 'POST',
      token: adminToken,
      body: { name: '存量项目', callbackUrl: 'https://downstream.example.com' },
    })
    expect(project.status).toBe(201)

    const job = await http(ctx, '/api/jobs', {
      method: 'POST',
      token: adminToken,
      body: { projectId: project.body.project.id, name: '存量任务', kind: 'cron', cron: '0 * * * *' },
    })
    expect(job.status).toBe(201)

    const jobsBefore = await rowCount('jobs')
    const projectsBefore = await rowCount('projects')

    // 模拟「升级前的 v3 库」：去掉 v4 的三张表与账本版本，其余（v1–v3 的数据）原样保留
    for (const table of ['auth_challenges', 'user_2fa', 'users']) {
      await ctx.sql.exec(`DROP TABLE ${table}`)
    }
    await ctx.sql.exec(`UPDATE waker_meta SET value = '3' WHERE key = 'schema_version'`)

    // 执行真实的 v4 迁移 SQL（MIGRATIONS 里那一条，原样）
    const v4 = MIGRATIONS.find((migration) => migration.version === 4)
    expect(v4).toBeDefined()
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4])

    await ctx.sql.exec(v4!.sql)
    await ctx.sql.exec(`UPDATE waker_meta SET value = '4' WHERE key = 'schema_version'`)

    expect(await rowCount('jobs')).toBe(jobsBefore)
    expect(await rowCount('projects')).toBe(projectsBefore)

    const state = await http<{ schemaVersion: number; initialized: boolean }>(ctx, '/api/setup/state')
    expect(state.body.schemaVersion).toBe(4)
    // 升级后 users 表是空的（存量库本来就没有用户体系）→ 走初始化流程
    expect(state.body.initialized).toBe(false)
  })
})
