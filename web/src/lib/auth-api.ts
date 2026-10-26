/**
 * 鉴权面 API 客户端 —— 严格对齐后端 ONE-462 冻结契约（`src/api/auth-routes.ts` /
 * `src/api/me.ts` / `src/api/admin.ts` + `src/do/auth-types.ts`）。
 *
 * 三条边界在这里写死，页面不得绕过：
 *   1. **只消费契约**：路径、字段名、错误码全部照后端一字不改，前端不新增端点、不补字段、
 *      不把「后端没给的」自己算出来（角色、2FA 状态、限流计数都以接口返回为准）。
 *   2. **不自己签发/存储任何凭据**：会话只有 `{ token, expiresAt }`，由后端签发；
 *      bootstrap 令牌只在 `/setup` 两步之间短暂持有，2FA 临时令牌只在两步登录之间持有，
 *      两者都不落 localStorage（见 `stores/session.ts`）。
 *   3. **敏感值永不回显**：SMTP 密码 / Resend API Key 的视图只有 `passwordConfigured` /
 *      `apiKeyConfigured` 两个布尔位，入参留空即「不改」。
 *
 * 错误码是稳定契约（`src/api/errors.ts` 的状态码表），页面按 `code` 决定提示语。
 */
import { ApiError, jsonBody, request, type SessionInfo } from '@/lib/api'

export type { SessionInfo }

/** 角色两级（SPEC §4.2）：`viewer` 只读，`admin` 读写。 */
export type UserRole = 'admin' | 'viewer'

/** 第二因素三选一（SPEC §5）。 */
export type TwoFactorMethod = 'totp' | 'email_otp' | 'passkey'

/** 邮件通道（SPEC §6 双通道）。 */
export type EmailProvider = 'none' | 'smtp' | 'resend'

/** 对外用户视图（绝不含 `password_hash`）。 */
export interface UserView {
  id: string
  email: string
  displayName: string
  role: UserRole
  isActive: boolean
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
}

/** 本人 2FA 状态（不含任何 secret / 公钥材料）。 */
export interface TwoFactorStateView {
  totpEnabled: boolean
  emailOtpEnabled: boolean
  passkeyEnabled: boolean
  preferredMethod: TwoFactorMethod | null
}

/** `GET /api/me`：本人资料 + 2FA 状态 + 可用方法（后端已按 preferred 优先排序）。 */
export interface MeView {
  user: UserView
  twoFactor: TwoFactorStateView
  availableMethods: TwoFactorMethod[]
}

/** Passkey 列表项（脱敏：只有 id / 名称 / 创建时间）。 */
export interface PasskeyView {
  id: string
  name: string
  createdAt: number
}

/** 初始化状态（公开）：未初始化时任意页面都引导去 `/setup`（SPEC §3.1）。 */
export interface SetupStateView {
  schemaVersion: number
  initialized: boolean
  adminExists: boolean
  registrationEnabled: boolean
  emailProvider: EmailProvider
}

/** `POST /api/setup` 应答：bootstrap 令牌只在这里出现一次（≤10 分钟、仅限建首管）。 */
export interface BootstrapTokenView {
  schemaVersion: number
  adminExists: false
  bootstrapToken: string
  expiresAt: number
}

/** 密码步：直接发正式会话（该用户没有任何已启用第二因素）。 */
export interface PasswordLoginDirect {
  requiresTwoFactor: false
  user: UserView
  session: SessionInfo
}

/** 密码步：需要第二因素，`tempToken` 仅限 2FA 步（≤5 分钟）。 */
export interface PasswordLoginChallenge {
  requiresTwoFactor: true
  user: UserView
  methods: TwoFactorMethod[]
  tempToken: string
  expiresAt: number
}

export type PasswordLoginResult = PasswordLoginDirect | PasswordLoginChallenge

/** SMTP 配置脱敏视图：密码只报「是否已配置」，永不回显。 */
export interface SmtpConfigView {
  host: string
  port: number
  username: string
  from: string
  fromName: string
  secure: boolean
  passwordConfigured: boolean
}

/** Resend 配置脱敏视图：API Key 只报「是否已配置」。 */
export interface ResendConfigView {
  from: string
  fromName: string
  apiKeyConfigured: boolean
}

