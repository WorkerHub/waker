import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  SIGNING_SECRET_ENVELOPE_PREFIX,
  sha256Hex,
} from '../src/do/keyring'
import type { JobView, ProjectSigningKeyView, ProjectView, SystemStatusView } from '../src/do/types'
import {
  TEST_SETUP_SECRET,
  http,
  managementToken,
  startDownstream,
  startHarness,
  waitFor,
  type TestContext,
} from './support/harness'

/**
 * B4 集成测试：注册 API + 项目管理 + watchdog 账本，**全走真 workerd 的 HTTP 入口**。
 *
 * 用本仓真实 wrangler 配置（真 DO / 真 SQLite / 真 Queue / 真中间件），不 mock 平台内部任何一环；
 * 断言同时看「HTTP 响应」与「库里的真实形态」（例如令牌只存哈希、signing key 只存密文）。
 */

let ctx: TestContext
let token: string

beforeAll(async () => {
  ctx = await startHarness()
  token = await managementToken(ctx)
})

afterAll(async () => {
  await ctx.harness.close()
})

interface IssuedProject {
  project: ProjectView
  token: string
  signingKey: ProjectSigningKeyView & { secret: string }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

let projectCounter = 0
function uniqueName(prefix: string): string {
  projectCounter += 1
  return `${prefix}-${projectCounter}`
}

async function createProject(callbackUrl = 'https://downstream.example.com'): Promise<IssuedProject> {
  const response = await http<IssuedProject>(ctx, '/api/projects', {
    method: 'POST',
    token,
    body: { name: uniqueName('项目'), callbackUrl },
  })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body
}

async function createJob(
  projectId: string,
  input: Record<string, unknown>,
): Promise<JobView> {
  const response = await http<{ job: JobView }>(ctx, '/api/jobs', {
    method: 'POST',
    token,
    body: { projectId, name: uniqueName('任务'), ...input },
  })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body.job
}

async function projectRows(projectId: string): Promise<Record<string, unknown>[]> {
  return ctx.sql.exec('SELECT * FROM projects WHERE id = ?', projectId)
}

async function signingKeyRows(projectId: string): Promise<Record<string, unknown>[]> {
  return ctx.sql.exec(
    'SELECT * FROM signing_keys WHERE project_id = ? ORDER BY created_at, id',
    projectId,
  )
}

async function jobRow(jobId: string): Promise<Record<string, unknown>> {
  const rows = await ctx.sql.exec('SELECT * FROM jobs WHERE id = ?', jobId)
  const row = rows[0]
  if (row === undefined) throw new Error(`任务不存在：${jobId}`)
  return row
}

describe('管理面鉴权（用户体系会话 JWT）', () => {
  it('healthz 不需要鉴权', async () => {
    const response = await http(ctx, '/healthz')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, service: 'waker' })
  })

  it('没有会话令牌 → 401 + 统一错误体（code = unauthorized）', async () => {
    const response = await http<ErrorBody>(ctx, '/api/projects')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('unauthorized')
  })

  it('伪造的会话令牌 → 401', async () => {
    const response = await http<ErrorBody>(ctx, '/api/projects', { token: 'not-a-jwt' })
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('unauthorized')
  })

  it('会话 JWT 是 HS256 三段式，且能访问管理面', async () => {
    const sessionToken = await managementToken(ctx)
    expect(sessionToken.split('.')).toHaveLength(3)

    const response = await http(ctx, '/api/projects', { token: sessionToken })
    expect(response.status).toBe(200)
  })

  // ONE-462：首个管理员存在后，SETUP_SECRET 通道对两个入口一律失效（SPEC §3.2 锁死语义）。
  it('已有管理员 → /api/setup 与旧 /api/auth/setup 均 403 already_initialized', async () => {
    await managementToken(ctx)

    for (const path of ['/api/setup', '/api/auth/setup']) {
      const response = await http<ErrorBody>(ctx, path, {
        method: 'POST',
        body: { setupSecret: TEST_SETUP_SECRET },
      })
      expect(response.status, path).toBe(403)
      expect(response.body.error.code).toBe('already_initialized')
    }
  })
})

