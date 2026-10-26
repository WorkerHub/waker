import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { SystemStatus } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { SystemPage } from '@/pages/system-page'
import {
  authenticate,
  installFetchMock,
  renderWithProviders,
  requestUrl,
  TEST_SESSION_TOKEN,
} from '@/test/utils'

/**
 * 冻结契约夹具：`GET /api/system/status` 的应答形状
 * = B2 `SystemStatusView` + B4 HTTP 层补的 `secrets` 状态位 / `queue` 队列名。
 * 注意契约里 `secrets` **只有布尔**：连掩码都没有，页面不可能渲染出值。
 */
function makeStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    now: 1_730_600_000_000,
    schemaVersion: 3,
    watchdogLastRunAt: 1_730_599_000_000,
    watchdogLastDueJobs: 2,
    nextWakeAt: 1_730_600_600_000,
    counts: {
      projects: 2,
      jobs: 5,
      activeJobs: 4,
      executions: 12,
      pendingDispatches: 0,
      deadLetters: 1,
    },
    secrets: { setupSecretConfigured: true, jwtSecretConfigured: true },
    queue: { main: 'waker-jobs', deadLetter: 'waker-dlq' },
    ...overrides,
  }
}

/** 系统管理页 smoke：状态位展示（watchdog / 存储 / 队列 / 密钥配置），只读且不含任何密钥值。 */
describe('系统管理页', () => {
  it('加载 /api/system/status 并展示 watchdog、存储、队列与密钥状态位', async () => {
    const status = makeStatus()
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    const { container } = renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

    // 只打这一个接口，GET，无查询参数（页面不自造过滤条件）。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestUrl(fetchMock.mock.calls[0])).toBe('/api/system/status')

    // watchdog：上次运行时刻 + 上次到期任务数 + 下次唤醒
    expect(container.textContent).toContain(formatDateTime(status.watchdogLastRunAt))
    expect(container.textContent).toContain(formatDateTime(status.nextWakeAt))
    expect(container.textContent).toContain('2 个（watchdog 幂等，只补漏）')

    // 存储：schema 版本 + 计数
    expect(screen.getByText('schema v3')).toBeInTheDocument()
    expect(container.textContent).toContain('12')
    expect(container.textContent).toContain('5 个（active 4）')

    // 队列：主队列 / 死信队列名 + 死信条数
    expect(container.textContent).toContain('waker-jobs')
    expect(container.textContent).toContain('waker-dlq')
    expect(screen.getByText('正常')).toBeInTheDocument()

    // 密钥状态位：两把都「已配置」，且只有状态、没有任何值
    expect(screen.getByText('SETUP_SECRET')).toBeInTheDocument()
    expect(screen.getByText('JWT_SECRET')).toBeInTheDocument()
    expect(screen.getAllByText('已配置')).toHaveLength(2)
    expect(container.textContent).not.toContain(TEST_SESSION_TOKEN)
  })

  it('密钥状态位只读：没有输入框 / 保存按钮，未配置时提示「部署前须配置」', async () => {
    const status = makeStatus({
      secrets: { setupSecretConfigured: true, jwtSecretConfigured: false },
      watchdogLastRunAt: null,
      watchdogLastDueJobs: null,
      nextWakeAt: null,
    })
    installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

    // 只读状态位：没有可编辑控件
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument()

    // 一true一false 各自的状态位
    expect(screen.getAllByText('已配置')).toHaveLength(1)
    expect(screen.getAllByText('未配置')).toHaveLength(1)

    // 从未跑过 / 没有待跑任务时给出明确文案，而不是空白或 0 假值
    expect(screen.getByText('尚未运行')).toBeInTheDocument()
    expect(screen.getByText('从未记录')).toBeInTheDocument()
    expect(screen.getByText('无 alarm（当前没有待跑任务）')).toBeInTheDocument()
  })

  it('待投递 > 0 时标出 Queue 积压', async () => {
    const status = makeStatus({
      counts: {
        projects: 0,
        jobs: 0,
        activeJobs: 0,
        executions: 3,
        pendingDispatches: 3,
        deadLetters: 0,
      },
    })
    installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    const { container } = renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

    expect(screen.getByText('有积压')).toBeInTheDocument()
    expect(container.textContent).toContain('3 条（Queue 投递落后）')
  })

  it('接口未挂载（501）时给出明确提示并可重试', async () => {
    let attempts = 0
    installFetchMock((url) => {
      if (url === '/api/system/status') {
        attempts += 1
        if (attempts === 1) {
          return { status: 501, body: { error: 'not_implemented', scope: 'management-api' } }
        }
        return { body: { status: makeStatus() } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SystemPage />)
    const alert = await screen.findByText('系统状态加载失败')
    expect(alert).toBeInTheDocument()
    expect(screen.getByText(/后端还没挂载/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(screen.getByText('watchdog（全仓唯一 Cron）')).toBeInTheDocument()
    })
  })
})