export interface EmailSettingsView {
  provider: EmailProvider
  smtp: SmtpConfigView
  resend: ResendConfigView
}

/** 系统管理面设置（仅 admin）。 */
export interface SystemSettingsView {
  registrationEnabled: boolean
  email: EmailSettingsView
}

/** SMTP 入参：字段留空 / 缺省表示「不改」（`password: ''` 同样表示不改）。 */
export interface SmtpConfigInput {
  host?: string
  port?: number
  username?: string
  password?: string
  from?: string
  fromName?: string
  secure?: boolean
}

export interface ResendConfigInput {
  apiKey?: string
  from?: string
  fromName?: string
}

export interface UpdateEmailSettingsInput {
  provider: EmailProvider
  smtp?: SmtpConfigInput
  resend?: ResendConfigInput
}

/** WebAuthn options（`@simplewebauthn/browser` 原生结构，原样透传给它，不自己解析）。 */
export type WebAuthnOptionsView = Record<string, unknown>

/**
 * WebAuthn 断言 / 注册结果：`startAuthentication` / `startRegistration` 的返回值
 * （`@simplewebauthn/browser` 的 `AuthenticationResponseJSON` / `RegistrationResponseJSON`），
 * 原样回传后端 `@simplewebauthn/server` 的 `verify*Response`，前端不解析、不改写。
 */
export type WebAuthnResponseJSON = object

// ───────────────────────── 初始化（SPEC §3） ─────────────────────────

/** 初始化状态：公开接口，页面据此决定显示 setup 还是登录 / 注册入口。 */
export function getSetupState(): Promise<SetupStateView> {
  return request<SetupStateView>('/api/setup/state')
}

/** 初始化第 1 步：`SETUP_SECRET` → 一次性 bootstrap 令牌（已初始化则 403 `already_initialized`）。 */
export function beginSetup(setupSecret: string): Promise<BootstrapTokenView> {
  return request<BootstrapTokenView>('/api/setup', {
    method: 'POST',
    body: jsonBody({ setupSecret }),
  })
}

/** 初始化第 2 步：凭 bootstrap 令牌建首个管理员，成功即拿到正式会话。 */
export function createFirstAdmin(input: {
  bootstrapToken: string
  email: string
  password: string
  displayName: string
}): Promise<{ user: UserView; session: SessionInfo }> {
  return request<{ user: UserView; session: SessionInfo }>('/api/setup/admin', {
    method: 'POST',
    body: jsonBody(input),
  })
}

// ───────────────────────── 注册 / 登录（SPEC §4 / §5） ─────────────────────────

/** 注册：开关打开时注册即登录（`role='viewer'`，仍须过其后续自设的 2FA）。 */
export function register(input: {
  email: string
  password: string
  displayName: string
}): Promise<{ user: UserView; session: SessionInfo }> {
  return request<{ user: UserView; session: SessionInfo }>('/api/auth/register', {
    method: 'POST',
    body: jsonBody(input),
  })
}

/** 密码步：无已启用第二因素直接回会话；有则回临时令牌 + 方法列表（preferred 优先）。 */
export function loginWithPassword(email: string, password: string): Promise<PasswordLoginResult> {
  return request<PasswordLoginResult>('/api/auth/login', {
    method: 'POST',
    body: jsonBody({ email, password }),
  })
}

/** 2FA 步（TOTP / 邮件验证码）：通过才发正式会话。 */
export function verifyTwoFactorCode(input: {
  tempToken: string
  method: 'totp' | 'email_otp'
  code: string
}): Promise<{ user: UserView; session: SessionInfo }> {
  return request<{ user: UserView; session: SessionInfo }>('/api/auth/2fa/verify', {
    method: 'POST',
    body: jsonBody(input),
  })
}

/** 发送登录用邮件验证码（失败关闭：provider 未配置 / 发送失败都明确报错）。 */
export function sendLoginEmailOtp(tempToken: string): Promise<{ sent: true; expiresAt: number }> {
  return request<{ sent: true; expiresAt: number }>('/api/auth/2fa/otp/send', {
    method: 'POST',
    body: jsonBody({ tempToken }),
  })
}