describe('项目管理：创建即发放两把独立凭据', () => {
  it('创建项目：返回明文令牌与 signing key（唯一一次），库里只留哈希与密文', async () => {
    const created = await createProject()

    expect(created.token).toMatch(/^wkr_[0-9a-f]{64}$/)
    expect(created.signingKey.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(created.project.tokenFingerprint).toHaveLength(16)
    expect(created.project.signingKey?.fingerprint).toHaveLength(16)
    expect(created.project.signingKey?.algorithm).toBe('HMAC-SHA256')

    // 明文不进项目视图 / 不在响应里二次出现
    expect(JSON.stringify(created.project)).not.toContain(created.token)
    expect(JSON.stringify(created.project)).not.toContain(created.signingKey.secret)

    // 令牌只存哈希
    const [project] = await projectRows(created.project.id)
    expect(project?.token_hash).toBe(await sha256Hex(created.token))
    expect(JSON.stringify(project)).not.toContain(created.token)

    // signing key 只存加密信封
    const [key] = await signingKeyRows(created.project.id)
    expect(String(key?.secret).startsWith(SIGNING_SECRET_ENVELOPE_PREFIX)).toBe(true)
    expect(String(key?.secret)).not.toContain(created.signingKey.secret)
    expect(key?.fingerprint).toBe(created.signingKey.fingerprint)
  })

  it('列表 / 详情只回掩码：没有令牌明文，也没有 signing key 明文', async () => {
    const created = await createProject()

    const list = await http<{ projects: ProjectView[] }>(ctx, '/api/projects', { token })
    expect(list.status).toBe(200)
    const listed = list.body.projects.find((project) => project.id === created.project.id)
    expect(listed).toBeDefined()
    expect(JSON.stringify(list.body)).not.toContain(created.token)
    expect(JSON.stringify(list.body)).not.toContain(created.signingKey.secret)

    const detail = await http<{ project: ProjectView }>(
      ctx,
      `/api/projects/${created.project.id}`,
      { token },
    )
    expect(detail.status).toBe(200)
    expect(detail.body.project.tokenFingerprint).toBe(created.project.tokenFingerprint)
    expect(detail.body.project.signingKey?.id).toBe(created.signingKey.id)
    expect(JSON.stringify(detail.body)).not.toContain(created.signingKey.secret)
  })

  it('项目名校验：同名 → 409 duplicate_project；非绝对 URL → 400 invalid_argument', async () => {
    const created = await createProject()

    const duplicate = await http<ErrorBody>(ctx, '/api/projects', {
      method: 'POST',
      token,
      body: { name: created.project.name, callbackUrl: 'https://another.example.com' },
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('duplicate_project')

    const badUrl = await http<ErrorBody>(ctx, '/api/projects', {
      method: 'POST',
      token,
      body: { name: uniqueName('项目'), callbackUrl: 'not-a-url' },
    })
    expect(badUrl.status).toBe(400)
    expect(badUrl.body.error.code).toBe('invalid_argument')
  })

  it('不存在的项目 → 404 project_not_found', async () => {
    const response = await http<ErrorBody>(ctx, '/api/projects/does-not-exist', { token })
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('project_not_found')
  })

  it('令牌轮换：旧令牌立即失效，新令牌可用，掩码随之变化', async () => {
    const created = await createProject()

    const before = await http(ctx, '/v1/whoami', { token: created.token })
    expect(before.status).toBe(200)

    const rotated = await http<{ project: ProjectView; token: string }>(
      ctx,
      `/api/projects/${created.project.id}/token/rotate`,
      { method: 'POST', token },
    )
    expect(rotated.status).toBe(200)
    expect(rotated.body.token).not.toBe(created.token)
    expect(rotated.body.project.tokenFingerprint).toBe(
      (await sha256Hex(rotated.body.token)).slice(0, 16),
    )
    expect(rotated.body.project.tokenRotatedAt).not.toBeNull()

    const withOld = await http<ErrorBody>(ctx, '/v1/whoami', { token: created.token })
    expect(withOld.status).toBe(401)
    expect(withOld.body.error.code).toBe('unauthorized')

    const withNew = await http<{ project: { id: string } }>(ctx, '/v1/whoami', {
      token: rotated.body.token,
    })
    expect(withNew.status).toBe(200)
    expect(withNew.body.project.id).toBe(created.project.id)
  })

  it('signing key 轮换：旧 key 标撤销，新 key 上线，明文同样只出现一次', async () => {
    const created = await createProject()

    const rotated = await http<{ project: ProjectView; signingKey: ProjectSigningKeyView & { secret: string } }>(
      ctx,
      `/api/projects/${created.project.id}/signing-key/rotate`,
      { method: 'POST', token },
    )
    expect(rotated.status).toBe(200)
    expect(rotated.body.signingKey.id).not.toBe(created.signingKey.id)
    expect(rotated.body.signingKey.fingerprint).not.toBe(created.signingKey.fingerprint)
    expect(rotated.body.project.signingKey?.id).toBe(rotated.body.signingKey.id)

    const keys = await signingKeyRows(created.project.id)
    expect(keys).toHaveLength(2)
    const oldKey = keys.find((key) => key.id === created.signingKey.id)
    const newKey = keys.find((key) => key.id === rotated.body.signingKey.id)
    expect(oldKey?.revoked_at).not.toBeNull()
    expect(oldKey?.rotated_at).not.toBeNull()
    expect(newKey?.revoked_at).toBeNull()
    expect(String(newKey?.secret)).not.toContain(rotated.body.signingKey.secret)
  })

  it('改项目名 / 回调地址（凭据不受影响）', async () => {
    const created = await createProject()

    const updated = await http<{ project: ProjectView }>(
      ctx,
      `/api/projects/${created.project.id}`,
      { method: 'PATCH', token, body: { callbackUrl: 'https://updated.example.com/base' } },
    )
    expect(updated.status).toBe(200)
    expect(updated.body.project.callbackUrl).toBe('https://updated.example.com/base')
    expect(updated.body.project.signingKey?.id).toBe(created.signingKey.id)
    expect(updated.body.project.tokenFingerprint).toBe(created.project.tokenFingerprint)
  })
})

describe('注册 API：鉴权与 one-shot 创建 / 取消', () => {
  it('无令牌 → 401；无效令牌 → 401；有效令牌能取项目身份', async () => {
    const created = await createProject()

    const noToken = await http<ErrorBody>(ctx, '/v1/jobs')
    expect(noToken.status).toBe(401)
    expect(noToken.body.error.code).toBe('unauthorized')

    const badToken = await http<ErrorBody>(ctx, '/v1/jobs', { token: 'wkr_deadbeef' })
    expect(badToken.status).toBe(401)

    const whoami = await http<{ project: { id: string; name: string } }>(ctx, '/v1/whoami', {
      token: created.token,
    })
    expect(whoami.status).toBe(200)
    expect(whoami.body.project.id).toBe(created.project.id)
  })

  it('创建 one-shot → 201；重复创建同名 → 409 duplicate_job', async () => {
    const created = await createProject()
    const name = uniqueName('提醒')
    const runAt = Date.now() + 3_600_000

    const first = await http<{ job: JobView }>(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: { name, kind: 'one_shot', runAt },
    })
    expect(first.status).toBe(201)
    expect(first.body.job.projectId).toBe(created.project.id)
    expect(first.body.job.kind).toBe('one_shot')
    expect(first.body.job.runAt).toBe(runAt)

    const second = await http<ErrorBody>(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: { name, kind: 'one_shot', runAt },
    })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('duplicate_job')
  })

  it('请求体里的 projectId 与令牌不一致 → 400（项目身份只信令牌）', async () => {
    const created = await createProject()
    const other = await createProject()

    const response = await http<ErrorBody>(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: {
        projectId: other.project.id,
        name: uniqueName('越权'),
        kind: 'one_shot',
        runAt: Date.now() + 60_000,
      },
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_argument')
  })

  it('取消 one-shot：DELETE 幂等，未知任务名 → 404 job_not_found', async () => {
    const created = await createProject()
    const job = await http<{ job: JobView }>(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: { name: uniqueName('取消'), kind: 'one_shot', runAt: Date.now() + 60_000 },
    })

    const cancelled = await http<{ job: JobView }>(ctx, `/v1/jobs/${job.body.job.name}`, {
      method: 'DELETE',
      token: created.token,
    })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.job.status).toBe('cancelled')

    const again = await http<{ job: JobView }>(ctx, `/v1/jobs/${job.body.job.name}`, {
      method: 'DELETE',
      token: created.token,
    })
    expect(again.status).toBe(200)
    expect(again.body.job.status).toBe('cancelled')

    const unknown = await http<ErrorBody>(ctx, '/v1/jobs/no-such-job', {
      method: 'DELETE',
      token: created.token,
    })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('job_not_found')
  })

  it('列表只看得到自己项目的任务（令牌即项目边界）', async () => {
    const first = await createProject()
    const second = await createProject()

    const firstJob = await http<{ job: JobView }>(ctx, '/v1/jobs', {
      method: 'POST',
      token: first.token,
      body: { name: uniqueName('隔离'), kind: 'one_shot', runAt: Date.now() + 60_000 },
    })

    const firstList = await http<{ jobs: JobView[] }>(ctx, '/v1/jobs', { token: first.token })
    expect(firstList.body.jobs.map((job) => job.id)).toContain(firstJob.body.job.id)

    const secondList = await http<{ jobs: JobView[] }>(ctx, '/v1/jobs', { token: second.token })
    expect(secondList.body.jobs.map((job) => job.id)).not.toContain(firstJob.body.job.id)

    // 用第二个项目的令牌取消第一个项目的任务：按 (projectId, name) 定位，找不到 → 404
    const crossCancel = await http<ErrorBody>(ctx, `/v1/jobs/${firstJob.body.job.name}`, {
      method: 'DELETE',
      token: second.token,
    })
    expect(crossCancel.status).toBe(404)
    expect(crossCancel.body.error.code).toBe('job_not_found')
  })
})

