import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { JobView, ProjectView } from '@/lib/api'
import { JobsPage } from '@/pages/jobs-page'
import {
  authenticate,
  installFetchMock,
  renderWithProviders,
  requestBody,
  requestUrl,
} from '@/test/utils'

/** 契约形状的测试夹具（字段与 B2/B4 冻结契约一一对应，不做本地增删）。 */
const project: ProjectView = {
  id: 'project-1',
  name: 'shortlink',
  callbackUrl: 'https://shortlink.example.com',
  status: 'active',
  tokenFingerprint: 'f0f0f0f0f0f0f0f0',
  tokenCreatedAt: 1_730_000_000_000,
  tokenRotatedAt: null,
  signingKey: {
    id: 'key-1',
    algorithm: 'HMAC-SHA256',
    fingerprint: 'a1a1a1a1a1a1a1a1',
    createdAt: 1_730_000_000_000,
    rotatedAt: null,
  },
  createdAt: 1_730_000_000_000,
  updatedAt: 1_730_000_000_000,
}

function makeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    projectId: project.id,
    name: 'nightly-cleanup',
    kind: 'cron',
    cron: '0 3 * * *',
    cronNormalized: '0 3 * * *',
    timezone: 'Asia/Shanghai',
    runAt: null,
    payload: {},
    policies: {
      misfire: 'skip',
      concurrency: 'forbid',
      maxRetries: 2,
      backoffSeconds: 30,
      timeoutSeconds: 30,
      jitterSeconds: 0,
    },
    status: 'active',
    nextRunAt: 1_730_500_000_000,
    lastRunAt: null,
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    ...overrides,
  }
}