/** Passkey 登录 options（WebAuthn authentication）。 */
export function passkeyLoginOptions(tempToken: string): Promise<WebAuthnOptionsView> {
  return request<WebAuthnOptionsView>('/api/auth/2fa/passkey/options', {
    method: 'POST',
    body: jsonBody({ tempToken }),
  })
}

/** Passkey 登录断言提交：`response` 是 `@simplewebauthn/browser` 的原始返回值。 */
export function passkeyLoginVerify(input: {
  tempToken: string
  response: WebAuthnResponseJSON
}): Promise<{ user: UserView; session: SessionInfo }> {
  return request<{ user: UserView; session: SessionInfo }>('/api/auth/2fa/passkey/verify', {
    method: 'POST',
    body: jsonBody(input),
  })
}

// ───────────────────────── 本人设置（SPEC §5.3） ─────────────────────────

export function getMe(): Promise<MeView> {
  return request<MeView>('/api/me')
}

export function updateProfile(displayName: string): Promise<MeView> {
  return request<MeView>('/api/me', { method: 'PATCH', body: jsonBody({ displayName }) })
}

/** 改密码：必须复验当前密码（`password_required` / `invalid_password`）。 */
export function changePassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<{ success: true }> {
  return request<{ success: true }>('/api/me/password', {
    method: 'POST',
    body: jsonBody(input),
  })
}

/** TOTP 绑定开始：回 `{ secret, uri }`（`uri` 即 otpauth URI，二维码由它生成）。 */
export function startTotpSetup(): Promise<{ secret: string; uri: string }> {
  return request<{ secret: string; uri: string }>('/api/me/2fa/totp/setup', { method: 'POST' })
}

/** 输码确认才落库置 `totp_enabled=1`。 */
export function confirmTotpSetup(code: string): Promise<MeView> {
  return request<MeView>('/api/me/2fa/totp/enable', {
    method: 'POST',
    body: jsonBody({ code }),
  })
}

/** 解绑 TOTP：敏感变更，须复验密码。 */
export function disableTotp(password: string): Promise<MeView> {
  return request<MeView>('/api/me/2fa/totp/disable', {
    method: 'POST',
    body: jsonBody({ password }),
  })
}

/** 邮件 OTP 启用前必须先发码验码；provider 未配置时后端明确回 `email_not_configured`。 */
export function sendEmailOtpSetupCode(): Promise<{ sent: true; expiresAt: number }> {
  return request<{ sent: true; expiresAt: number }>('/api/me/2fa/email-otp/send', {
    method: 'POST',
  })
}

export function enableEmailOtp(code: string): Promise<MeView> {
  return request<MeView>('/api/me/2fa/email-otp/enable', {
    method: 'POST',
    body: jsonBody({ code }),
  })
}

/** 关闭邮件 OTP：敏感变更，须复验密码。 */
export function disableEmailOtp(password: string): Promise<MeView> {
  return request<MeView>('/api/me/2fa/email-otp/disable', {
    method: 'POST',
    body: jsonBody({ password }),
  })
}

export function listPasskeys(): Promise<PasskeyView[]> {
  return request<{ passkeys: PasskeyView[] }>('/api/me/2fa/passkeys').then((body) => body.passkeys)
}

/** Passkey 注册 options（WebAuthn registration）。 */
export function passkeyRegisterOptions(): Promise<WebAuthnOptionsView> {
  return request<WebAuthnOptionsView>('/api/me/2fa/passkey/options', { method: 'POST' })
}

/** 注册结果提交：`response` 是 `@simplewebauthn/browser` 的原始返回值。 */
export function registerPasskey(input: {
  response: WebAuthnResponseJSON
  name: string
}): Promise<PasskeyView> {
  return request<{ passkey: PasskeyView }>('/api/me/2fa/passkey/verify', {
    method: 'POST',
    body: jsonBody(input),
  }).then((body) => body.passkey)
}

export function renamePasskey(credentialId: string, name: string): Promise<PasskeyView[]> {
  return request<{ passkeys: PasskeyView[] }>(
    `/api/me/2fa/passkeys/${encodeURIComponent(credentialId)}`,
    { method: 'PATCH', body: jsonBody({ name }) },
  ).then((body) => body.passkeys)
}