describe('注册 API：按 CF 方言拒绝非法 cron 表达式（复用 B2 解析器）', () => {
  const invalidCronCases: Array<{ label: string; cron: string; dialectCode: string }> = [
    { label: '6 字段（带秒）', cron: '0 0 3 * * *', dialectCode: 'cron_field_count' },
    { label: '7 字段（带年）', cron: '0 0 3 * * * 2026', dialectCode: 'cron_field_count' },
    { label: '? 占位符', cron: '0 3 ? * *', dialectCode: 'cron_question_mark_unsupported' },
    { label: '@ 宏', cron: '@daily', dialectCode: 'cron_macro_unsupported' },
    { label: '星期 0（Vixie 制）', cron: '0 3 * * 0', dialectCode: 'cron_weekday_zero' },
  ]

  for (const item of invalidCronCases) {
    it(`${item.label} → 400 invalid_cron（dialectCode = ${item.dialectCode}）`, async () => {
      const created = await createProject()

      const response = await http<ErrorBody>(ctx, '/v1/jobs', {
        method: 'POST',
        token: created.token,
        body: { name: uniqueName('非法cron'), kind: 'cron', cron: item.cron },
      })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('invalid_cron')
      const details = response.body.error.details as { cron?: { dialectCode: string } }
      expect(details.cron?.dialectCode).toBe(item.dialectCode)
    })
  }

  it('合法 CF 方言（含扩展写法）照常受理', async () => {
    const created = await createProject()

    for (const cron of ['0 3 * * *', '10 7 * * mon-fri', '0 18 * * friL', '59 23 LW * *']) {
      const response = await http<{ job: JobView }>(ctx, '/v1/jobs', {
        method: 'POST',
        token: created.token,
        body: { name: uniqueName('合法cron'), kind: 'cron', cron },
      })
      expect(response.status, `${cron}: ${JSON.stringify(response.body)}`).toBe(201)
      expect(response.body.job.cron).toBe(cron)
      expect(response.body.job.nextRunAt).toBeGreaterThan(Date.now())
    }
  })
})

