import { WakerError } from './errors'
import { fingerprintFromHash } from './keyring'
import type { ProjectSigningKeyView, ProjectStatus, ProjectView } from './types'

/**
 * 项目与凭据的**数据访问层**（只有 SQL，不碰加密）。
 *
 * 分工：`WakerDO` 负责生成/加密/解密（`keyring.ts`）与 RPC 信封，
 * 这里只负责「怎么读写 projects / signing_keys 两张表」，便于单独测。
 *
 * 落库不变量（B4 冻结，评审按这两条核）：
 *   1. `projects.token_hash` 是唯一的令牌落库形态，任何路径都不得写入令牌明文。
 *   2. `signing_keys.secret` 自 v3 起只存 AES-GCM 信封（`waker-enc:v1:...`），
 *      明文只在 DO 内存里出现。
 */

export interface ProjectRow extends Record<string, string | number | null> {
  id: string
  name: string
  callback_url: string | null
  token_hash: string | null
  token_created_at: number | null
  token_rotated_at: number | null
  status: string
  created_at: number
  updated_at: number
}

export interface SigningKeyRow extends Record<string, string | number | null> {
  id: string
  project_id: string
  /** 自 v3 起是 AES-GCM 信封，不是明文。 */
  secret: string
  fingerprint: string | null
  algorithm: string | null
  created_at: number
  rotated_at: number | null
  revoked_at: number | null
}

/** 令牌哈希掩码（`tokenFingerprint`）。 */
export function tokenFingerprint(tokenHash: string | null): string | null {
  return tokenHash === null || tokenHash.length === 0 ? null : fingerprintFromHash(tokenHash)
}

export function signingKeyView(row: SigningKeyRow): ProjectSigningKeyView {
  return {
    id: row.id,
    algorithm: row.algorithm ?? 'HMAC-SHA256',
    fingerprint: row.fingerprint ?? '',
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  }
}

export function toProjectView(row: ProjectRow, signingKey: SigningKeyRow | null): ProjectView {
  return {
    id: row.id,
    name: row.name,
    callbackUrl: row.callback_url ?? '',
    status: (row.status === 'revoked' ? 'revoked' : 'active') satisfies ProjectStatus,
    tokenFingerprint: tokenFingerprint(row.token_hash),
    tokenCreatedAt: row.token_created_at,
    tokenRotatedAt: row.token_rotated_at,
    signingKey: signingKey === null ? null : signingKeyView(signingKey),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listProjectRows(sql: SqlStorage): ProjectRow[] {
  return sql
    .exec<ProjectRow>(`SELECT * FROM projects ORDER BY created_at, id`)
    .toArray()
}

export function findProjectRow(sql: SqlStorage, projectId: string): ProjectRow | null {
  const rows = sql
    .exec<ProjectRow>('SELECT * FROM projects WHERE id = ? LIMIT 1', projectId)
    .toArray()
  return rows[0] ?? null
}

export function requireProjectRow(sql: SqlStorage, projectId: string): ProjectRow {
  const row = findProjectRow(sql, projectId)
  if (row === null) throw new WakerError('project_not_found', `项目不存在：${projectId}`)
  return row
}

export function findProjectRowByName(sql: SqlStorage, name: string): ProjectRow | null {
  const rows = sql
    .exec<ProjectRow>('SELECT * FROM projects WHERE name = ? LIMIT 1', name)
    .toArray()
  return rows[0] ?? null
}

export function findProjectRowByTokenHash(sql: SqlStorage, tokenHash: string): ProjectRow | null {
  const rows = sql
    .exec<ProjectRow>('SELECT * FROM projects WHERE token_hash = ? LIMIT 1', tokenHash)
    .toArray()
  return rows[0] ?? null
}

export interface InsertProjectParams {
  id: string
  name: string
  callbackUrl: string
  tokenHash: string
  now: number
}

export function insertProject(sql: SqlStorage, params: InsertProjectParams): void {
  sql.exec(
    `INSERT INTO projects (
       id, name, callback_url, token_hash, token_created_at, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    params.id,
    params.name,
    params.callbackUrl,
    params.tokenHash,
    params.now,
    params.now,
    params.now,
  )
}

export function updateProjectRow(
  sql: SqlStorage,
  projectId: string,
  patch: { name?: string; callbackUrl?: string },
  now: number,
): void {
  if (patch.name !== undefined) {
    sql.exec('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', patch.name, now, projectId)
  }
  if (patch.callbackUrl !== undefined) {
    sql.exec(
      'UPDATE projects SET callback_url = ?, updated_at = ? WHERE id = ?',
      patch.callbackUrl,
      now,
      projectId,
    )
  }
}

/** 令牌轮换：覆盖哈希（旧令牌立即失效，明文永远不落库）。 */
export function updateProjectTokenHash(
  sql: SqlStorage,
  projectId: string,
  tokenHash: string,
  now: number,
): void {
  sql.exec(
    `UPDATE projects
     SET token_hash = ?, token_created_at = ?, token_rotated_at = ?, updated_at = ?
     WHERE id = ?`,
    tokenHash,
    now,
    now,
    now,
    projectId,
  )
}

/** 当前生效的 signing key（未撤销中最新的一把）。 */
export function currentSigningKeyRow(sql: SqlStorage, projectId: string): SigningKeyRow | null {
  const rows = sql
    .exec<SigningKeyRow>(
      `SELECT * FROM signing_keys
       WHERE project_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      projectId,
    )
    .toArray()
  return rows[0] ?? null
}

export interface InsertSigningKeyParams {
  id: string
  projectId: string
  /** AES-GCM 信封（**不是明文**）。 */
  envelope: string
  fingerprint: string
  algorithm: string
  now: number
}

export function insertSigningKey(sql: SqlStorage, params: InsertSigningKeyParams): void {
  sql.exec(
    `INSERT INTO signing_keys (id, project_id, secret, fingerprint, algorithm, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    params.id,
    params.projectId,
    params.envelope,
    params.fingerprint,
    params.algorithm,
    params.now,
  )
}

/** 轮换时把该项目的旧 key 全部标记撤销（保留行做审计，不物理删除）。 */
export function revokeSigningKeys(sql: SqlStorage, projectId: string, now: number): number {
  const revoked = sql
    .exec<{ id: string }>(
      'SELECT id FROM signing_keys WHERE project_id = ? AND revoked_at IS NULL',
      projectId,
    )
    .toArray()
  if (revoked.length === 0) return 0

  sql.exec(
    `UPDATE signing_keys SET revoked_at = ?, rotated_at = ?
     WHERE project_id = ? AND revoked_at IS NULL`,
    now,
    now,
    projectId,
  )
  return revoked.length
}

/** 项目视图（带当前 signing key 掩码信息）。 */
export function projectView(sql: SqlStorage, row: ProjectRow): ProjectView {
  return toProjectView(row, currentSigningKeyRow(sql, row.id))
}
