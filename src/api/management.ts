import { Hono } from 'hono'

import { getApiStub } from '../do/http-rpc'
import type {
  CreateJobInput,
  CreateProjectInput,
  DeadLetterReplayState,
  ExecutionStatus,
  ExecutionTrigger,
  JobKind,
  JobPolicies,
  JobStatus,
  JsonValue,
  ListDeadLettersQuery,
  ListExecutionsQuery,
  ListJobsQuery,
  UpdateJobInput,
  UpdateProjectInput,
} from '../do/types'
import type { ApiEnv } from './auth'
import { sessionAuth, viewerWriteGuard } from './auth'
import { jsonError, queryInt, queryValue, readJson, respond } from './errors'

/**
 * 管理面 API（B4 冻结契约，供 F1「任务管理 / 项目管理」页与 F3「系统管理」页对接；
 * B7 追加执行记录 / 死信三条路由，供 F2 页面对接）。
 *
 * 鉴权（ONE-462 起）：用户体系会话 JWT —— `POST /api/auth/login` 换 12 小时会话
 * （启用 2FA 的用户还要过第二因素），其余 `/api/*` 一律要求 `Authorization: Bearer <JWT>`。
 * 权限矩阵在中间件里强制：`viewer` 只能 GET，写接口一律 403（`viewerWriteGuard`）。
 *
 * 本模块只做「HTTP ↔ RPC」的薄映射：参数校验、错误码映射、响应体形状。
 * 业务语义（状态机、调度、对账、凭据）全部在 WakerDO，前端只按本契约调用。
 */
export const managementRoutes = new Hono<ApiEnv>()

// 全部路由都要过会话校验 + 权限矩阵（`/api/setup` / `/api/auth/*` / `/api/me` / `/api/users`
// 这些路由挂在别处，见 `app.ts`；它们各自声明自己的鉴权要求）。
managementRoutes.use('*', sessionAuth())
managementRoutes.use('*', viewerWriteGuard())

// ───────────────────────── 项目管理 ─────────────────────────

managementRoutes.get('/projects', async (c) => {
  return respond(c, await getApiStub(c.env).listProjects(), (value) => value)
})

managementRoutes.post('/projects', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const input: CreateProjectInput = {
    name: body.name as string,
    callbackUrl: body.callbackUrl as string,
  }

  // 应答里的 token / signingKey.secret 是**明文唯一一次**出现的时机，前端只展示一次。
  return respond(c, await getApiStub(c.env).createProject(input), (value) => value, 201)
})

managementRoutes.get('/projects/:projectId', async (c) => {
  const projectId = c.req.param('projectId')
  const result = await getApiStub(c.env).getProject({ projectId })
  if (!result.ok) {
    return jsonError(c, result.error.code, result.error.message, result.error.details)
  }
  if (result.value === null) return jsonError(c, 'project_not_found', `项目不存在：${projectId}`)
  return c.json({ project: result.value })
})

managementRoutes.patch('/projects/:projectId', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const input: UpdateProjectInput = { projectId: c.req.param('projectId') }
  if (body.name !== undefined) input.name = body.name as string
  if (body.callbackUrl !== undefined) input.callbackUrl = body.callbackUrl as string

  return respond(c, await getApiStub(c.env).updateProject(input), (project) => ({ project }))
})

/** 轮换项目令牌：应答里的 `token` 是明文唯一一次出现的时机。 */
managementRoutes.post('/projects/:projectId/token/rotate', async (c) => {
  const projectId = c.req.param('projectId')
  return respond(
    c,
    await getApiStub(c.env).rotateProjectToken({ projectId }),
    (value) => value,
  )
})

/** 轮换 signing key：应答里的 `signingKey.secret` 是明文唯一一次出现的时机。 */
managementRoutes.post('/projects/:projectId/signing-key/rotate', async (c) => {
  const projectId = c.req.param('projectId')
  return respond(
    c,
    await getApiStub(c.env).rotateSigningKey({ projectId }),
    (value) => value,
  )
})

// ───────────────────────── 任务管理（B2 冻结 RPC 的 HTTP 面，供 F1） ─────────────────────────

managementRoutes.get('/jobs', async (c) => {
  const query: ListJobsQuery = {
    projectId: queryValue(c, 'projectId'),
    status: queryValue(c, 'status') as JobStatus | undefined,
    kind: queryValue(c, 'kind') as JobKind | undefined,
    limit: queryInt(c, 'limit'),
    cursor: queryValue(c, 'cursor') ?? null,
  }
  return respond(c, await getApiStub(c.env).listJobs(query), (value) => value)
})

managementRoutes.post('/jobs', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const input: CreateJobInput = {
    projectId: body.projectId as string,
    name: body.name as string,
    kind: body.kind as JobKind,
    cron: body.cron as string | undefined,
    runAt: body.runAt as number | string | undefined,
    timezone: body.timezone as string | undefined,
    payload: body.payload as JsonValue | undefined,
    policies: body.policies as Partial<JobPolicies> | undefined,
    enabled: body.enabled as boolean | undefined,
  }

  // 管理面可以指定任意项目，但要先确认项目存在（避免建出永远无法回调的孤儿任务）。
  const stub = getApiStub(c.env)
  const project = await stub.getProject({ projectId: input.projectId })
  if (!project.ok) {
    return jsonError(c, project.error.code, project.error.message, project.error.details)
  }
  if (project.value === null) {
    return jsonError(c, 'project_not_found', `项目不存在：${String(input.projectId)}`)
  }

  return respond(c, await stub.createJob(input), (job) => ({ job }), 201)
})

managementRoutes.get('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId')
  const result = await getApiStub(c.env).getJob({ jobId })
  if (!result.ok) return jsonError(c, result.error.code, result.error.message, result.error.details)
  if (result.value === null) return jsonError(c, 'job_not_found', `任务不存在：${jobId}`)
  return c.json({ job: result.value })
})

