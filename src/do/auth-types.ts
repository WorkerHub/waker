/**
 * 用户体系 / 2FA / 邮件配置的 RPC 领域类型（ONE-462 冻结契约的 data 部分）。
 *
 * 与 `types.ts` 同一条原则：出入参一律 JSON 可序列化；时间一律 epoch 毫秒。
 * 单独成文件是因为它是「鉴权面」的一组封闭契约，和任务/执行模型互不引用。
 */

/** 角色两级（SPEC §4.2）：`viewer` 只读，`admin` 读写。 */
export type UserRole = 'admin' | 'viewer'

/** 第二因素三选一（SPEC §5）：用户启用了哪几种就能用哪几种。 */
export type TwoFactorMethod = 'totp' | 'email_otp' | 'passkey'

/** 邮件通道（SPEC §6 双通道）。 */
export type EmailProvider = 'none' | 'smtp' | 'resend'

/** 对外暴露的用户视图（绝不含 password_hash）。 */
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

/** `GET /api/me`：本人资料 + 2FA 状态 + 可用方法（preferred 优先排序）。 */
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

/** 初始化状态（公开，供前端判断该显示 setup 还是登录页）。 */
export interface SetupStateView {
  schemaVersion: number
  /** 是否已有任意用户（首个管理员建好后即 true）。 */
  initialized: boolean
  /** 是否已有管理员（非空用户即为 admin，此字段供 setup 页显式判定）。 */
  adminExists: boolean
  registrationEnabled: boolean
  emailProvider: EmailProvider
}

/** `POST /api/setup` 的应答：bootstrap 令牌只在这里出现一次。 */
export interface BootstrapTokenView {
  schemaVersion: number
  adminExists: false
  bootstrapToken: string
  /** 令牌过期时刻（epoch ms，≤10 分钟）。 */
  expiresAt: number
}

/** `POST /api/auth/login` 的密码步结果。 */
export interface PasswordLoginView {
  user: UserView
  requiresTwoFactor: boolean
  /** 可用第二因素（preferred 优先）；`requiresTwoFactor=false` 时为空数组。 */
  methods: TwoFactorMethod[]
  /** 需要 2FA 时的一次性会话引用（Worker 用它签临时令牌）。 */
  sessionRef: string | null
  /** 一次性会话过期时刻（epoch ms）。 */
  sessionExpiresAt: number | null
}

/** 一次性 6 位码的生成结果（只在 DO → Worker 内部用，绝不出现在 HTTP 响应里）。 */
export interface OneTimeCodeView {
  challengeId: string
  code: string
  /** 收件人邮箱（DO 里读，Worker 直接拿去发）。 */
  email: string
  expiresAt: number
}

/**WebAuthn options（`@simplewebauthn/server` 原生结构，原样透给前端）。 */
export type WebAuthnOptionsView = Record<string, unknown>

/** SMTP 配置的**脱敏**视图：密码只报「是否已配置」，永不回显。 */
export interface SmtpConfigView {
  host: string
  port: number
  username: string
  from: string
  fromName: string
  secure: boolean
  passwordConfigured: boolean
}

/** Resend 配置的脱敏视图：API Key 只报「是否已配置」。 */
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

/** SMTP 入参：留空/缺省表示「不改」，`password: ''` 同样表示不改（照 eNotify 现行做法）。 */
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

/**
 * 发送侧拿到的**明文**邮件配置（只存在于 DO → Worker 的内存里，不落库、不回显、不进日志）。
 *
 * 为什么由 Worker 发送而不是 DO：唯一 DO 实例承载全部调度，会话性网络 IO（SMTP 握手
 * 可能耗时数秒）留在 DO 里会阻塞 alarm/投递；因此 DO 只解密凭据，发送在 Worker 侧做。
 */
export interface EmailSendConfig {
  provider: EmailProvider
  smtp: {
    host: string
    port: number
    username: string
    password: string
    from: string
    fromName: string
    secure: boolean
  } | null
  resend: { apiKey: string; from: string; fromName: string } | null
}

/** 用户管理入参（仅 admin）。 */
export interface UpdateUserInput {
  actorId: string
  userId: string
  role?: UserRole
  isActive?: boolean
}

export interface DeleteUserInput {
  actorId: string
  userId: string
}