describe('任务管理页', () => {
  it('加载任务列表，并按契约 query 传筛选条件', async () => {
    const jobUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) {
        jobUrls.push(url)
        return { body: { jobs: [makeJob()], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)

    expect(await screen.findByText('nightly-cleanup')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('cron 周期')).toBeInTheDocument()
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('启用中')).toBeInTheDocument()
    // 项目筛选的可选项来自 /api/projects
    expect(screen.getByRole('option', { name: 'shortlink' })).toBeInTheDocument()
    // 首次请求不带筛选参数，只带契约允许的 limit/cursor
    expect(jobUrls[0]).toMatch(/^\/api\/jobs\?limit=25$/)

    await user.selectOptions(screen.getByLabelText('按类型筛选'), 'cron')

    await waitFor(() => {
      expect(jobUrls.at(-1)).toContain('kind=cron')
    })
  })

  it('新建任务：按 CreateJobInput 契约提交', async () => {
    const fetchMock = installFetchMock((url, init) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url === '/api/jobs' && init.method === 'POST') {
        return { status: 201, body: { job: makeJob({ name: 'nightly-cleanup' }) } }
      }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)

    const createButtons = await screen.findAllByRole('button', { name: /新建任务/ })
    await user.click(createButtons[0]!)

    // 新建时唯一必填的项目默认选中第一个项目
    await user.type(screen.getByLabelText('任务名'), 'nightly-cleanup')
    await user.clear(screen.getByLabelText('cron 表达式'))
    await user.type(screen.getByLabelText('cron 表达式'), '0 3 * * *')
    await user.click(screen.getByRole('button', { name: /创建任务/ }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => requestUrl(call) === '/api/jobs')
      expect(postCall).toBeDefined()
      const body = requestBody(postCall)
      expect(body).toMatchObject({
        projectId: project.id,
        name: 'nightly-cleanup',
        kind: 'cron',
        cron: '0 3 * * *',
        payload: {},
        policies: {
          misfire: 'fire_once',
          concurrency: 'forbid',
          maxRetries: 0,
          backoffSeconds: 0,
          timeoutSeconds: 30,
          jitterSeconds: 0,
        },
        enabled: true,
      })
      expect(typeof body.timezone).toBe('string')
      expect(body).not.toHaveProperty('runAt')
    })
  })

  it('cron 字段数不符时在前端拦下，不发请求', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)
    await user.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0]!)
    await user.type(screen.getByLabelText('任务名'), 'bad-cron')
    await user.type(screen.getByLabelText('cron 表达式'), '0 3 * * * *')
    await user.click(screen.getByRole('button', { name: /创建任务/ }))

    expect(await screen.findByText(/cron 必须是 5 字段/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => requestBody(call).name === 'bad-cron')).toBe(false)
  })

  it('时区下拉直接列出常用预置，并按所选时区提交', async () => {
    const fetchMock = installFetchMock((url, init) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url === '/api/jobs' && init.method === 'POST') {
        return { status: 201, body: { job: makeJob({ name: 'tokyo-job', timezone: 'Asia/Tokyo' }) } }
      }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)
    await user.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0]!)

    // 18 个常用预置 + 「自定义」一项，全部是下拉里看得见的选项（不再靠浏览器补全）
    const timezoneSelect = screen.getByLabelText('时区')
    const timezoneOptions = within(timezoneSelect).getAllByRole('option')
    expect(timezoneOptions).toHaveLength(19)
    expect(screen.getByRole('option', { name: /^UTC（GMT/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Asia\/Shanghai（GMT\+8）$/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^America\/New_York（GMT[+-]/ })).toBeInTheDocument()

    await user.type(screen.getByLabelText('任务名'), 'tokyo-job')
    await user.clear(screen.getByLabelText('cron 表达式'))
    await user.type(screen.getByLabelText('cron 表达式'), '0 3 * * *')
    await user.selectOptions(timezoneSelect, 'Asia/Tokyo')
    await user.click(screen.getByRole('button', { name: /创建任务/ }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => requestUrl(call) === '/api/jobs')
      expect(postCall).toBeDefined()
      expect(requestBody(postCall).timezone).toBe('Asia/Tokyo')
    })
  })

  it('切到自定义后可手填任意 IANA 时区名', async () => {
    const fetchMock = installFetchMock((url, init) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url === '/api/jobs' && init.method === 'POST') {
        return { status: 201, body: { job: makeJob({ name: 'berlin-job' }) } }
      }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)
    await user.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0]!)

    await user.type(screen.getByLabelText('任务名'), 'berlin-job')
    await user.clear(screen.getByLabelText('cron 表达式'))
    await user.type(screen.getByLabelText('cron 表达式'), '0 3 * * *')
    await user.selectOptions(screen.getByLabelText('时区'), '__custom__')

    const manualInput = screen.getByLabelText('自定义 IANA 时区')
    await user.clear(manualInput)
    await user.type(manualInput, 'Europe/Berlin')
    await user.click(screen.getByRole('button', { name: /创建任务/ }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => requestUrl(call) === '/api/jobs')
      expect(postCall).toBeDefined()
      expect(requestBody(postCall).timezone).toBe('Europe/Berlin')
    })
  })

  it('自定义时区非法时在前端拦下，不发请求', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)
    await user.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0]!)

    await user.type(screen.getByLabelText('任务名'), 'bad-tz')
    await user.clear(screen.getByLabelText('cron 表达式'))
    await user.type(screen.getByLabelText('cron 表达式'), '0 3 * * *')
    await user.selectOptions(screen.getByLabelText('时区'), '__custom__')

    const manualInput = screen.getByLabelText('自定义 IANA 时区')
    await user.clear(manualInput)
    await user.type(manualInput, 'Mars/Base')
    await user.click(screen.getByRole('button', { name: /创建任务/ }))

    expect(await screen.findByText('不是合法的 IANA 时区名')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => requestBody(call).name === 'bad-tz')).toBe(false)
  })

  it('手动触发：调用 trigger 接口并展示 executionId', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url === `/api/jobs/${makeJob().id}/trigger`) {
        return {
          status: 202,
          body: {
            jobId: makeJob().id,
            executionId: 'exec-abc-123',
            scheduledFor: 1_730_000_100_000,
            dispatchAt: 1_730_000_100_000,
          },
        }
      }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<JobsPage />)
    await screen.findByText('nightly-cleanup')

    await user.click(screen.getByLabelText('立即触发一次'))

    expect(await screen.findByText(/exec-abc-123/)).toBeInTheDocument()
    const triggerCall = fetchMock.mock.calls.find((call) =>
      requestUrl(call).endsWith('/trigger'),
    )
    expect(triggerCall?.[1]?.method).toBe('POST')
  })
})
