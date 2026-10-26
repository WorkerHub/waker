import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { DeadLetterView, JobView, ProjectView } from '@/lib/api'
import { DeadLettersPage } from '@/pages/dead-letters-page'
import { authenticate, installFetchMock, renderWithProviders } from '@/test/utils'

/** 契约形状的测试夹具（字段与 B3 冻结的 `DeadLetterView` 一一对应，不做本地增删）。 */
const project: ProjectView = {
  id: 'project-1',
  name: 'post',
  callbackUrl: 'https://post.example.com',
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
    name: 'deliver-letter',
    kind: 'one_shot',
    cron: null,
    cronNormalized: null,
    timezone: 'Asia/Shanghai',
    runAt: 1_730_500_000_000,
    payload: {},
    policies: {
      misfire: 'fire_once',
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

function makeDeadLetter(overrides: Partial<DeadLetterView> = {}): DeadLetterView {
  return {
    id: 'dl-1',
    executionId: 'exec-9',
    jobId: 'job-1',
    projectId: project.id,
    attempts: 3,
    error: '下游连续返回 500，重试已用尽',
    payload: { letterId: 'L-1' },
    createdAt: 1_730_500_000_000,
    replayedAt: null,
    replayedExecutionId: null,
    ...overrides,
  }
}

describe('死信队列页', () => {
  it('加载死信列表：来源任务按 jobId 映射，展示 executionId / 失败原因 / 尝试次数', async () => {
    const deadLetterUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/dead-letters')) {
        deadLetterUrls.push(url)
        return { body: { deadLetters: [makeDeadLetter()], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<DeadLettersPage />)

    const table = await screen.findByRole('table')
    expect(within(table).getByText('deliver-letter')).toBeInTheDocument()
    expect(within(table).getByText('exec-9')).toBeInTheDocument()
    expect(within(table).getByText('下游连续返回 500，重试已用尽')).toBeInTheDocument()
    expect(within(table).getByText('3 次')).toBeInTheDocument()
    expect(within(table).getByText('待重放')).toBeInTheDocument()
    // 首次加载不带任何筛选，只有契约允许的 limit
    expect(deadLetterUrls[0]).toBe('/api/dead-letters?limit=25')
  })

  it('重放按钮：确认后调用 replay 契约，并回显新的 executionId', async () => {
    const deadLetterUrls: string[] = []
    installFetchMock((url, init) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url === '/api/dead-letters/dl-1/replay' && init.method === 'POST') {
        return {
          status: 202,
          body: {
            deadLetterId: 'dl-1',
            jobId: 'job-1',
            executionId: 'exec-replay-77',
            scheduledFor: 1_730_600_000_000,
            dispatchAt: 1_730_600_000_000,
          },
        }
      }
      if (url.startsWith('/api/dead-letters')) {
        deadLetterUrls.push(url)
        // 重放后平台会把原死信标记为已重放，列表随之变化
        return {
          body: {
            deadLetters: [
              deadLetterUrls.length > 1
                ? makeDeadLetter({
                    replayedAt: 1_730_600_000_000,
                    replayedExecutionId: 'exec-replay-77',
                  })
                : makeDeadLetter(),
            ],
            nextCursor: null,
          },
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<DeadLettersPage />)
    await screen.findByRole('table')

    await user.click(screen.getByLabelText('重放死信'))
    // 二次确认：说明重放会新建一条手动执行
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/新建一条手动执行/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: '确认重放' }))

    // 结果回显：新执行 id + 去执行记录页的入口
    // 结果回显：新执行 id 出现在页面内的重放结果条里（toast 里也有一份，这里只认页面条）
    const replayBanner = await screen.findByRole('alert')
    expect(within(replayBanner).getByText(/executionId exec-replay-77/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '去执行记录查看' })).toHaveAttribute(
      'href',
      '/executions',
    )

    // 列表刷新后该条变成「已重放」，重放按钮不再可用
    await waitFor(() => {
      expect(within(screen.getByRole('table')).getByText('已重放')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('重放死信')).toBeDisabled()
    expect(deadLetterUrls.length).toBeGreaterThan(1)
  })

  it('筛选条件原样下推给 listDeadLetters 契约参数（含重放状态与时间区间）', async () => {
    const deadLetterUrls: string[] = []
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/dead-letters')) {
        deadLetterUrls.push(url)
        return { body: { deadLetters: [makeDeadLetter()], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<DeadLettersPage />)
    await screen.findByRole('table')

    await user.selectOptions(screen.getByLabelText('按重放状态筛选'), 'pending')
    await waitFor(() => {
      expect(deadLetterUrls.at(-1)).toBe('/api/dead-letters?replayState=pending&limit=25')
    })

    await user.selectOptions(screen.getByLabelText('按任务筛选'), 'job-1')
    await waitFor(() => {
      expect(deadLetterUrls.at(-1)).toBe(
        '/api/dead-letters?jobId=job-1&replayState=pending&limit=25',
      )
    })

    // 死信的时间字段是 createdFrom / createdTo（半开区间）
    const from = new Date('2026-10-26T10:00').getTime()
    const to = new Date('2026-10-26T12:00').getTime()
    fireEvent.change(screen.getByLabelText('进死信时间（起）'), {
      target: { value: '2026-10-26T10:00' },
    })
    fireEvent.change(screen.getByLabelText('进死信时间（止）'), {
      target: { value: '2026-10-26T12:00' },
    })

    await waitFor(() => {
      expect(deadLetterUrls.at(-1)).toContain(`createdFrom=${from}`)
      expect(deadLetterUrls.at(-1)).toContain(`createdTo=${to}`)
    })
  })

  it('详情展示载荷与重放留痕', async () => {
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/dead-letters')) {
        return { body: { deadLetters: [makeDeadLetter()], nextCursor: null } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<DeadLettersPage />)
    await screen.findByRole('table')

    await user.click(screen.getByLabelText('查看死信详情'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('exec-9').length).toBeGreaterThan(0)
    expect(within(dialog).getByText(/"letterId": "L-1"/)).toBeInTheDocument()
    expect(within(dialog).getByText('下游连续返回 500，重试已用尽')).toBeInTheDocument()
  })

  it('查询接口未挂载（501）时给出明确提示', async () => {
    installFetchMock((url) => {
      if (url.startsWith('/api/projects')) return { body: { projects: [project] } }
      if (url.startsWith('/api/jobs')) return { body: { jobs: [makeJob()], nextCursor: null } }
      if (url.startsWith('/api/dead-letters')) {
        return { status: 501, body: { error: 'not_implemented', scope: 'management-api' } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<DeadLettersPage />)

    expect(await screen.findByText('死信列表加载失败')).toBeInTheDocument()
    expect(screen.getByText(/还没有挂载死信查询与重放路由/)).toBeInTheDocument()
  })
})
