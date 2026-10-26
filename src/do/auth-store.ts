import { WakerError } from './errors'
import { readMeta, writeMeta } from './schema'
import type { EmailProvider, TwoFactorMethod, UserRole } from './auth-types'

/**
 * 用户体系的数据访问层（只有 SQL，不碰加密、不碰业务判定）。
 *
 * 表：`users` / `user_2fa` / `auth_challenges`（v4 迁移，见 `schema.ts`），
 * 配置与一次性临时状态放 `waker_meta`（键前缀见下）。
 *
 * 为什么临时状态放 `waker_meta` 而不是新表：SPEC §2 把 v4 的表与 `auth_challenges.kind`
 * 都冻结成固定集合（`email_otp` / `totp_used` / `totp_setup`），而 §3 又允许 bootstrap 令牌
 * 「存 `auth_challenges` 同表**或等价的一次性状态**」。这里的做法就是后者：
 * 一次性状态统一为 `waker_meta` 里的 `auth_tmp:*` 键（值为 JSON，含 `expiresAt`），
 * 由 watchdog tick 统一清理，既不新增表、不新增 Cron，也不改冻结的 CHECK 集合。
 */

/** 临时状态 / 限流计数统一前缀（watchdog tick 按前缀清理过期项）。 */
export const AUTH_TMP_PREFIX = 'auth_tmp:'

export const REGISTRATION_ENABLED_KEY = 'registration_enabled'
export const EMAIL_PROVIDER_KEY = 'email_provider'
export const SMTP_CONFIG_KEY = 'smtp_config'
export const RESEND_CONFIG_KEY = 'resend_config'

export interface UserRow extends Record<string, string | number | null> {
  id: string
  email: string
  password_hash: string
  display_name: string
  role: string
  is_active: number
  created_at: number
  updated_at: number
  last_login_at: number | null
}

export interface TwoFactorRow extends Record<string, string | number | null> {
  user_id: string
  totp_secret: string | null
  totp_enabled: number
  passkey_credentials: string
  passkey_enabled: number
  email_otp_enabled: number
  preferred_method: string | null
  updated_at: number
}

export interface ChallengeRow extends Record<string, string | number | null> {
  id: string
  user_id: string
  kind: string
  session_ref: string | null
  code_hash: string
  expires_at: number
  consumed_at: number | null
  created_at: number
}

export type ChallengeKind = 'email_otp' | 'totp_used' | 'totp_setup'

/** 邮箱规范化：小写 + 去首尾空白（SPEC §2 的 `users.email` 小写规范化）。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'viewer'
}

export function isTwoFactorMethod(value: unknown): value is TwoFactorMethod {
  return value === 'totp' || value === 'email_otp' || value === 'passkey'
}

export function isEmailProvider(value: unknown): value is EmailProvider {
  return value === 'none' || value === 'smtp' || value === 'resend'
}

// ───────────────────────── users ─────────────────────────

export function countUsers(sql: SqlStorage): number {
  return Number(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM users').one().n)
}

export function countAdmins(sql: SqlStorage): number {
  return Number(
    sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1`,
    ).one().n,
  )
}

export function findUserById(sql: SqlStorage, userId: string): UserRow | null {
  const rows = sql.exec<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1', userId).toArray()
  return rows[0] ?? null
}

export function findUserByEmail(sql: SqlStorage, email: string): UserRow | null {
  const rows = sql
    .exec<UserRow>('SELECT * FROM users WHERE email = ? LIMIT 1', normalizeEmail(email))
    .toArray()
  return rows[0] ?? null
}

export function requireUserRow(sql: SqlStorage, userId: string): UserRow {
  const row = findUserById(sql, userId)
  if (row === null) throw new WakerError('user_not_found', `用户不存在：${userId}`)
  return row
}

export function listUserRows(sql: SqlStorage): UserRow[] {
  return sql.exec<UserRow>('SELECT * FROM users ORDER BY created_at, id').toArray()
}

export interface InsertUserParams {
  id: string
  email: string
  passwordHash: string
  displayName: string
  role: UserRole
  isActive: boolean
  now: number
}

export function insertUser(sql: SqlStorage, params: InsertUserParams): void {
  sql.exec(
    `INSERT INTO users (
       id, email, password_hash, display_name, role, is_active, created_at, updated_at, last_login_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params.id,
    normalizeEmail(params.email),
    params.passwordHash,
    params.displayName,
    params.role,
    params.isActive ? 1 : 0,
    params.now,
    params.now,
  )
}

export interface UpdateUserParams {
  role?: UserRole
  isActive?: boolean
  displayName?: string
  passwordHash?: string
  lastLoginAt?: number
  now: number
}

export function updateUser(sql: SqlStorage, userId: string, params: UpdateUserParams): void {
  const sets: string[] = []
  const bindings: (string | number)[] = []
  const push = (column: string, value: string | number): void => {
    sets.push(`${column} = ?`)
    bindings.push(value)
  }

  if (params.role !== undefined) push('role', params.role)
  if (params.isActive !== undefined) push('is_active', params.isActive ? 1 : 0)
  if (params.displayName !== undefined) push('display_name', params.displayName)
  if (params.passwordHash !== undefined) push('password_hash', params.passwordHash)
  if (params.lastLoginAt !== undefined) push('last_login_at', params.lastLoginAt)
  if (sets.length === 0) return

  push('updated_at', params.now)
  bindings.push(userId)
  sql.exec(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...bindings)
}

export function deleteUser(sql: SqlStorage, userId: string): void {
  sql.exec('DELETE FROM user_2fa WHERE user_id = ?', userId)
  sql.exec('DELETE FROM auth_challenges WHERE user_id = ?', userId)
  sql.exec('DELETE FROM users WHERE id = ?', userId)
}

// ───────────────────────── user_2fa ─────────────────────────

export function findTwoFactorRow(sql: SqlStorage, userId: string): TwoFactorRow | null {
  const rows = sql
    .exec<TwoFactorRow>('SELECT * FROM user_2fa WHERE user_id = ? LIMIT 1', userId)
    .toArray()
  return rows[0] ?? null
}

/** 取该用户 2FA 行；不存在就建一行空配置（幂等）。 */
export function ensureTwoFactorRow(sql: SqlStorage, userId: string, now: number): TwoFactorRow {
  const existing = findTwoFactorRow(sql, userId)
  if (existing !== null) return existing
  sql.exec(
    `INSERT INTO user_2fa (
       user_id, totp_secret, totp_enabled, passkey_credentials, passkey_enabled,
       email_otp_enabled, preferred_method, updated_at
     ) VALUES (?, NULL, 0, '[]', 0, 0, NULL, ?)`,
    userId,
    now,
  )
  return findTwoFactorRow(sql, userId)!
}

