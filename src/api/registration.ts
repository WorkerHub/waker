import { Hono } from 'hono'

import { getApiStub } from '../do/http-rpc'
import type {
  CreateJobInput,
  JobKind,
  JobPolicies,
  JobStatus,
  JsonValue,
  ListJobsQuery,
  ManifestJobInput,
} from '../do/types'
import type { ApiEnv } from './auth'
import { registrationAuth } from './auth'
import { jsonError, queryInt, queryValue, readJson, respond } from './errors'

/**
 * 注册 API（B4 冻结契约，供 B5 SDK / CI 与下游项目对接）。
 *
 * 鉴权：`Authorization: Bearer <项目令牌>`。**项目身份只从令牌来** —— 请求体里的
 * `projectId` 一律不可信；带了且与令牌项目不一致直接 400（见 `assertSameProject`）。
 *
 * 四条路径：
 *   - `GET    /v1/whoami`    令牌对应的项目身份（CI / SDK 自检用）
 *   - `GET    /v1/jobs`      该项目任务列表（分页游标同 B2 `listJobs`）
 *   - `POST   /v1/jobs`      运行时创建任务（one-shot 为主，cron 也允许）
 *   - `DELETE /v1/jobs/{name}` 取消任务（one-shot 取消；cron 由清单对账停用）
 *   - `PUT    /v1/manifest`  部署期声明式同步 + 对账（幂等）
 */
export const registrationRoutes = new Hono<ApiEnv>()

registrationRoutes.use('*', registrationAuth())

registrationRoutes.get('/whoami', (c) => {
  const project = c.get('project')
  return c.json({ project: { id: project.projectId, name: project.projectName } })
})

registrationRoutes.get('/jobs', async (c) => {
  const project = c.get('project')
  const query: ListJobsQuery = {
    projectId: project.projectId,
    status: queryValue(c, 'status') as JobStatus | undefined,
    kind: queryValue(c, 'kind') as JobKind | undefined,
    limit: queryInt(c, 'limit'),
    cursor: queryValue(c, 'cursor') ?? null,
  }

  return respond(c, await getApiStub(c.env).listJobs(query), (value) => value)
})

registrationRoutes.post('/jobs', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const project = c.get('project')
  if (body.projectId !== undefined && body.projectId !== project.projectId) {
    return jsonError(c, 'invalid_argument', '请求体里的 projectId 与令牌所属项目不一致', {
      expected: project.projectId,
    })
  }

  // projectId 由令牌决定；其余字段交给 RPC 校验（错误码原样透出）。
  const input: CreateJobInput = {
    projectId: project.projectId,
    name: body.name as string,
    kind: body.kind as JobKind,
    cron: body.cron as string | undefined,
    runAt: body.runAt as number | string | undefined,
    timezone: body.timezone as string | undefined,
    payload: body.payload as JsonValue | undefined,
    policies: body.policies as Partial<JobPolicies> | undefined,
    enabled: body.enabled as boolean | undefined,
  }

  return respond(c, await getApiStub(c.env).createJob(input), (job) => ({ job }), 201)
})

registrationRoutes.delete('/jobs/:name', async (c) => {
  const project = c.get('project')
  const name = c.req.param('name')
  return respond(
    c,
    await getApiStub(c.env).cancelJob({ projectId: project.projectId, name }),
    (job) => ({ job }),
  )
})

registrationRoutes.put('/manifest', async (c) => {
  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, 'invalid_json', '请求体必须是 JSON')
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return jsonError(c, 'invalid_argument', '请求体必须是 JSON 对象')
  }

  const body = parsed.value as Record<string, unknown>
  const project = c.get('project')
  if (body.projectId !== undefined && body.projectId !== project.projectId) {
    return jsonError(c, 'invalid_argument', '请求体里的 projectId 与令牌所属项目不一致', {
      expected: project.projectId,
    })
  }
  if (!Array.isArray(body.jobs)) {
    return jsonError(c, 'invalid_argument', 'jobs 必须是数组（可以是空数组：表示该项目声明式任务全部停用）')
  }

  return respond(
    c,
    await getApiStub(c.env).syncManifest({
      projectId: project.projectId,
      jobs: body.jobs as ManifestJobInput[],
    }),
    (value) => value,
  )
})