managementRoutes.patch('/jobs/:jobId', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const input: UpdateJobInput = { jobId: c.req.param('jobId') }
  if (body.cron !== undefined) input.cron = body.cron as string
  if (body.runAt !== undefined) input.runAt = body.runAt as number | string
  if (body.timezone !== undefined) input.timezone = body.timezone as string
  if (body.payload !== undefined) input.payload = body.payload as JsonValue
  if (body.policies !== undefined) input.policies = body.policies as Partial<JobPolicies>
  if (body.enabled !== undefined) input.enabled = body.enabled as boolean

  return respond(c, await getApiStub(c.env).updateJob(input), (job) => ({ job }))
})

/** 任务动作：`pause` / `resume` / `cancel` 返回任务视图，`trigger` 返回本次执行指针。 */
managementRoutes.post('/jobs/:jobId/:action', async (c) => {
  const jobId = c.req.param('jobId')
  const action = c.req.param('action')
  const stub = getApiStub(c.env)

  switch (action) {
    case 'pause':
      return respond(c, await stub.pauseJob({ jobId }), (job) => ({ job }))
    case 'resume':
      return respond(c, await stub.resumeJob({ jobId }), (job) => ({ job }))
    case 'cancel':
      return respond(c, await stub.cancelJob({ jobId }), (job) => ({ job }))
    case 'trigger': {
      // 手动触发可选带 payload 覆盖（body 允许为空）。
      const parsed = parsedBody(await readJson(c))
      return respond(
        c,
        await stub.manualTrigger(
          parsed.payload === undefined ? { jobId } : { jobId, payload: parsed.payload as JsonValue },
        ),
        (value) => value,
        202,
      )
    }
    default:
      return jsonError(c, 'not_found', `未知动作：${action}（支持 pause / resume / cancel / trigger）`)
  }
})

// ───────────── 执行记录 / 死信（B6 + B3 冻结 RPC 的 HTTP 面，供 F2） ─────────────
//
// 三条路由都是**薄映射**：查询串 → B6 `listExecutions` / `listDeadLetters` 的入参对象；
// 应答原样给出 `{ executions, nextCursor }` / `{ deadLetters, nextCursor }`，重放 202 直接回
// `ReplayDeadLetterResult`（F2 页面已按此契约写定，字段不加壳、不改名）。
//
// 参数校验 / 排序 / 游标语义一律留在 WakerDO：HTTP 层不重复实现，否则会出现
// 「HTTP 面放过、DO 拒绝」两套规则。`queryInt` 把非法数字解析成 `NaN` 交给 DO 报
// `invalid_argument`（与既有 `GET /api/jobs` 同构），本层只做参数搬运 + 错误码映射。

managementRoutes.get('/executions', async (c) => {
  const query: ListExecutionsQuery = {
    jobId: queryValue(c, 'jobId'),
    projectId: queryValue(c, 'projectId'),
    status: queryValue(c, 'status') as ExecutionStatus | undefined,
    trigger: queryValue(c, 'trigger') as ExecutionTrigger | undefined,
    scheduledFrom: queryInt(c, 'scheduledFrom'),
    scheduledTo: queryInt(c, 'scheduledTo'),
    limit: queryInt(c, 'limit'),
    cursor: queryValue(c, 'cursor') ?? null,
  }
  return respond(c, await getApiStub(c.env).listExecutions(query), (value) => value)
})

managementRoutes.get('/dead-letters', async (c) => {
  const query: ListDeadLettersQuery = {
    jobId: queryValue(c, 'jobId'),
    projectId: queryValue(c, 'projectId'),
    replayState: queryValue(c, 'replayState') as DeadLetterReplayState | undefined,
    createdFrom: queryInt(c, 'createdFrom'),
    createdTo: queryInt(c, 'createdTo'),
    limit: queryInt(c, 'limit'),
    cursor: queryValue(c, 'cursor') ?? null,
  }
  return respond(c, await getApiStub(c.env).listDeadLetters(query), (value) => value)
})

/**
 * 重放死信：以同一任务新建一条 `manual` 执行重新投递（语义全在 B3 `replayDeadLetter`）。
 * body 按契约留空（有 body 也不解析，避免把「重放」变成可覆盖载荷的入口）。
 */
managementRoutes.post('/dead-letters/:deadLetterId/replay', async (c) => {
  const deadLetterId = c.req.param('deadLetterId')
  return respond(c, await getApiStub(c.env).replayDeadLetter({ deadLetterId }), (value) => value, 202)
})

// ───────────────────────── 系统状态（F3 系统管理页） ─────────────────────────

managementRoutes.get('/system/status', async (c) => {
  const result = await getApiStub(c.env).getSystemStatus()
  return respond(c, result, (status) => ({
    status: {
      ...status,
      // 只报「是否已配置」的布尔状态位，绝不回显值（前端也只展示状态）。
      secrets: {
        setupSecretConfigured:
          typeof c.env.SETUP_SECRET === 'string' && c.env.SETUP_SECRET.length > 0,
        jwtSecretConfigured: typeof c.env.JWT_SECRET === 'string' && c.env.JWT_SECRET.length > 0,
      },
      queue: { main: 'waker-jobs', deadLetter: 'waker-dlq' },
    },
  }))
})

/** 宽容解析可选 body：没有 body / 空 body 都当作 `{}`。 */
function parsedBody(parsed: Awaited<ReturnType<typeof readJson>>): Record<string, unknown> {
  if (!parsed.ok) return {}
  if (parsed.value === null || parsed.value === undefined) return {}
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return {}
  return parsed.value as Record<string, unknown>
}