export interface UpdateTwoFactorParams {
  totpSecret?: string | null
  totpEnabled?: boolean
  passkeyCredentials?: string
  passkeyEnabled?: boolean
  emailOtpEnabled?: boolean
  /** `null` 表示清空偏好。 */
  preferredMethod?: TwoFactorMethod | null
  now: number
}

export function updateTwoFactor(sql: SqlStorage, userId: string, params: UpdateTwoFactorParams): void {
  ensureTwoFactorRow(sql, userId, params.now)

  const sets: string[] = []
  const bindings: (string | number | null)[] = []
  const push = (column: string, value: string | number | null): void => {
    sets.push(`${column} = ?`)
    bindings.push(value)
  }

  if (params.totpSecret !== undefined) push('totp_secret', params.totpSecret)
  if (params.totpEnabled !== undefined) push('totp_enabled', params.totpEnabled ? 1 : 0)
  if (params.passkeyCredentials !== undefined) push('passkey_credentials', params.passkeyCredentials)
  if (params.passkeyEnabled !== undefined) push('passkey_enabled', params.passkeyEnabled ? 1 : 0)
  if (params.emailOtpEnabled !== undefined) push('email_otp_enabled', params.emailOtpEnabled ? 1 : 0)
  if (params.preferredMethod !== undefined) push('preferred_method', params.preferredMethod)
  if (sets.length === 0) return

  push('updated_at', params.now)
  bindings.push(userId)
  sql.exec(`UPDATE user_2fa SET ${sets.join(', ')} WHERE user_id = ?`, ...bindings)
}

// ───────────────────────── auth_challenges ─────────────────────────

export interface InsertChallengeParams {
  id: string
  userId: string
  kind: ChallengeKind
  sessionRef: string | null
  codeHash: string
  expiresAt: number
  now: number
}

export function insertChallenge(sql: SqlStorage, params: InsertChallengeParams): void {
  sql.exec(
    `INSERT INTO auth_challenges (
       id, user_id, kind, session_ref, code_hash, expires_at, consumed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    params.id,
    params.userId,
    params.kind,
    params.sessionRef,
    params.codeHash,
    params.expiresAt,
    params.now,
  )
}

/** 取最近一条未消费、未过期的挑战（email_otp / totp_setup 用）。 */
export function findActiveChallenge(
  sql: SqlStorage,
  params: { userId: string; kind: ChallengeKind; sessionRef: string | null; now: number },
): ChallengeRow | null {
  const rows = sql
    .exec<ChallengeRow>(
      `SELECT * FROM auth_challenges
       WHERE user_id = ? AND kind = ? AND session_ref IS ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
      params.userId,
      params.kind,
      params.sessionRef,
      params.now,
    )
    .toArray()
  return rows[0] ?? null
}

export function findChallengeById(sql: SqlStorage, challengeId: string): ChallengeRow | null {
  const rows = sql
    .exec<ChallengeRow>('SELECT * FROM auth_challenges WHERE id = ? LIMIT 1', challengeId)
    .toArray()
  return rows[0] ?? null
}

export function consumeChallenge(sql: SqlStorage, challengeId: string, now: number): void {
  sql.exec('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?', now, challengeId)
}

export function deleteChallenge(sql: SqlStorage, challengeId: string): void {
  sql.exec('DELETE FROM auth_challenges WHERE id = ?', challengeId)
}