/** 删除 Passkey：敏感变更，须复验密码；删光后后端自动清 `passkey_enabled`。 */
export function deletePasskey(credentialId: string, password: string): Promise<PasskeyView[]> {
  return request<{ passkeys: PasskeyView[] }>(
    `/api/me/2fa/passkeys/${encodeURIComponent(credentialId)}`,
    { method: 'DELETE', body: jsonBody({ password }) },
  ).then((body) => body.passkeys)
}

/** 首选方法只在已启用方法中选（后端 `#reconcilePreferred` 兜底）。 */
export function setPreferredMethod(method: TwoFactorMethod): Promise<MeView> {
  return request<MeView>('/api/me/2fa/preferred', {
    method: 'PUT',
    body: jsonBody({ method }),
  })
}

// ───────────────────────── 系统管理（仅 admin，SPEC §4.3 / §6） ─────────────────────────

export function listUsers(): Promise<UserView[]> {
  return request<{ users: UserView[] }>('/api/users').then((body) => body.users)
}

/** 改角色 / 启用状态（防自锁由后端强制：最后一个 admin 不可降级/禁用）。 */
export function updateUser(
  userId: string,
  patch: { role?: UserRole; isActive?: boolean },
): Promise<UserView> {
  return request<{ user: UserView }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: jsonBody(patch),
  }).then((body) => body.user)
}

export function deleteUser(userId: string): Promise<{ success: true }> {
  return request<{ success: true }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}

export function getSystemSettings(): Promise<SystemSettingsView> {
  return request<SystemSettingsView>('/api/system/settings')
}

export function setRegistrationEnabled(enabled: boolean): Promise<SystemSettingsView> {
  return request<SystemSettingsView>('/api/system/settings/registration', {
    method: 'PUT',
    body: jsonBody({ enabled }),
  })
}

/** 保存邮件服务配置：留空字段不发（= 不改），密码 / API Key 只在前端持有明文的那一次提交。 */
export function updateEmailSettings(input: UpdateEmailSettingsInput): Promise<SystemSettingsView> {
  return request<SystemSettingsView>('/api/system/settings/email', {
    method: 'PUT',
    body: jsonBody(input),
  })
}

/** 发送测试邮件：`to` 缺省发给当前管理员本人（后端行为）。 */
export function sendTestEmail(to?: string): Promise<{ sent: true }> {
  return request<{ sent: true }>('/api/system/settings/email/test', {
    method: 'POST',
    body: jsonBody(to === undefined || to === '' ? {} : { to }),
  })
}

// ───────────────────────── 页面提示语 ─────────────────────────

/**
 * 鉴权面错误码 → 面向用户的中文提示（页面统一走这里，不各自拼文案）。
 *
 * 只覆盖「前端能触发、且需要比后端 message 更具体」的几种；其余原样用后端 message
 * （后端 message 已经是给人看的中文，契约里也是稳定错误码 + 可读消息）。
 */
const AUTH_ERROR_HINTS: Record<string, string> = {
  invalid_credentials: '邮箱或密码不正确',
  invalid_token: 'bootstrap 令牌无效或已过期，请重新输入 SETUP_SECRET',
  already_initialized: '已完成初始化，请直接登录',
  registration_closed: '管理员尚未开放注册',
  setup_required: '系统尚未初始化，请先完成初始化',
  duplicate_email: '该邮箱已注册',
  forbidden: '当前账号没有这个操作权限（viewer 只读）',
  user_not_found: '用户不存在',
  passkey_not_found: '该账号未注册 Passkey',
  password_required: '这个操作需要先验证当前密码',
  invalid_password: '当前密码不正确',
  two_factor_required: '两步登录已超时，请重新登录',
  two_factor_invalid: '验证码不正确或已失效',
  two_factor_not_enabled: '该方法尚未启用',
  email_not_configured: '管理员尚未配置邮件服务，此方法暂不可用',
  email_send_failed: '邮件发送失败，请检查邮件服务配置',
  rate_limited: '尝试次数过多，请稍后再试',
  unauthorized: '登录状态已失效，请重新登录',
  invalid_argument: '提交的内容不符合要求',
  internal: '服务端出错，请稍后重试',
}

export function describeAuthError(error: unknown): string {
  if (error instanceof ApiError) return AUTH_ERROR_HINTS[error.code] ?? error.message
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

/** 该错误是否代表「会话已失效」（页面据此提示重新登录，而不是留在原地重试）。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}