describe('声明式清单：注册 + 对账停用', () => {
  it('首次同步全部新建；再同步同一份清单全部 unchanged', async () => {
    const created = await createProject()
    const jobs = [
      { name: 'nightly-cleanup', cron: '0 3 * * *', timezone: 'Asia/Shanghai' },
      { name: 'hourly-digest', cron: '0 * * * *' },
    ]

    const first = await http<{ created: string[]; updated: string[]; unchanged: string[]; paused: string[]; jobs: JobView[] }>(
      ctx,
      '/v1/manifest',
      { method: 'PUT', token: created.token, body: { jobs } },
    )
    expect(first.status).toBe(200)
    expect(first.body.created.sort()).toEqual(['hourly-digest', 'nightly-cleanup'])
    expect(first.body.updated).toEqual([])
    expect(first.body.paused).toEqual([])
    expect(first.body.jobs).toHaveLength(2)
    for (const job of first.body.jobs) {
      expect(job.kind).toBe('cron')
      expect(job.status).toBe('active')
      expect(job.nextRunAt).not.toBeNull()
    }

    const second = await http<{ created: string[]; updated: string[]; unchanged: string[]; paused: string[] }>(
      ctx,
      '/v1/manifest',
      { method: 'PUT', token: created.token, body: { jobs } },
    )
    expect(second.status).toBe(200)
    expect(second.body.created).toEqual([])
    expect(second.body.updated).toEqual([])
    expect(second.body.unchanged.sort()).toEqual(['hourly-digest', 'nightly-cleanup'])
    expect(second.body.paused).toEqual([])
  })

  it('改表达式 → updated（job id 不变，nextRunAt 重算）', async () => {
    const created = await createProject()
    const name = 'reconfigurable'

    const first = await http<{ jobs: JobView[] }>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name, cron: '0 3 * * *' }] },
    })
    const original = first.body.jobs[0]!

    const second = await http<{ updated: string[]; unchanged: string[]; jobs: JobView[] }>(
      ctx,
      '/v1/manifest',
      { method: 'PUT', token: created.token, body: { jobs: [{ name, cron: '30 4 * * *' }] } },
    )
    expect(second.status).toBe(200)
    expect(second.body.updated).toEqual([name])
    expect(second.body.unchanged).toEqual([])
    expect(second.body.jobs[0]?.id).toBe(original.id)
    expect(second.body.jobs[0]?.cron).toBe('30 4 * * *')
    expect(second.body.jobs[0]?.nextRunAt).not.toBe(original.nextRunAt)
  })

  it('清单里删掉的任务被自动停用（paused + next_run_at 清空），运行时 one-shot 不受影响', async () => {
    const created = await createProject()

    const manifest = await http<{ jobs: JobView[] }>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: {
        jobs: [
          { name: 'keep-me', cron: '0 3 * * *' },
          { name: 'drop-me', cron: '0 4 * * *' },
        ],
      },
    })
    const dropMe = manifest.body.jobs.find((job) => job.name === 'drop-me')!

    // 运行时 one-shot（不经清单创建）
    const oneShot = await http<{ job: JobView }>(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: { name: 'runtime-one-shot', kind: 'one_shot', runAt: Date.now() + 3_600_000 },
    })

    const reconciled = await http<{ created: string[]; updated: string[]; paused: string[]; jobs: JobView[] }>(
      ctx,
      '/v1/manifest',
      { method: 'PUT', token: created.token, body: { jobs: [{ name: 'keep-me', cron: '0 3 * * *' }] } },
    )
    expect(reconciled.status).toBe(200)
    expect(reconciled.body.paused).toEqual(['drop-me'])
    // jobs 是「对账后该项目全部 cron 任务」的视图：被停用的也在其中，只是 status = paused。
    expect(reconciled.body.jobs.map((job) => `${job.name}:${job.status}`)).toEqual([
      'drop-me:paused',
      'keep-me:active',
    ])

    const droppedRow = await jobRow(dropMe.id)
    expect(droppedRow.status).toBe('paused')
    expect(droppedRow.next_run_at).toBeNull()

    const oneShotRow = await jobRow(oneShot.body.job.id)
    expect(oneShotRow.status).toBe('active')
    expect(oneShotRow.next_run_at).not.toBeNull()
  })

  it('清单里 enabled:false → 建好但保持暂停', async () => {
    const created = await createProject()

    const result = await http<{ created: string[]; jobs: JobView[] }>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name: 'staged', cron: '0 5 * * *', enabled: false }] },
    })
    expect(result.status).toBe(200)
    expect(result.body.created).toEqual(['staged'])
    expect(result.body.jobs[0]?.status).toBe('paused')
    expect(result.body.jobs[0]?.nextRunAt).toBeNull()
  })

  it('清单里非法 cron → 400 invalid_cron，且整批不写库（全有或全无）', async () => {
    const created = await createProject()

    await http(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name: 'existing', cron: '0 3 * * *' }] },
    })

    const failed = await http<ErrorBody>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: {
        jobs: [
          { name: 'existing', cron: '0 9 * * *' },
          { name: 'bad-one', cron: '0 0 3 * * *' },
        ],
      },
    })
    expect(failed.status).toBe(400)
    expect(failed.body.error.code).toBe('invalid_cron')
    const details = failed.body.error.details as { name?: string; cron?: { dialectCode: string } }
    expect(details.name).toBe('bad-one')
    expect(details.cron?.dialectCode).toBe('cron_field_count')

    const jobs = await http<{ jobs: JobView[] }>(ctx, '/v1/jobs', { token: created.token })
    expect(jobs.body.jobs.map((job) => job.name)).toEqual(['existing'])
    expect(jobs.body.jobs[0]?.cron).toBe('0 3 * * *')
  })

  it('清单名与运行时 one-shot 撞名 → 409 name_conflict', async () => {
    const created = await createProject()
    const name = 'collision'

    await http(ctx, '/v1/jobs', {
      method: 'POST',
      token: created.token,
      body: { name, kind: 'one_shot', runAt: Date.now() + 60_000 },
    })

    const response = await http<ErrorBody>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name, cron: '0 3 * * *' }] },
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('name_conflict')
  })

  it('已取消的 cron 任务被清单重新声明 → 复位为 active（updated）', async () => {
    const created = await createProject()
    const name = 'revive-me'

    const first = await http<{ jobs: JobView[] }>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name, cron: '0 3 * * *' }] },
    })
    const jobId = first.body.jobs[0]!.id

    const cancelled = await http<{ job: JobView }>(ctx, `/v1/jobs/${name}`, {
      method: 'DELETE',
      token: created.token,
    })
    expect(cancelled.body.job.status).toBe('cancelled')

    const revived = await http<{ updated: string[]; jobs: JobView[] }>(ctx, '/v1/manifest', {
      method: 'PUT',
      token: created.token,
      body: { jobs: [{ name, cron: '0 3 * * *' }] },
    })
    expect(revived.status).toBe(200)
    expect(revived.body.updated).toEqual([name])
    expect(revived.body.jobs[0]?.id).toBe(jobId)
    expect(revived.body.jobs[0]?.status).toBe('active')
  })
})

