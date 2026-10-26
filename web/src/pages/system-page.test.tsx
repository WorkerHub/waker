import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { UserView, MeView, SystemSettingsView } from '@/lib/auth-api'
import type { SystemStatus } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { SystemPage } from '@/pages/system-page'
import {
  authenticate,
  installFetchMock,
  renderWithProviders,
  requestBody,
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

function makeUser(overrides: Partial<UserView> = {}): UserView {
  return {
    id: 'user-1',
    email: 'admin@example.com',
    displayName: '管理员',
    role: 'admin',
    isActive: true,
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    lastLoginAt: 1_730_599_000_000,
    ...overrides,
  }
}

function makeMe(user: UserView, overrides: Partial<MeView> = {}): MeView {
  return {
    user,
    twoFactor: {
      totpEnabled: false,
      emailOtpEnabled: false,
      passkeyEnabled: false,
      preferredMethod: null,
    },
    availableMethods: [],
    ...overrides,
  }
}

function makeSettings(overrides: Partial<SystemSettingsView> = {}): SystemSettingsView {
  return {
    registrationEnabled: false,
    email: {
      provider: 'none',
      smtp: {
        host: '',
        port: 587,
        username: '',
        from: '',
        fromName: '',
        secure: false,
        passwordConfigured: false,
      },
      resend: { from: '', fromName: '', apiKeyConfigured: false },
    },
    ...overrides,
  }
}

/** 系统管理页的只读快照部分（viewer 也看得到）。 */
describe('系统管理页 · 只读快照', () => {
  it('加载 /api/system/status 并展示 watchdog、存储、队列与密钥状态位', async () => {
    const status = makeStatus()
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status } }
      if (url === '/api/me') return { body: makeMe(makeUser({ role: 'viewer' })) }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    const { container } = renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

    // 状态快照只打一个接口，GET，无查询参数（页面不自造过滤条件）。
    const statusCalls = fetchMock.mock.calls.filter((call) => requestUrl(call) === '/api/system/status')
    expect(statusCalls).toHaveLength(1)
    expect((statusCalls[0]?.[1] as RequestInit | undefined)?.method).toBeUndefined()

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

  it('viewer 看不到管理面，只有「仅管理员」提示', async () => {
    installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status: makeStatus() } }
      if (url === '/api/me') return { body: makeMe(makeUser({ role: 'viewer' })) }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

    expect(await screen.findByText('管理面仅管理员可见')).toBeInTheDocument()
    expect(screen.queryByText('用户管理')).not.toBeInTheDocument()
    expect(screen.queryByText('注册开关')).not.toBeInTheDocument()
    expect(screen.queryByText('邮件服务')).not.toBeInTheDocument()
    // 状态快照仍是只读：没有可编辑控件
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('密钥状态位只读：未配置时提示「部署前须配置」', async () => {
    const status = makeStatus({
      secrets: { setupSecretConfigured: true, jwtSecretConfigured: false },
      watchdogLastRunAt: null,
      watchdogLastDueJobs: null,
      nextWakeAt: null,
    })
    installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status } }
      if (url === '/api/me') return { body: makeMe(makeUser({ role: 'viewer' })) }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<SystemPage />)
    await screen.findByText('watchdog（全仓唯一 Cron）')

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
      if (url === '/api/me') return { body: makeMe(makeUser({ role: 'viewer' })) }
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
      if (url === '/api/me') return { body: makeMe(makeUser({ role: 'viewer' })) }
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

/** 系统管理页的管理面（仅 admin）：用户管理 / 注册开关 / 邮件服务。 */
describe('系统管理页 · 管理面（admin）', () => {
  it('用户列表：最后一个管理员不可降级 / 禁用 / 删除', async () => {
    const me = makeUser()
    const lastAdmin = makeUser({ id: 'user-1', role: 'admin', displayName: '唯一管理员' })
    const viewer = makeUser({
      id: 'user-2',
      email: 'viewer@example.com',
      displayName: '只读同学',
      role: 'viewer',
      lastLoginAt: null,
    })

    installFetchMock((url) => {
      if (url === '/api/system/status') return { body: { status: makeStatus() } }
      if (url === '/api/me') return { body: makeMe(me) }
      if (url === '/api/users') return { body: { users: [lastAdmin, viewer] } }
      if (url === '/api/system/settings') return { body: makeSettings() }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<SystemPage />)
    await screen.findByText('只读同学')

    // 唯一（启用中的）管理员：降级 / 禁用 / 删除全部禁用，并给出原因
    const demote = screen.getAllByRole('button', { name: '降为只读' })[0]
    expect(demote).toBeDisabled()
    const disable = screen.getAllByRole('button', { name: '禁用' })[0]
    expect(disable).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /删除/ })[0]).toBeDisabled()
    expect(demote).toHaveAttribute('title', '最后一个管理员不能被降级（会锁死管理面）')

    // viewer 行可以升级 / 禁用 / 删除
    expect(screen.getByRole('button', { name: '升为管理员' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: '删除' }).at(-1)).toBeEnabled()
  })

  it('升角色走 PATCH /api/users/:id，body 只有 role', async () => {
    const target = makeUser({
      id: 'user-2',
      email: 'viewer@example.com',
      displayName: '只读同学',
      role: 'viewer',
    })
    const fetchMock = installFetchMock((url, init) => {
      if (url === '/api/system/status') return { body: { status: makeStatus() } }
      if (url === '/api/me') return { body: makeMe(makeUser()) }
      if (url === '/api/users' && (init.method ?? 'GET') === 'GET') {
        return { body: { users: [makeUser(), target] } }
      }
      if (url === '/api/users/user-2' && init.method === 'PATCH') {
        return { body: { user: { ...target, role: 'admin' } } }
      }
      if (url === '/api/system/settings') return { body: makeSettings() }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SystemPage />)
    await user.click(await screen.findByRole('button', { name: '升为管理员' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => requestUrl(item) === '/api/users/user-2' && (item[1] as RequestInit).method === 'PATCH',
      )
      expect(requestBody(call)).toEqual({ role: 'admin' })
    })
  })

  it('注册开关：PUT /api/system/settings/registration {enabled}', async () => {
    const fetchMock = installFetchMock((url, init) => {
      if (url === '/api/system/status') return { body: { status: makeStatus() } }
      if (url === '/api/me') return { body: makeMe(makeUser()) }
      if (url === '/api/users') return { body: { users: [makeUser()] } }
      if (url === '/api/system/settings' && (init.method ?? 'GET') === 'GET') {
        return { body: makeSettings({ registrationEnabled: false }) }
      }
      if (url === '/api/system/settings/registration' && init.method === 'PUT') {
        return { body: makeSettings({ registrationEnabled: true }) }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SystemPage />)
    const toggle = await screen.findByRole('switch', { name: '注册已关闭' })
    await user.click(toggle)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => requestUrl(item) === '/api/system/settings/registration',
      )
      expect(requestBody(call)).toEqual({ enabled: true })
    })
  })

  it('邮件配置：脱敏展示、留空=不改、测试邮件', async () => {
    const settings = makeSettings({
      email: {
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          username: 'notify',
          from: 'noreply@example.com',
          fromName: 'waker',
          secure: false,
          passwordConfigured: true,
        },
        resend: { from: '', fromName: '', apiKeyConfigured: false },
      },
    })
    const fetchMock = installFetchMock((url, init) => {
      if (url === '/api/system/status') return { body: { status: makeStatus() } }
      if (url === '/api/me') return { body: makeMe(makeUser()) }
      if (url === '/api/users') return { body: { users: [makeUser()] } }
      if (url === '/api/system/settings' && (init.method ?? 'GET') === 'GET') return { body: settings }
      if (url === '/api/system/settings/email' && init.method === 'PUT') return { body: settings }
      if (url === '/api/system/settings/email/test' && init.method === 'POST') {
        return { body: { sent: true } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SystemPage />)

    // 脱敏：只报「已配置」，输入框留空且 placeholder 说明不修改
    const passwordInput = await screen.findByLabelText('密码')
    expect(passwordInput).toHaveValue('')
    expect(passwordInput).toHaveAttribute('placeholder', '已配置，留空表示不修改')
    expect(screen.getByText('已配置（不回显）')).toBeInTheDocument()

    // 只改发件人名称 → 请求体里不带 password（留空 = 不改）
    await user.clear(screen.getByLabelText('发件人名称'))
    await user.type(screen.getByLabelText('发件人名称'), 'waker-bot')
    await user.click(screen.getByRole('button', { name: /保存配置/ }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) =>
          requestUrl(item) === '/api/system/settings/email' &&
          (item[1] as RequestInit).method === 'PUT',
      )
      expect(requestBody(call)).toEqual({
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          username: 'notify',
          from: 'noreply@example.com',
          fromName: 'waker-bot',
          secure: false,
        },
      })
    })

    // 测试邮件
    await user.click(screen.getByRole('button', { name: /发送测试邮件/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => requestUrl(item) === '/api/system/settings/email/test',
      )
      expect(requestBody(call)).toEqual({})
    })
    expect(await screen.findByText(/测试邮件已发送到你的管理员邮箱/)).toBeInTheDocument()
  })
})
