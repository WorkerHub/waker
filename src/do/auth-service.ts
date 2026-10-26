import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

import { constantTimeEquals } from '../auth/compare'
import { DUMMY_PASSWORD_HASH, checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password'
import { generateTotpSecret, totpUri, verifyTotpCode } from '../auth/totp'
import type { Env } from '../env'
import {
  decryptEmailSecret,
  decryptTotpSecret,
  deriveEmailKek,
  deriveOtpPepper,
  deriveTotpKek,
  encryptEmailSecret,
  encryptTotpSecret,
  generateOpaqueToken,
  hashOneTimeCode,
} from './keyring'
import {
  RESEND_CONFIG_KEY,
  SMTP_CONFIG_KEY,
  consumeChallenge,
  countAdmins,
  countUsers,
  deleteChallenge,
  deleteTempState,
  deleteUser,
  ensureTwoFactorRow,
  findActiveChallenge,
  findTwoFactorRow,
  findUserByEmail,
  findUserById,
  getTempState,
  hasUsedTotpCode,
  hitRateLimit,
  insertChallenge,
  insertUser,
  isEmailProvider,
  listUserRows,
  normalizeEmail,
  pruneAuthChallenges,
  pruneTempState,
  putTempState,
  readEmailProvider,
  readJsonMeta,
  readRegistrationEnabled,
  requireUserRow,
  updateTwoFactor,
  updateUser,
  writeEmailProvider,
  writeJsonMeta,
  writeRegistrationEnabled,
} from './auth-store'
import type {
  BootstrapTokenView,
  EmailSendConfig,
  EmailSettingsView,
  MeView,
  OneTimeCodeView,
  PasskeyView,
  PasswordLoginView,
  SetupStateView,
  SystemSettingsView,
  TwoFactorMethod,
  TwoFactorStateView,
  UpdateEmailSettingsInput,
  UpdateUserInput,
  UserRole,
  UserView,
  WebAuthnOptionsView,
} from './auth-types'
import { WakerError } from './errors'
import { readSchemaVersion } from './schema'
import { isValidEmail } from '../email/send'

/**
 * 用户体系 / 两步登录 / 2FA / 邮件配置的**业务实现**，住在 WakerDO 里。
 *
 * 为什么全在这里：用户与 2FA 的真源是 WakerDO 的 SQLite（SPEC §1：不建 D1 / 不建 KV），
 * 而「首个管理员判定 + 写入必须在同一次 DO 调用内完成」（SPEC §3.2）——所以判定、限流、
 * 一次性状态、写入全部落在 DO 的串行执行里。Worker 只做 HTTP 映射 + 发邮件（见 `auth-types.ts`
 * 里 `EmailSendConfig` 的说明：会话性网络 IO 不阻塞唯一 DO）。
 *
 * 落库不变量（评审按这几条核）：
 *   1. TOTP secret、SMTP 密码、Resend API Key 只以 `waker-enc:v1:` 密文信封落库，明文只在内存里；
 *   2. 一次性验证码只存 HMAC 哈希（pepper 由 JWT_SECRET 经 HKDF 独立派生），禁止明文落库；
 *   3. 对外视图（`UserView` / `MeView` / 设置视图）永不包含 secret、密码哈希、公钥材料。
 */

// ── 有效期（SPEC §2 / §3 / §5 定死） ──
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000
const TWO_FACTOR_SESSION_TTL_MS = 5 * 60 * 1000
const EMAIL_OTP_TTL_MS = 5 * 60 * 1000
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000
const TOTP_USED_TTL_MS = 90 * 1000
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000

// ── 限流（照 SPEC §3.1 / §5.1 与 eNotify 现行数值） ──
const SETUP_RATE = { max: 3, windowMs: 10 * 60 * 1000 }
const LOGIN_RATE = { max: 10, windowMs: 5 * 60 * 1000 }
const REGISTER_RATE = { max: 5, windowMs: 5 * 60 * 1000 }
const OTP_SEND_RATE = { max: 3, windowMs: 5 * 60 * 1000 }
const PASSKEY_RATE = { max: 10, windowMs: 5 * 60 * 1000 }
/** 单次 2FA 会话最多允许错几次码（照 eNotify：5 次后作废会话）。 */
const TWO_FACTOR_MAX_FAILURES = 5

const MAX_DISPLAY_NAME_LENGTH = 64
const MAX_PASSKEY_NAME_LENGTH = 64

interface PasskeyCredential {
  id: string
  publicKey: string
  counter: number
  name: string
  createdAt: number
}

const METHOD_LABELS: Record<TwoFactorMethod, string> = {
  totp: '身份验证器（TOTP）',
  email_otp: '邮件验证码',
  passkey: 'Passkey',
}

export class AuthService {
  #totpKek: Promise<CryptoKey> | null = null
  #emailKek: Promise<CryptoKey> | null = null
  #pepper: Promise<CryptoKey> | null = null

  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ───────────────────────── 内部工具 ─────────────────────────

  #totpKekKey(): Promise<CryptoKey> {
    this.#totpKek ??= deriveTotpKek(this.env.JWT_SECRET)
    return this.#totpKek
  }

  #emailKekKey(): Promise<CryptoKey> {
    this.#emailKek ??= deriveEmailKek(this.env.JWT_SECRET)
    return this.#emailKek
  }

  #pepperKey(): Promise<CryptoKey> {
    this.#pepper ??= deriveOtpPepper(this.env.JWT_SECRET)
    return this.#pepper
  }

  #newId(): string {
    return crypto.randomUUID()
  }

  /** 6 位数字码（`100000`–`999999`，与 eNotify 同分布）。 */
  #generateSixDigitCode(): string {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return String(100000 + (buf[0]! % 900000))
  }

  #requireEmail(email: unknown): string {
    if (!isValidEmail(email)) throw new WakerError('invalid_argument', '邮箱格式不正确')
    return normalizeEmail(email)
  }

  #requireDisplayName(value: unknown, fallback: string): string {
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string') throw new WakerError('invalid_argument', '昵称必须是字符串')
    const trimmed = value.trim()
    if (trimmed.length === 0) return fallback
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new WakerError('invalid_argument', `昵称最长 ${MAX_DISPLAY_NAME_LENGTH} 个字符`)
    }
    return trimmed
  }

  #enforceRateLimit(scope: string, key: string, limit: { max: number; windowMs: number }): void {
    const result = hitRateLimit(this.sql, {
      scope,
      key,
      max: limit.max,
      windowMs: limit.windowMs,
      now: this.now(),
    })
    if (result.allowed) return
    throw new WakerError('rate_limited', `操作过于频繁，请 ${result.retryAfterSeconds} 秒后再试`, {
      retryAfterSeconds: result.retryAfterSeconds,
    })
  }

  /** 敏感变更复验密码（照 eNotify `requirePassword`）：缺密码 400，密码错 403。 */
  async #requirePassword(userId: string, password: unknown): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new WakerError('password_required', '此操作需要先输入当前密码')
    }
    const user = requireUserRow(this.sql, userId)
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new WakerError('invalid_password', '当前密码不正确')
    }
  }

  /** 只有 admin 能调用（接口层已拦一次，这里是第二道，防止绕过中间件）。 */
  #requireAdmin(actorId: string): void {
    const actor = findUserById(this.sql, actorId)
    if (actor === null || actor.role !== 'admin' || Number(actor.is_active) !== 1) {
      throw new WakerError('forbidden', '需要管理员权限')
    }
  }

  // ───────────────────────── 视图转换 ─────────────────────────

  #toUserView(row: ReturnType<typeof requireUserRow>): UserView {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role === 'admin' ? 'admin' : 'viewer',
      isActive: Number(row.is_active) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
    }
  }

  #toTwoFactorState(userId: string): TwoFactorStateView {
    const row = findTwoFactorRow(this.sql, userId)
    const preferred = row?.preferred_method
    return {
      totpEnabled: Number(row?.totp_enabled ?? 0) === 1,
      emailOtpEnabled: Number(row?.email_otp_enabled ?? 0) === 1,
      passkeyEnabled: Number(row?.passkey_enabled ?? 0) === 1,
      preferredMethod:
        preferred === 'totp' || preferred === 'email_otp' || preferred === 'passkey' ? preferred : null,
    }
  }

  /** 可用第二因素（preferred 优先，其余按 totp → passkey → email_otp 与 eNotify 同序）。 */
  #availableMethods(userId: string): TwoFactorMethod[] {
    const row = findTwoFactorRow(this.sql, userId)
    if (row === null) return []
    const methods: TwoFactorMethod[] = []
    if (Number(row.totp_enabled) === 1 && row.totp_secret !== null) methods.push('totp')
    if (Number(row.passkey_enabled) === 1) methods.push('passkey')
    if (Number(row.email_otp_enabled) === 1) methods.push('email_otp')

    const preferred = row.preferred_method
    if (preferred === 'totp' || preferred === 'email_otp' || preferred === 'passkey') {
      return [...methods.filter((method) => method === preferred), ...methods.filter((m) => m !== preferred)]
    }
    return methods
  }

  /** 启用/解绑后修正 `preferred_method`：指向的方法没启用时回落到第一个可用方法。 */
  #reconcilePreferred(userId: string): void {
    const state = this.#toTwoFactorState(userId)
    const available = this.#availableMethods(userId)
    if (state.preferredMethod !== null && available.includes(state.preferredMethod)) return
    updateTwoFactor(this.sql, userId, { preferredMethod: available[0] ?? null, now: this.now() })
  }

  #passkeys(userId: string): PasskeyCredential[] {
    const row = findTwoFactorRow(this.sql, userId)
    if (row === null) return []
    try {
      const parsed = JSON.parse(row.passkey_credentials) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is PasskeyCredential =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as PasskeyCredential).id === 'string' &&
          typeof (item as PasskeyCredential).publicKey === 'string',
      )
    } catch {
      return []
    }
  }

  #writePasskeys(userId: string, credentials: readonly PasskeyCredential[]): void {
    updateTwoFactor(this.sql, userId, {
      passkeyCredentials: JSON.stringify(credentials),
      passkeyEnabled: credentials.length > 0,
      now: this.now(),
    })
  }

  #toPasskeyView(credential: PasskeyCredential): PasskeyView {
    return {
      id: credential.id,
      name: credential.name.length > 0 ? credential.name : '我的 Passkey',
      createdAt: credential.createdAt,
    }
  }

  // ───────────────────────── 初始化 / SETUP_SECRET（SPEC §3） ─────────────────────────

  setupState(): SetupStateView {
    return {
      schemaVersion: readSchemaVersion(this.sql),
      initialized: countUsers(this.sql) > 0,
      adminExists: countAdmins(this.sql) > 0,
      registrationEnabled: readRegistrationEnabled(this.sql),
      emailProvider: readEmailProvider(this.sql),
    }
  }

  /**
   * `POST /api/setup`：校验 SETUP_SECRET（常量时间 + 按 IP 限流 3 次/10 分钟），
   * 回显迁移版本并签发一次性 bootstrap 令牌（≤10 分钟）。
   *
   * 已有管理员时一律 403 `already_initialized` —— 这就是 SPEC §3.2 的「密钥失效」。
   */
  async beginSetup(input: { setupSecret: unknown; ip: string }): Promise<BootstrapTokenView> {
    if (countUsers(this.sql) > 0) {
      throw new WakerError('already_initialized', '已完成初始化，请直接登录')
    }

    this.#enforceRateLimit('setup', input.ip, SETUP_RATE)

    const configured = typeof this.env.SETUP_SECRET === 'string' ? this.env.SETUP_SECRET : ''
    const presented = typeof input.setupSecret === 'string' ? input.setupSecret : ''
    if (configured.length === 0 || presented.length === 0) {
      throw new WakerError('invalid_credentials', 'SETUP_SECRET 不正确或未配置')
    }
    const matched = await constantTimeEquals(presented, configured, this.env.JWT_SECRET)
    if (!matched) throw new WakerError('invalid_credentials', 'SETUP_SECRET 不正确或未配置')

    const token = generateOpaqueToken()
    const expiresAt = this.now() + BOOTSTRAP_TTL_MS
    const hash = await hashOneTimeCode(await this.#pepperKey(), `bootstrap:${token}`)
    putTempState(this.sql, `bootstrap:${hash}`, { expiresAt })

    return { schemaVersion: readSchemaVersion(this.sql), adminExists: false, bootstrapToken: token, expiresAt }
  }

  /**
   * `POST /api/setup/admin`：凭 bootstrap 令牌创建**首个管理员**。
   *
   * 「首个即管理员」的判定与写入在同一次 DO 调用内（DO 单实例串行天然互斥），
   * 令牌被一次性消费；并发提交只有一个能成功，其余拿 `already_initialized`。
   */
  async createFirstAdmin(input: {
    bootstrapToken: unknown
    email: unknown
    password: unknown
    displayName: unknown
  }): Promise<UserView> {
    const token = typeof input.bootstrapToken === 'string' ? input.bootstrapToken : ''
    if (token.length === 0) throw new WakerError('invalid_token', 'bootstrap 令牌缺失')

    const hash = await hashOneTimeCode(await this.#pepperKey(), `bootstrap:${token}`)
    const stateKey = `bootstrap:${hash}`
    const state = getTempState(this.sql, stateKey, this.now())
    if (state === null) throw new WakerError('invalid_token', 'bootstrap 令牌无效或已过期')

    if (countUsers(this.sql) > 0) {
      deleteTempState(this.sql, stateKey)
      throw new WakerError('already_initialized', '已完成初始化，请直接登录')
    }

    const email = this.#requireEmail(input.email)
    const policy = checkPasswordPolicy(input.password)
    if (!policy.ok) throw new WakerError('invalid_argument', policy.message)
    const displayName = this.#requireDisplayName(input.displayName, email.split('@')[0] ?? 'admin')

    const now = this.now()
    const userId = this.#newId()
    const passwordHash = await hashPassword(input.password as string)

    // 「首个即管理员」的判定（上面的 countUsers）与写入都在**同一次 DO 调用**里，
    // DO 单实例串行执行天然互斥，不存在两个请求都看到「空库」的窗口。
    // 写入顺序：先建用户，成功后立刻消费令牌 —— 中途异常时令牌仍然有效，可安全重试。
    insertUser(this.sql, {
      id: userId,
      email,
      passwordHash,
      displayName,
      role: 'admin',
      isActive: true,
      now,
    })
    ensureTwoFactorRow(this.sql, userId, now)
    deleteTempState(this.sql, stateKey)
    writeRegistrationEnabled(this.sql, false)
    writeEmailProvider(this.sql, 'none')

    return this.#toUserView(requireUserRow(this.sql, userId))
  }

  // ───────────────────────── 注册（SPEC §4） ─────────────────────────

  async register(input: {
    email: unknown
    password: unknown
    displayName: unknown
    ip: string
  }): Promise<UserView> {
    if (countUsers(this.sql) === 0) {
      throw new WakerError('setup_required', '系统尚未初始化，请先完成初始化再注册')
    }

    this.#enforceRateLimit('register', input.ip, REGISTER_RATE)

    if (!readRegistrationEnabled(this.sql)) {
      throw new WakerError('registration_closed', '管理员尚未开放注册')
    }

    const email = this.#requireEmail(input.email)
    const policy = checkPasswordPolicy(input.password)
    if (!policy.ok) throw new WakerError('invalid_argument', policy.message)
    const displayName = this.#requireDisplayName(input.displayName, email.split('@')[0] ?? 'viewer')

    if (findUserByEmail(this.sql, email) !== null) {
      throw new WakerError('duplicate_email', '该邮箱已注册')
    }

    const now = this.now()
    const userId = this.#newId()
    const passwordHash = await hashPassword(input.password as string)

    try {
      insertUser(this.sql, {
        id: userId,
        email,
        passwordHash,
        displayName,
        role: 'viewer',
        isActive: true,
        now,
      })
    } catch (error) {
      // 并发注册同一邮箱：唯一索引兜底（不靠「先查后写」）。
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new WakerError('duplicate_email', '该邮箱已注册')
      }
      throw error
    }
    ensureTwoFactorRow(this.sql, userId, now)

    return this.#toUserView(requireUserRow(this.sql, userId))
  }

  // ───────────────────────── 两步登录（SPEC §5.1） ─────────────────────────

  /** 密码步：校验密码 → 无已启用第二因素直接放行；有则发一次性 2FA 会话引用。 */
  async beginLogin(input: { email: unknown; password: unknown; ip: string }): Promise<PasswordLoginView> {
    this.#enforceRateLimit('login', input.ip, LOGIN_RATE)

    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (email.length === 0 || password.length === 0) {
      throw new WakerError('invalid_argument', '邮箱与密码不能为空')
    }

    const user = findUserByEmail(this.sql, email)
    // 用户不存在也走一遍等价代价的哈希校验，抹平计时差异（不泄漏邮箱是否注册）。
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (user === null || !valid || Number(user.is_active) !== 1) {
      throw new WakerError('invalid_credentials', '邮箱或密码不正确')
    }

    const methods = this.#availableMethods(user.id)
    const base = {
      user: this.#toUserView(user),
      requiresTwoFactor: methods.length > 0,
      methods,
    }

    if (methods.length === 0) {
      this.#completeLogin(user.id)
      return { ...base, sessionRef: null, sessionExpiresAt: null }
    }

    const sessionRef = generateOpaqueToken()
    const expiresAt = this.now() + TWO_FACTOR_SESSION_TTL_MS
    putTempState(this.sql, `2fa:${sessionRef}`, { userId: user.id, expiresAt, fails: 0 })

    return { ...base, sessionRef, sessionExpiresAt: expiresAt }
  }

  #completeLogin(userId: string): void {
    updateUser(this.sql, userId, { lastLoginAt: this.now(), now: this.now() })
  }

  /** 取一次性 2FA 会话；不存在/过期即 `two_factor_required`（要求重新走密码步）。 */
  #requireTwoFactorSession(sessionRef: unknown): { ref: string; userId: string; fails: number } {
    const ref = typeof sessionRef === 'string' ? sessionRef : ''
    if (ref.length === 0) throw new WakerError('two_factor_required', '请先完成密码验证')
    const state = getTempState(this.sql, `2fa:${ref}`, this.now())
    if (state === null) {
      throw new WakerError('two_factor_required', '两步登录会话已过期，请重新登录')
    }
    const userId = typeof state.userId === 'string' ? state.userId : ''
    if (userId.length === 0) throw new WakerError('two_factor_required', '两步登录会话无效，请重新登录')
    return { ref, userId, fails: Number(state.fails ?? 0) }
  }

  /** 记一次失败；达到上限直接作废整个 2FA 会话（照 eNotify）。 */
  #recordTwoFactorFailure(ref: string, userId: string, fails: number): never {
    const next = fails + 1
    if (next >= TWO_FACTOR_MAX_FAILURES) {
      deleteTempState(this.sql, `2fa:${ref}`)
      throw new WakerError('two_factor_invalid', '验证失败次数过多，请重新登录')
    }
    putTempState(this.sql, `2fa:${ref}`, {
      userId,
      expiresAt: this.now() + TWO_FACTOR_SESSION_TTL_MS,
      fails: next,
    })
    throw new WakerError('two_factor_invalid', '验证码不正确')
  }

  #finishTwoFactor(input: { ref: string; userId: string }): UserView {
    const user = requireUserRow(this.sql, input.userId)
    if (Number(user.is_active) !== 1) throw new WakerError('forbidden', '账号已被禁用')
    deleteTempState(this.sql, `2fa:${input.ref}`)
    this.#completeLogin(user.id)
    return this.#toUserView(user)
  }

  /** TOTP 步：6 位码、±1 窗口、`totp_used` 防重放（码用过即记 90 秒）。 */
  async verifyTotpLogin(input: { sessionRef: unknown; code: unknown }): Promise<UserView> {
    const session = this.#requireTwoFactorSession(input.sessionRef)
    const row = findTwoFactorRow(this.sql, session.userId)
    if (row === null || Number(row.totp_enabled) !== 1 || row.totp_secret === null) {
      throw new WakerError('two_factor_not_enabled', '该账号未启用身份验证器')
    }

    const secret = await decryptTotpSecret(row.totp_secret, await this.#totpKekKey())
    if (secret === null) throw new WakerError('internal', '身份验证器密钥不可读')

    const user = requireUserRow(this.sql, session.userId)
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    const matched = verifyTotpCode(secret, user.email, code)
    if (matched === null) this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)

    // 防重放：同一枚码在 90 秒窗口内只能用一次（含本窗口 ±1 的抖动）。
    const codeHash = await hashOneTimeCode(await this.#pepperKey(), `totp:${session.userId}:${code}`)
    const now = this.now()
    if (hasUsedTotpCode(this.sql, { userId: session.userId, codeHash, now })) {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }
    insertChallenge(this.sql, {
      id: this.#newId(),
      userId: session.userId,
      kind: 'totp_used',
      sessionRef: session.ref,
      codeHash,
      expiresAt: now + TOTP_USED_TTL_MS,
      now,
    })

    return this.#finishTwoFactor(session)
  }

  /** 邮件 OTP 步：验证码只存哈希，验后即消费。 */
  async verifyEmailOtpLogin(input: { sessionRef: unknown; code: unknown }): Promise<UserView> {
    const session = this.#requireTwoFactorSession(input.sessionRef)
    const row = findTwoFactorRow(this.sql, session.userId)
    if (row === null || Number(row.email_otp_enabled) !== 1) {
      throw new WakerError('two_factor_not_enabled', '该账号未启用邮件验证码')
    }

    const code = typeof input.code === 'string' ? input.code.trim() : ''
    const challenge = findActiveChallenge(this.sql, {
      userId: session.userId,
      kind: 'email_otp',
      sessionRef: session.ref,
      now: this.now(),
    })
    if (challenge === null) {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }

    const codeHash = await hashOneTimeCode(
      await this.#pepperKey(),
      `email_otp:${session.userId}:${session.ref}:${code}`,
    )
    if (codeHash !== challenge!.code_hash) {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }

    consumeChallenge(this.sql, challenge!.id, this.now())
    return this.#finishTwoFactor(session)
  }

  /**
   * 发登录用邮件 OTP：**失败关闭** —— provider 未配置时直接报错、不生成挑战；
   * 发送失败由 Worker 调 `discardChallenge` 撤销（挑战不会留在库里）。
   */
  async sendLoginEmailOtp(input: { sessionRef: unknown }): Promise<OneTimeCodeView> {
    const session = this.#requireTwoFactorSession(input.sessionRef)
    const row = findTwoFactorRow(this.sql, session.userId)
    if (row === null || Number(row.email_otp_enabled) !== 1) {
      throw new WakerError('two_factor_not_enabled', '该账号未启用邮件验证码')
    }
    if (readEmailProvider(this.sql) === 'none') {
      throw new WakerError('email_not_configured', '管理员尚未配置邮件服务，此方法暂不可用')
    }

    this.#enforceRateLimit('otp_send', session.ref, OTP_SEND_RATE)

    const user = requireUserRow(this.sql, session.userId)
    const code = this.#generateSixDigitCode()
    const now = this.now()
    const challengeId = this.#newId()
    insertChallenge(this.sql, {
      id: challengeId,
      userId: session.userId,
      kind: 'email_otp',
      sessionRef: session.ref,
      codeHash: await hashOneTimeCode(
        await this.#pepperKey(),
        `email_otp:${session.userId}:${session.ref}:${code}`,
      ),
      expiresAt: now + EMAIL_OTP_TTL_MS,
      now,
    })

    return { challengeId, code, email: user.email, expiresAt: now + EMAIL_OTP_TTL_MS }
  }

  /** 撤销一枚挑战（邮件发送失败 / 测试失败时调用：失败关闭，不留下可用挑战）。 */
  discardChallenge(input: { challengeId: unknown }): { discarded: boolean } {
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
    if (challengeId.length === 0) return { discarded: false }
    deleteChallenge(this.sql, challengeId)
    return { discarded: true }
  }

  // ───────────────────────── Passkey 登录（SPEC §5.1） ─────────────────────────

  async passkeyLoginOptions(input: { sessionRef: unknown; rpId: unknown }): Promise<WebAuthnOptionsView> {
    const session = this.#requireTwoFactorSession(input.sessionRef)
    const credentials = this.#passkeys(session.userId)
    if (credentials.length === 0) {
      throw new WakerError('passkey_not_found', '该账号未注册 Passkey')
    }
    this.#enforceRateLimit('passkey', session.ref, PASSKEY_RATE)

    const rpId = typeof input.rpId === 'string' && input.rpId.length > 0
      ? input.rpId
      : (() => {
          throw new WakerError('invalid_argument', '缺少 rpId')
        })()

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: credentials.map((credential) => ({ id: credential.id, type: 'public-key' })),
      userVerification: 'preferred',
    })

    putTempState(this.sql, `passkey_auth:${session.ref}`, {
      challenge: options.challenge,
      expiresAt: this.now() + PASSKEY_CHALLENGE_TTL_MS,
    })
    return options as unknown as WebAuthnOptionsView
  }

  async passkeyLoginVerify(input: {
    sessionRef: unknown
    rpId: unknown
    origin: unknown
    response: unknown
  }): Promise<UserView> {
    const session = this.#requireTwoFactorSession(input.sessionRef)
    const credentials = this.#passkeys(session.userId)
    if (credentials.length === 0) throw new WakerError('passkey_not_found', '该账号未注册 Passkey')

    const state = getTempState(this.sql, `passkey_auth:${session.ref}`, this.now())
    const challenge = typeof state?.challenge === 'string' ? state.challenge : ''
    if (challenge.length === 0) {
      throw new WakerError('two_factor_invalid', '没有待验证的 Passkey 挑战')
    }

    const response = input.response as { id?: unknown } | null
    const credentialId = typeof response?.id === 'string' ? response.id : ''
    const credential = credentials.find((item) => item.id === credentialId)
    if (credential === undefined) {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }

    // 断言结构非法时 `@simplewebauthn/server` 会抛错：一律折算成验码失败（400/401 面的错误），
    // 不让畸形输入变成 500，也不计入「成功」。
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response as never,
        expectedChallenge: challenge,
        expectedOrigin: String(input.origin ?? ''),
        expectedRPID: String(input.rpId ?? ''),
        credential: {
          id: credential!.id,
          publicKey: Uint8Array.from(atob(credential!.publicKey), (char) => char.charCodeAt(0)),
          counter: credential!.counter,
        },
      })
    } catch {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }

    if (!verification!.verified) {
      this.#recordTwoFactorFailure(session.ref, session.userId, session.fails)
    }

    credential!.counter = verification.authenticationInfo.newCounter
    this.#writePasskeys(session.userId, credentials)
    deleteTempState(this.sql, `passkey_auth:${session.ref}`)

    return this.#finishTwoFactor(session)
  }

  // ───────────────────────── 本人资料 / 设置（SPEC §5.3） ─────────────────────────

  getMe(input: { userId: string }): MeView {
    const user = requireUserRow(this.sql, input.userId)
    return {
      user: this.#toUserView(user),
      twoFactor: this.#toTwoFactorState(user.id),
      availableMethods: this.#availableMethods(user.id),
    }
  }

  /** 会话用户（鉴权中间件每次请求都读库：改角色/禁用立即生效，不等 JWT 过期）。 */
  getSessionUser(input: { userId: string }): UserView {
    const user = findUserById(this.sql, input.userId)
    if (user === null) throw new WakerError('user_not_found', '用户不存在')
    if (Number(user.is_active) !== 1) throw new WakerError('forbidden', '账号已被禁用')
    return this.#toUserView(user)
  }

  updateProfile(input: { userId: string; displayName: unknown }): MeView {
    const user = requireUserRow(this.sql, input.userId)
    const displayName = this.#requireDisplayName(input.displayName, user.display_name)
    updateUser(this.sql, user.id, { displayName, now: this.now() })
    return this.getMe({ userId: user.id })
  }

  /**
   * 改密码：必须复验当前密码（SPEC §5.3）。
   *
   * 会话是 12 小时无状态 JWT，不因改密即时失效（与 SPEC §5.2 的会话口径一致，不做服务端
   * session 吊销表）；改密只影响后续登录。
   */
  async changePassword(input: {
    userId: string
    currentPassword: unknown
    newPassword: unknown
  }): Promise<{ changed: true }> {
    await this.#requirePassword(input.userId, input.currentPassword)
    const policy = checkPasswordPolicy(input.newPassword)
    if (!policy.ok) throw new WakerError('invalid_argument', policy.message)

    const passwordHash = await hashPassword(input.newPassword as string)
    updateUser(this.sql, input.userId, { passwordHash, now: this.now() })
    return { changed: true }
  }

  // ── TOTP ──

  async totpSetupStart(input: { userId: string }): Promise<{ secret: string; uri: string }> {
    const user = requireUserRow(this.sql, input.userId)
    const row = ensureTwoFactorRow(this.sql, user.id, this.now())
    if (Number(row.totp_enabled) === 1) {
      throw new WakerError('invalid_argument', '身份验证器已启用，如需更换请先解绑')
    }

    const secret = generateTotpSecret()
    const envelope = await encryptTotpSecret(secret, await this.#totpKekKey())
    const now = this.now()

    // 旧的未确认绑定一律作废（同一用户只留一枚待确认 secret）。
    this.sql.exec(
      `DELETE FROM auth_challenges WHERE user_id = ? AND kind = 'totp_setup' AND consumed_at IS NULL`,
      user.id,
    )
    insertChallenge(this.sql, {
      id: this.#newId(),
      userId: user.id,
      kind: 'totp_setup',
      sessionRef: null,
      // 该列在 totp_setup 语义下存的是 secret 的密文信封（非明文，见 schema 注释）。
      codeHash: envelope,
      expiresAt: now + TOTP_SETUP_TTL_MS,
      now,
    })

    return { secret, uri: totpUri(secret, user.email) }
  }

  async totpSetupConfirm(input: { userId: string; code: unknown }): Promise<MeView> {
    const user = requireUserRow(this.sql, input.userId)
    const challenge = findActiveChallenge(this.sql, {
      userId: user.id,
      kind: 'totp_setup',
      sessionRef: null,
      now: this.now(),
    })
    if (challenge === null) throw new WakerError('invalid_argument', '没有待确认的身份验证器绑定')

    const secret = await decryptTotpSecret(challenge.code_hash, await this.#totpKekKey())
    if (secret === null) throw new WakerError('internal', '身份验证器密钥不可读')

    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (verifyTotpCode(secret, user.email, code) === null) {
      throw new WakerError('two_factor_invalid', '验证码不正确')
    }

    consumeChallenge(this.sql, challenge.id, this.now())
    updateTwoFactor(this.sql, user.id, {
      totpSecret: challenge.code_hash,
      totpEnabled: true,
      now: this.now(),
    })
    this.#reconcilePreferred(user.id)
    return this.getMe({ userId: user.id })
  }

  async totpDisable(input: { userId: string; password: unknown }): Promise<MeView> {
    await this.#requirePassword(input.userId, input.password)
    updateTwoFactor(this.sql, input.userId, {
      totpSecret: null,
      totpEnabled: false,
      now: this.now(),
    })
    this.sql.exec(
      `DELETE FROM auth_challenges WHERE user_id = ? AND kind = 'totp_setup'`,
      input.userId,
    )
    this.#reconcilePreferred(input.userId)
    return this.getMe({ userId: input.userId })
  }

  // ── 邮件 OTP（enable 必须先验码；未配 provider 明确挡住，不静默置位） ──

  async emailOtpSetupSend(input: { userId: string }): Promise<OneTimeCodeView> {
    const user = requireUserRow(this.sql, input.userId)
    if (readEmailProvider(this.sql) === 'none') {
      throw new WakerError('email_not_configured', '管理员尚未配置邮件服务，此方法暂不可用')
    }
    this.#enforceRateLimit('otp_setup_send', user.id, OTP_SEND_RATE)

    const code = this.#generateSixDigitCode()
    const now = this.now()
    const challengeId = this.#newId()
    insertChallenge(this.sql, {
      id: challengeId,
      userId: user.id,
      kind: 'email_otp',
      sessionRef: 'email_otp_setup',
      codeHash: await hashOneTimeCode(
        await this.#pepperKey(),
        `email_otp:${user.id}:email_otp_setup:${code}`,
      ),
      expiresAt: now + EMAIL_OTP_TTL_MS,
      now,
    })
    return { challengeId, code, email: user.email, expiresAt: now + EMAIL_OTP_TTL_MS }
  }

  async emailOtpEnable(input: { userId: string; code: unknown }): Promise<MeView> {
    const user = requireUserRow(this.sql, input.userId)
    if (readEmailProvider(this.sql) === 'none') {
      throw new WakerError('email_not_configured', '管理员尚未配置邮件服务，此方法暂不可用')
    }

    const challenge = findActiveChallenge(this.sql, {
      userId: user.id,
      kind: 'email_otp',
      sessionRef: 'email_otp_setup',
      now: this.now(),
    })
    if (challenge === null) throw new WakerError('two_factor_invalid', '没有待验证的邮件验证码')

    const code = typeof input.code === 'string' ? input.code.trim() : ''
    const codeHash = await hashOneTimeCode(
      await this.#pepperKey(),
      `email_otp:${user.id}:email_otp_setup:${code}`,
    )
    if (codeHash !== challenge.code_hash) {
      throw new WakerError('two_factor_invalid', '验证码不正确')
    }

    consumeChallenge(this.sql, challenge.id, this.now())
    updateTwoFactor(this.sql, user.id, { emailOtpEnabled: true, now: this.now() })
    this.#reconcilePreferred(user.id)
    return this.getMe({ userId: user.id })
  }

  async emailOtpDisable(input: { userId: string; password: unknown }): Promise<MeView> {
    await this.#requirePassword(input.userId, input.password)
    updateTwoFactor(this.sql, input.userId, { emailOtpEnabled: false, now: this.now() })
    this.#reconcilePreferred(input.userId)
    return this.getMe({ userId: input.userId })
  }

  // ── Passkey ──

  async passkeyRegisterOptions(input: {
    userId: string
    rpId: unknown
  }): Promise<WebAuthnOptionsView> {
    const user = requireUserRow(this.sql, input.userId)
    const rpId = typeof input.rpId === 'string' && input.rpId.length > 0 ? input.rpId : ''
    if (rpId.length === 0) throw new WakerError('invalid_argument', '缺少 rpId')
    this.#enforceRateLimit('passkey', user.id, PASSKEY_RATE)

    const options = await generateRegistrationOptions({
      rpName: 'waker',
      rpID: rpId,
      userName: user.email,
      userDisplayName: user.display_name.length > 0 ? user.display_name : user.email,
      attestationType: 'none',
      excludeCredentials: this.#passkeys(user.id).map((credential) => ({
        id: credential.id,
        type: 'public-key',
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    })

    putTempState(this.sql, `passkey_reg:${user.id}`, {
      challenge: options.challenge,
      expiresAt: this.now() + PASSKEY_CHALLENGE_TTL_MS,
    })
    return options as unknown as WebAuthnOptionsView
  }

  async passkeyRegisterVerify(input: {
    userId: string
    rpId: unknown
    origin: unknown
    response: unknown
    name: unknown
  }): Promise<PasskeyView> {
    const user = requireUserRow(this.sql, input.userId)
    const state = getTempState(this.sql, `passkey_reg:${user.id}`, this.now())
    const challenge = typeof state?.challenge === 'string' ? state.challenge : ''
    if (challenge.length === 0) throw new WakerError('two_factor_invalid', '没有待验证的 Passkey 注册挑战')

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verification = await verifyRegistrationResponse({
        response: input.response as never,
        expectedChallenge: challenge,
        expectedOrigin: String(input.origin ?? ''),
        expectedRPID: String(input.rpId ?? ''),
      })
    } catch {
      throw new WakerError('two_factor_invalid', 'Passkey 注册校验失败')
    }
    if (!verification.verified || verification.registrationInfo === undefined) {
      throw new WakerError('two_factor_invalid', 'Passkey 注册校验失败')
    }

    const { credential } = verification.registrationInfo
    const name =
      typeof input.name === 'string' && input.name.trim().length > 0
        ? input.name.trim().slice(0, MAX_PASSKEY_NAME_LENGTH)
        : `Passkey ${this.#passkeys(user.id).length + 1}`

    const credentials = this.#passkeys(user.id)
    const stored: PasskeyCredential = {
      id: credential.id,
      publicKey: btoa(String.fromCharCode(...new Uint8Array(credential.publicKey))),
      counter: credential.counter,
      name,
      createdAt: this.now(),
    }
    credentials.push(stored)
    this.#writePasskeys(user.id, credentials)
    deleteTempState(this.sql, `passkey_reg:${user.id}`)
    this.#reconcilePreferred(user.id)

    return this.#toPasskeyView(stored)
  }

  listPasskeys(input: { userId: string }): { passkeys: PasskeyView[] } {
    return { passkeys: this.#passkeys(input.userId).map((credential) => this.#toPasskeyView(credential)) }
  }

  renamePasskey(input: { userId: string; credentialId: string; name: unknown }): { passkeys: PasskeyView[] } {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new WakerError('invalid_argument', '名称不能为空')
    }
    const credentials = this.#passkeys(input.userId)
    const target = credentials.find((credential) => credential.id === input.credentialId)
    if (target === undefined) throw new WakerError('passkey_not_found', 'Passkey 不存在')
    target.name = input.name.trim().slice(0, MAX_PASSKEY_NAME_LENGTH)
    this.#writePasskeys(input.userId, credentials)
    return this.listPasskeys({ userId: input.userId })
  }

  async deletePasskey(input: {
    userId: string
    credentialId: string
    password: unknown
  }): Promise<{ passkeys: PasskeyView[] }> {
    await this.#requirePassword(input.userId, input.password)
    const credentials = this.#passkeys(input.userId)
    const filtered = credentials.filter((credential) => credential.id !== input.credentialId)
    if (filtered.length === credentials.length) throw new WakerError('passkey_not_found', 'Passkey 不存在')
    this.#writePasskeys(input.userId, filtered)
    this.#reconcilePreferred(input.userId)
    return this.listPasskeys({ userId: input.userId })
  }

  setPreferredMethod(input: { userId: string; method: TwoFactorMethod }): MeView {
    const available = this.#availableMethods(input.userId)
    if (!available.includes(input.method)) {
      throw new WakerError('invalid_argument', `不能把未启用的方法设为默认（可用：${available.map((m) => METHOD_LABELS[m]).join('、') || '无'}）`)
    }
    updateTwoFactor(this.sql, input.userId, { preferredMethod: input.method, now: this.now() })
    return this.getMe({ userId: input.userId })
  }

  // ───────────────────────── 用户管理（仅 admin，防自锁） ─────────────────────────

  listUsers(): { users: UserView[] } {
    return { users: listUserRows(this.sql).map((row) => this.#toUserView(row)) }
  }

  updateUser(input: UpdateUserInput): UserView {
    this.#requireAdmin(input.actorId)
    const target = requireUserRow(this.sql, input.userId)

    if (input.role !== undefined && input.role !== 'admin' && input.role !== 'viewer') {
      throw new WakerError('invalid_argument', "role 只能是 'admin' 或 'viewer'")
    }

    const losingAdmin =
      target.role === 'admin' &&
      Number(target.is_active) === 1 &&
      ((input.role !== undefined && input.role !== 'admin') || input.isActive === false)
    if (losingAdmin && countAdmins(this.sql) <= 1) {
      throw new WakerError('forbidden', '最后一个管理员不能被降级或禁用')
    }

    updateUser(this.sql, target.id, {
      ...(input.role === undefined ? {} : { role: input.role as UserRole }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      now: this.now(),
    })
    return this.#toUserView(requireUserRow(this.sql, target.id))
  }

  deleteUser(input: { actorId: string; userId: string }): { deleted: true } {
    this.#requireAdmin(input.actorId)
    const target = requireUserRow(this.sql, input.userId)
    if (target.role === 'admin' && Number(target.is_active) === 1 && countAdmins(this.sql) <= 1) {
      throw new WakerError('forbidden', '最后一个管理员不能被删除')
    }
    deleteUser(this.sql, target.id)
    return { deleted: true }
  }

  // ───────────────────────── 系统设置：注册开关 + 邮件服务（仅 admin） ─────────────────────────

  getSystemSettings(): SystemSettingsView {
    return {
      registrationEnabled: readRegistrationEnabled(this.sql),
      email: this.#emailSettingsView(),
    }
  }

  #emailSettingsView(): EmailSettingsView {
    const provider = readEmailProvider(this.sql)
    const smtpRaw = readJsonMeta(this.sql, SMTP_CONFIG_KEY) ?? {}
    const resendRaw = readJsonMeta(this.sql, RESEND_CONFIG_KEY) ?? {}

    return {
      provider,
      smtp: {
        host: typeof smtpRaw.host === 'string' ? smtpRaw.host : '',
        port: Number(smtpRaw.port ?? 587),
        username: typeof smtpRaw.username === 'string' ? smtpRaw.username : '',
        from: typeof smtpRaw.from === 'string' ? smtpRaw.from : '',
        fromName: typeof smtpRaw.fromName === 'string' ? smtpRaw.fromName : '',
        secure: smtpRaw.secure === true,
        // 只报「配没配」，不回声任何一段密文/明文。
        passwordConfigured: typeof smtpRaw.password === 'string' && smtpRaw.password.length > 0,
      },
      resend: {
        from: typeof resendRaw.from === 'string' ? resendRaw.from : '',
        fromName: typeof resendRaw.fromName === 'string' ? resendRaw.fromName : '',
        apiKeyConfigured: typeof resendRaw.apiKey === 'string' && resendRaw.apiKey.length > 0,
      },
    }
  }

  setRegistrationEnabled(input: { actorId: string; enabled: boolean }): SystemSettingsView {
    this.#requireAdmin(input.actorId)
    writeRegistrationEnabled(this.sql, input.enabled === true)
    return this.getSystemSettings()
  }

  /**
   * 保存邮件服务配置：密码 / API Key 用独立 KEK 的信封落库；
   * 入参留空 = 不改（照 eNotify 现行做法），显式空串同样视为不改。
   */
  async updateEmailSettings(input: { actorId: string; settings: UpdateEmailSettingsInput }): Promise<SystemSettingsView> {
    this.#requireAdmin(input.actorId)

    const provider = input.settings.provider
    if (!isEmailProvider(provider)) {
      throw new WakerError('invalid_argument', "email_provider 只能是 none / smtp / resend")
    }

    const smtpRaw = readJsonMeta(this.sql, SMTP_CONFIG_KEY) ?? {}
    const resendRaw = readJsonMeta(this.sql, RESEND_CONFIG_KEY) ?? {}
    const kek = await this.#emailKekKey()

    const smtp = input.settings.smtp
    if (smtp !== undefined) {
      const next = { ...smtpRaw }
      assignIfPresent(next, 'host', smtp.host)
      assignIfPresent(next, 'username', smtp.username)
      assignIfPresent(next, 'from', smtp.from)
      assignIfPresent(next, 'fromName', smtp.fromName)
      if (smtp.port !== undefined) {
        const port = Number(smtp.port)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new WakerError('invalid_argument', 'SMTP 端口必须是 1–65535 的整数')
        }
        next.port = port
      }
      if (smtp.secure !== undefined) next.secure = smtp.secure === true
      if (typeof smtp.password === 'string' && smtp.password.length > 0) {
        next.password = await encryptEmailSecret(smtp.password, kek)
      }
      writeJsonMeta(this.sql, SMTP_CONFIG_KEY, next)
    }

    const resend = input.settings.resend
    if (resend !== undefined) {
      const next = { ...resendRaw }
      assignIfPresent(next, 'from', resend.from)
      assignIfPresent(next, 'fromName', resend.fromName)
      if (typeof resend.apiKey === 'string' && resend.apiKey.length > 0) {
        next.apiKey = await encryptEmailSecret(resend.apiKey, kek)
      }
      writeJsonMeta(this.sql, RESEND_CONFIG_KEY, next)
    }

    writeEmailProvider(this.sql, provider)
    return this.getSystemSettings()
  }

  /** 发送侧配置（含解密后的明文凭据）：只在 DO → Worker 的内存里出现。 */
  async getEmailSendConfig(): Promise<EmailSendConfig> {
    const provider = readEmailProvider(this.sql)
    if (provider === 'none') return { provider, smtp: null, resend: null }

    const kek = await this.#emailKekKey()
    const smtpRaw = readJsonMeta(this.sql, SMTP_CONFIG_KEY) ?? {}
    const resendRaw = readJsonMeta(this.sql, RESEND_CONFIG_KEY) ?? {}

    const smtpPassword = typeof smtpRaw.password === 'string' && smtpRaw.password.length > 0
      ? await decryptEmailSecret(smtpRaw.password, kek)
      : ''
    const apiKey = typeof resendRaw.apiKey === 'string' && resendRaw.apiKey.length > 0
      ? await decryptEmailSecret(resendRaw.apiKey, kek)
      : ''

    return {
      provider,
      smtp:
        provider === 'smtp'
          ? {
              host: typeof smtpRaw.host === 'string' ? smtpRaw.host : '',
              port: Number(smtpRaw.port ?? 587),
              username: typeof smtpRaw.username === 'string' ? smtpRaw.username : '',
              password: smtpPassword ?? '',
              from: typeof smtpRaw.from === 'string' ? smtpRaw.from : '',
              fromName: typeof smtpRaw.fromName === 'string' ? smtpRaw.fromName : '',
              secure: smtpRaw.secure === true,
            }
          : null,
      resend:
        provider === 'resend'
          ? {
              apiKey: apiKey ?? '',
              from: typeof resendRaw.from === 'string' ? resendRaw.from : '',
              fromName: typeof resendRaw.fromName === 'string' ? resendRaw.fromName : '',
            }
          : null,
    }
  }

  /** watchdog tick 顺带清理（不新增 Cron）：过期的挑战、已消费的挑战、过期的临时状态。 */
  prune(now: number = this.now()): { challenges: number; tempStates: number } {
    return {
      challenges: pruneAuthChallenges(this.sql, now),
      tempStates: pruneTempState(this.sql, now),
    }
  }
}

function assignIfPresent(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (typeof value !== 'string' || value.length === 0) return
  target[key] = value.trim()
}