/** 用过的 TOTP 码是否还在防重放窗口内（SPEC §2：码用过即记，90 秒失效）。 */
export function hasUsedTotpCode(
  sql: SqlStorage,
  params: { userId: string; codeHash: string; now: number },
): boolean {
  const rows = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM auth_challenges
       WHERE user_id = ? AND kind = 'totp_used' AND code_hash = ? AND expires_at > ?`,
      params.userId,
      params.codeHash,
      params.now,
    )
    .toArray()
  return Number(rows[0]?.n ?? 0) > 0
}

/** watchdog tick 顺带清理：过期的、以及早已消费掉的一次性挑战。 */
export function pruneAuthChallenges(sql: SqlStorage, now: number): number {
  const expired = Number(
    sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM auth_challenges WHERE expires_at <= ?', now)
      .one().n,
  )
  sql.exec('DELETE FROM auth_challenges WHERE expires_at <= ?', now)
  sql.exec('DELETE FROM auth_challenges WHERE consumed_at IS NOT NULL AND consumed_at <= ?', now)
  return expired
}

// ───────────────────────── waker_meta：临时状态 / 限流 ─────────────────────────

export interface TempState {
  expiresAt: number
  [key: string]: unknown
}

export function putTempState(sql: SqlStorage, key: string, state: TempState): void {
  writeMeta(sql, `${AUTH_TMP_PREFIX}${key}`, JSON.stringify(state))
}

/** 读临时状态；不存在或已过期都返回 null（过期项顺手删掉）。 */
export function getTempState(sql: SqlStorage, key: string, now: number): Record<string, unknown> | null {
  const raw = readMeta(sql, `${AUTH_TMP_PREFIX}${key}`)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const expiresAt = Number(parsed.expiresAt ?? 0)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      deleteTempState(sql, key)
      return null
    }
    return parsed
  } catch {
    deleteTempState(sql, key)
    return null
  }
}

export function deleteTempState(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM waker_meta WHERE key = ?', `${AUTH_TMP_PREFIX}${key}`)
}

/** 清理过期临时状态（watchdog tick 调用，不新增 Cron）。 */
export function pruneTempState(sql: SqlStorage, now: number): number {
  const rows = sql
    .exec<{ key: string; value: string }>(
      `SELECT key, value FROM waker_meta WHERE key LIKE ?`,
      `${AUTH_TMP_PREFIX}%`,
    )
    .toArray()

  let removed = 0
  for (const row of rows) {
    const expired = (() => {
      try {
        const parsed = JSON.parse(row.value) as { expiresAt?: unknown }
        const expiresAt = Number(parsed.expiresAt ?? 0)
        return !Number.isFinite(expiresAt) || expiresAt <= now
      } catch {
        return true
      }
    })()
    if (!expired) continue
    sql.exec('DELETE FROM waker_meta WHERE key = ?', row.key)
    removed += 1
  }
  return removed
}

export interface RateLimitResult {
  allowed: boolean
  /** 命中限流时：还要等多少秒（向上取整）。 */
  retryAfterSeconds: number
}

/**
 * 固定窗口计数限流（照 eNotify `middleware/ratelimit.ts` 的语义：`max` 次 / `windowMs`）。
 *
 * 计数落 `waker_meta`（DO 是真源，天然串行），键 `auth_tmp:rl:<scope>:<key>`。
 * 与 eNotify 的差别只有存储介质（不引 KV），算法一致。
 */
export function hitRateLimit(
  sql: SqlStorage,
  params: { scope: string; key: string; max: number; windowMs: number; now: number },
): RateLimitResult {
  const stateKey = `rl:${params.scope}:${params.key}`
  const existing = getTempState(sql, stateKey, params.now)
  const count = existing === null ? 0 : Number(existing.count ?? 0)

  if (count >= params.max) {
    const expiresAt = Number(existing?.expiresAt ?? params.now)
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - params.now) / 1000)),
    }
  }

  const expiresAt = existing === null ? params.now + params.windowMs : Number(existing.expiresAt)
  putTempState(sql, stateKey, { count: count + 1, expiresAt })
  return { allowed: true, retryAfterSeconds: 0 }
}

// ───────────────────────── waker_meta：系统配置 ─────────────────────────

export function readRegistrationEnabled(sql: SqlStorage): boolean {
  return readMeta(sql, REGISTRATION_ENABLED_KEY) === '1'
}

export function writeRegistrationEnabled(sql: SqlStorage, enabled: boolean): void {
  writeMeta(sql, REGISTRATION_ENABLED_KEY, enabled ? '1' : '0')
}

export function readEmailProvider(sql: SqlStorage): EmailProvider {
  const raw = readMeta(sql, EMAIL_PROVIDER_KEY)
  return isEmailProvider(raw) ? raw : 'none'
}

export function writeEmailProvider(sql: SqlStorage, provider: EmailProvider): void {
  writeMeta(sql, EMAIL_PROVIDER_KEY, provider)
}

export function readJsonMeta(sql: SqlStorage, key: string): Record<string, unknown> | null {
  const raw = readMeta(sql, key)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function writeJsonMeta(sql: SqlStorage, key: string, value: Record<string, unknown>): void {
  writeMeta(sql, key, JSON.stringify(value))
}
