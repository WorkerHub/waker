import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ExecutionView, JobView, ProjectView } from '@/lib/api'
import { ExecutionsPage } from '@/pages/executions-page'
import { authenticate, installFetchMock, renderWithProviders } from '@/test/utils'

/** 契约形状的测试夹具（字段与 B6 冻结的 `ExecutionView` 一一对应，不做本地增删）。 */
const project: ProjectView = {
  id: 'project-1',
  name: 'shortlink',
  callbackUrl: 'https://shortlink.example.com',
  status: 'active',
  tokenFingerprint: 'f0f0f0f0f0f0f0f0',
  tokenCreatedAt: 1_730_000_000_000,
  tokenRotatedAt: null,
  signingKey: null,
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
    lastRunAt: 1_730_460_000_000,
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    ...overrides,
  }
}

function makeExecution(overrides: Partial<ExecutionView> = {}): ExecutionView {
  return {
    id: 'exec-1',
    jobId: 'job-1',
    jobName: 'nightly-cleanup',
    projectId: project.id,
    trigger: 'schedule',
    misfire: false,
    status: 'succeeded',
    skipReason: null,
    scheduledFor: 1_730_500_000_000,
    dispatchAt: 1_730_500_000_000,
    attempt: 0,
    startedAt: 1_730_500_001_000,
    finishedAt: 1_730_500_001_400,
    durationMs: 400,
    responseStatus: 200,
    error: null,
    createdAt: 1_730_499_000_000,
    renewalAt: null,
    renewalError: null,
    ...overrides,
  }
}

describe('执行记录页', () => {
  it('加载执行记录，列与字段对齐 ExecutionView', async () => {
    const executionUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        executionUrls.push(url)
        return { body: { executions: [makeExecution()], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<ExecutionsPage />)

    const table = await screen.findByRole('table')
    // 任务名同时出现在筛选下拉与表格行里，表格断言一律 within(table)
    expect(within(table).getByText('nightly-cleanup')).toBeInTheDocument()
    // 状态 / 触发方式 / 耗时 / 重试次数（attempt = 0 → 首次）都在表格里
    expect(within(table).getByText('成功')).toBeInTheDocument()
    expect(within(table).getByText('调度触发')).toBeInTheDocument()
    expect(within(table).getByText('400 ms')).toBeInTheDocument()
    expect(within(table).getByText('首次')).toBeInTheDocument()
    expect(within(table).getByText('200')).toBeInTheDocument()
    // 首次加载不带任何筛选，只有契约允许的 limit
    expect(executionUrls[0]).toBe('/api/executions?limit=25')
  })

  it('筛选条件原样下推给 listExecutions 契约参数', async () => {
    const executionUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        executionUrls.push(url)
        return {
          body: {
            executions: [makeExecution({ status: 'failed', error: '下游返回 500' })],
            nextCursor: null,
          },
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ExecutionsPage />)
    await screen.findByRole('table')

    await user.selectOptions(screen.getByLabelText('按状态筛选'), 'failed')
    await waitFor(() => {
      expect(executionUrls.at(-1)).toBe('/api/executions?status=failed&limit=25')
    })

    await user.selectOptions(screen.getByLabelText('按触发方式筛选'), 'manual')
    await waitFor(() => {
      expect(executionUrls.at(-1)).toBe('/api/executions?status=failed&trigger=manual&limit=25')
    })

    await user.selectOptions(screen.getByLabelText('按任务筛选'), 'job-1')
    await waitFor(() => {
      expect(executionUrls.at(-1)).toContain('jobId=job-1')
    })

    // 时间区间 → 半开区间的两端字段（scheduledFrom / scheduledTo，epoch 毫秒）
    const from = new Date('2026-10-26T10:00').getTime()
    const to = new Date('2026-10-26T12:00').getTime()
    fireEvent.change(screen.getByLabelText('计划执行时间（起）'), {
      target: { value: '2026-10-26T10:00' },
    })
    fireEvent.change(screen.getByLabelText('计划执行时间（止）'), {
      target: { value: '2026-10-26T12:00' },
    })

    await waitFor(() => {
      expect(executionUrls.at(-1)).toContain(`scheduledFrom=${from}`)
      expect(executionUrls.at(-1)).toContain(`scheduledTo=${to}`)
    })
  })

  it('时间区间倒置时前端停手，不发必然 400 的请求', async () => {
    const executionUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        executionUrls.push(url)
        return { body: { executions: [], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<ExecutionsPage />)
    await screen.findByText('还没有执行记录')

    fireEvent.change(screen.getByLabelText('计划执行时间（起）'), {
      target: { value: '2026-10-26T12:00' },
    })
    fireEvent.change(screen.getByLabelText('计划执行时间（止）'), {
      target: { value: '2026-10-26T10:00' },
    })

    expect(await screen.findByText(/起始时间必须早于结束时间/)).toBeInTheDocument()
    // 倒置区间一次都没发出去：查询里从未出现 scheduledTo（两端都填了才会带它）
    expect(executionUrls.some((url) => url.includes('scheduledTo='))).toBe(false)
  })

  it('详情展示回调响应摘要与错误信息', async () => {
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        return {
          body: {
            executions: [
              makeExecution({
                status: 'failed',
                attempt: 2,
                responseStatus: 503,
                error: '下游返回 503 Service Unavailable',
                durationMs: 1234,
                renewalError: 'next_run_at_not_future',
              }),
            ],
            nextCursor: null,
          },
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ExecutionsPage />)
    await screen.findByRole('table')

    await user.click(screen.getByLabelText('查看执行详情'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('回调响应摘要')).toBeInTheDocument()
    expect(within(dialog).getByText('503')).toBeInTheDocument()
    expect(within(dialog).getByText('1.2 s')).toBeInTheDocument()
    expect(within(dialog).getByText('下游返回 503 Service Unavailable')).toBeInTheDocument()
    expect(within(dialog).getByText('next_run_at_not_future')).toBeInTheDocument()
    // 载荷不在 ExecutionView 里下发，详情明确说明不展示
    expect(within(dialog).getByText(/载荷（payload）不在列表契约里下发/)).toBeInTheDocument()
  })

  it('翻页只用 nextCursor，上一页回到上一入口游标', async () => {
    const executionUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        executionUrls.push(url)
        if (url.includes('cursor=')) {
          return {
            body: { executions: [makeExecution({ id: 'exec-2' })], nextCursor: null },
          }
        }
        return { body: { executions: [makeExecution()], nextCursor: 'e1|1730500000000|exec-1' } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ExecutionsPage />)
    await screen.findByRole('table')

    await user.click(screen.getByRole('button', { name: /下一页/ }))
    await waitFor(() => {
      expect(executionUrls.at(-1)).toBe(
        '/api/executions?limit=25&cursor=e1%7C1730500000000%7Cexec-1',
      )
    })

    await user.click(screen.getByRole('button', { name: /上一页/ }))
    await waitFor(() => {
      expect(executionUrls.at(-1)).toBe('/api/executions?limit=25')
    })
  })

  it('查询接口未挂载（501）时给出明确提示而不是装作空列表', async () => {
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/executions')) {
        return { status: 501, body: { error: 'not_implemented', scope: 'management-api' } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<ExecutionsPage />)

    expect(await screen.findByText('执行记录加载失败')).toBeInTheDocument()
    expect(screen.getByText(/还没有挂载执行记录查询路由/)).toBeInTheDocument()
  })
})