describe('任务更新（管理面编辑）', () => {
  it('改 cron：重算 nextRunAt；只改 payload：nextRunAt 保持不变', async () => {
    const created = await createProject()
    const job = await createJob(created.project.id, { kind: 'cron', cron: '0 3 * * *' })

    const changed = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}`, {
      method: 'PATCH',
      token,
      body: { cron: '15 4 * * *' },
    })
    expect(changed.status).toBe(200)
    expect(changed.body.job.id).toBe(job.id)
    expect(changed.body.job.cron).toBe('15 4 * * *')
    expect(changed.body.job.nextRunAt).not.toBe(job.nextRunAt)

    const payloadOnly = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}`, {
      method: 'PATCH',
      token,
      body: { payload: { note: 'hi' } },
    })
    expect(payloadOnly.status).toBe(200)
    expect(payloadOnly.body.job.payload).toEqual({ note: 'hi' })
    expect(payloadOnly.body.job.nextRunAt).toBe(changed.body.job.nextRunAt)
  })

  it('enabled 开关：false → paused 且清空 nextRunAt；true → 恢复并重算', async () => {
    const created = await createProject()
    const job = await createJob(created.project.id, { kind: 'cron', cron: '0 3 * * *' })

    const paused = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}`, {
      method: 'PATCH',
      token,
      body: { enabled: false },
    })
    expect(paused.body.job.status).toBe('paused')
    expect(paused.body.job.nextRunAt).toBeNull()

    const resumed = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}`, {
      method: 'PATCH',
      token,
      body: { enabled: true },
    })
    expect(resumed.body.job.status).toBe('active')
    expect(resumed.body.job.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('已取消的任务不可改（409 job_cancelled）', async () => {
    const created = await createProject()
    const job = await createJob(created.project.id, {
      kind: 'one_shot',
      runAt: Date.now() + 60_000,
    })

    await http(ctx, `/api/jobs/${job.id}/cancel`, { method: 'POST', token })

    const response = await http<ErrorBody>(ctx, `/api/jobs/${job.id}`, {
      method: 'PATCH',
      token,
      body: { runAt: Date.now() + 120_000 },
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('job_cancelled')
  })

  it('任务动作：pause / resume / cancel / trigger 都回冻结结构', async () => {
    const created = await createProject()
    const job = await createJob(created.project.id, { kind: 'cron', cron: '0 3 * * *' })

    const paused = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}/pause`, {
      method: 'POST',
      token,
    })
    expect(paused.body.job.status).toBe('paused')

    const resumed = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}/resume`, {
      method: 'POST',
      token,
    })
    expect(resumed.body.job.status).toBe('active')

    const triggered = await http<{ jobId: string; executionId: string; scheduledFor: number; dispatchAt: number }>(
      ctx,
      `/api/jobs/${job.id}/trigger`,
      { method: 'POST', token },
    )
    expect(triggered.status).toBe(202)
    expect(triggered.body.jobId).toBe(job.id)
    expect(triggered.body.executionId).toHaveLength(36)

    const cancelled = await http<{ job: JobView }>(ctx, `/api/jobs/${job.id}/cancel`, {
      method: 'POST',
      token,
    })
    expect(cancelled.body.job.status).toBe('cancelled')

    const unknownAction = await http<ErrorBody>(ctx, `/api/jobs/${job.id}/explode`, {
      method: 'POST',
      token,
    })
    expect(unknownAction.status).toBe(404)
  })

  it('建任务时项目不存在 → 404 project_not_found；仍未挂载的管理面子路径 → 501', async () => {
    const missing = await http<ErrorBody>(ctx, '/api/jobs', {
      method: 'POST',
      token,
      body: { projectId: 'no-such-project', name: uniqueName('孤儿'), kind: 'one_shot', runAt: Date.now() + 60_000 },
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('project_not_found')

    // 执行记录 / 死信三条路由已由 B7 挂载（见 tests/management-executions.test.ts），
    // 这里改用一条仍未挂载的子路径，继续钉住「未挂载 = 501 而不是 404」这个信号。
    const notImplemented = await http<{ error: string }>(ctx, '/api/metrics', { token })
    expect(notImplemented.status).toBe(501)
    expect(notImplemented.body.error).toBe('not_implemented')
  })
})

describe('watchdog 校正与系统状态', () => {
  it('watchdog cron ping DO 后账本落上次运行时刻，系统状态可读', async () => {
    interface StatusBody {
      status: SystemStatusView & {
        secrets: { setupSecretConfigured: boolean; jwtSecretConfigured: boolean }
        queue: { main: string; deadLetter: string }
      }
    }

    const before = await http<StatusBody>(ctx, '/api/system/status', { token })
    expect(before.status).toBe(200)
    expect(before.body.status.schemaVersion).toBe(4)
    expect(before.body.status.secrets).toEqual({
      setupSecretConfigured: true,
      jwtSecretConfigured: true,
    })

    const scheduled = await ctx.worker.scheduled({ cron: '0 * * * *', scheduledTime: new Date() })
    expect(scheduled.outcome).toBe('ok')

    const after = await http<StatusBody>(ctx, '/api/system/status', { token })
    expect(after.status).toBe(200)
    expect(after.body.status.watchdogLastRunAt).not.toBeNull()
    expect(after.body.status.watchdogLastRunAt).toBeGreaterThanOrEqual(
      before.body.status.now,
    )
    expect(after.body.status.watchdogLastDueJobs).not.toBeNull()
    expect(after.body.status.counts.projects).toBeGreaterThan(0)
    expect(after.body.status.counts.jobs).toBeGreaterThan(0)
    expect(after.body.status.queue).toEqual({ main: 'waker-jobs', deadLetter: 'waker-dlq' })

    // 状态里绝不能出现任何凭据值（连掩码都不给；掩码另有专门接口）。
    const serialized = JSON.stringify(after.body)
    expect(serialized).not.toContain('test-setup-secret-placeholder')
    expect(serialized).not.toContain('test-jwt-secret-placeholder')
  })
})

describe('端到端：signing key 只展示一次 → 加密存储 → 解密签名 → 下游验签通过', () => {
  it('经注册 API 建任务并手动触发，下游用「只展示过一次」的明文 key 验签成功', async () => {
    // 1) 建项目（拿明文 signing key，这是唯一一次）
    const created = await createProject()

    // 2) 起下游（用同一份明文验签）
    const downstream = await startDownstream(created.signingKey.secret)

    try {
      // 3) 改回调地址指向真下游
      const patched = await http<{ project: ProjectView }>(
        ctx,
        `/api/projects/${created.project.id}`,
        { method: 'PATCH', token, body: { callbackUrl: downstream.url } },
      )
      expect(patched.status).toBe(200)

      // 4) 经注册 API 建 one-shot 任务
      const jobResponse = await http<{ job: JobView }>(ctx, '/v1/jobs', {
        method: 'POST',
        token: created.token,
        body: {
          name: uniqueName('端到端'),
          kind: 'one_shot',
          runAt: Date.now() + 60_000,
          payload: { hello: 'world' },
        },
      })
      expect(jobResponse.status).toBe(201)
      const job = jobResponse.body.job

      // 5) 手动触发 → 平台从库里解密密文 → 签名 → 回调下游
      const triggered = await http<{ executionId: string }>(
        ctx,
        `/api/jobs/${job.id}/trigger`,
        { method: 'POST', token },
      )
      expect(triggered.status).toBe(202)

      const request = await waitFor(
        () => downstream.requests.find((item) => item.parsed.jobId === job.id) ?? null,
        { label: '下游收到回调', timeoutMs: 25_000 },
      )

      expect(request.signature.ok, JSON.stringify(request.signature)).toBe(true)
      expect(request.parsed.executionId).toBe(triggered.body.executionId)
      expect(request.parsed.jobName).toBe(job.name)
      expect(request.parsed.payload).toEqual({ hello: 'world' })
      expect(request.url).toBe('/_waker/execute')

      // 6) 库里始终只有密文
      const keys = await signingKeyRows(created.project.id)
      expect(String(keys[0]?.secret).startsWith(SIGNING_SECRET_ENVELOPE_PREFIX)).toBe(true)
      expect(String(keys[0]?.secret)).not.toContain(created.signingKey.secret)
    } finally {
      await downstream.close()
    }
  })
})
