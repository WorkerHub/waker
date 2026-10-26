import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { RegisterPage } from '@/pages/register-page'
import { useSession } from '@/stores/session'
import {
  installFetchMock,
  renderWithProviders,
  requestBody,
  resetSessionState,
} from '@/test/utils'

/**
 * 注册页（SPEC §4.2 / §8.2）。
 *
 * 关键点：开关关闭时**不是把表单禁用**，而是 DOM 里根本不存在注册表单 ——
 * 这与后端 403 `registration_closed` 一起构成双层防线（前端不给入口，后端不认请求）。
 */

const SESSION = { token: 'session-token', expiresAt: Date.now() + 43_200_000 }

function makeState(registrationEnabled: boolean) {
  return {
    schemaVersion: 4,
    initialized: true,
    adminExists: true,
    registrationEnabled,
    emailProvider: 'none',
  }
}

describe('注册页', () => {
  beforeEach(resetSessionState)

  it('开关关闭：只显示关闭提示，DOM 里没有任何注册表单', async () => {
    installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: makeState(false) }
      throw new Error(`未预期的请求：${url}`)
    })

    const { container } = renderWithProviders(<RegisterPage />, { route: '/register' })

    expect(await screen.findByText('管理员尚未开放注册')).toBeInTheDocument()
    const loginLinks = screen.getAllByRole('link', { name: '去登录' })
    expect(loginLinks.length).toBeGreaterThan(0)
    expect(loginLinks[0]).toHaveAttribute('href', '/login')
    expect(container.querySelectorAll('form')).toHaveLength(0)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /注册并登录/ })).toBeNull()
  })

  it('开关打开：注册即登录（viewer），新密码用 new-password 信号', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: makeState(true) }
      if (url === '/api/auth/register') {
        return {
          status: 201,
          body: {
            user: {
              id: 'user-2',
              email: 'new@example.com',
              displayName: '新人',
              role: 'viewer',
              isActive: true,
              createdAt: 1_730_000_000_000,
              updatedAt: 1_730_000_000_000,
              lastLoginAt: null,
            },
            session: SESSION,
          },
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<RegisterPage />, { route: '/register' })
    const user = userEvent.setup()

    const password = await screen.findByLabelText('密码')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autoComplete', 'new-password')
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('autoComplete', 'email')

    await user.type(screen.getByLabelText('昵称'), '新人')
    await user.type(screen.getByLabelText('邮箱'), 'new@example.com')
    await user.type(password, 'brand-new-pass')
    await user.click(screen.getByRole('button', { name: /注册并登录/ }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    expect(useSession.getState().user?.role).toBe('viewer')

    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/register')
    expect(requestBody(call)).toEqual({
      email: 'new@example.com',
      password: 'brand-new-pass',
      displayName: '新人',
    })
  })

  it('注册被后端关闭（403 registration_closed）：明确提示并刷新开关状态', async () => {
    let stateCalls = 0
    installFetchMock((url) => {
      if (url === '/api/setup/state') {
        stateCalls += 1
        // 第一次「还以为开着」，注册被拒后重新拉状态 → 已关闭
        return { body: makeState(stateCalls === 1) }
      }
      if (url === '/api/auth/register') {
        return {
          status: 403,
          body: { error: { code: 'registration_closed', message: '管理员尚未开放注册' } },
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<RegisterPage />, { route: '/register' })
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('昵称'), '新人')
    await user.type(screen.getByLabelText('邮箱'), 'new@example.com')
    await user.type(screen.getByLabelText('密码'), 'brand-new-pass')
    await user.click(screen.getByRole('button', { name: /注册并登录/ }))

    // 关闭提示出现，表单被撤掉（不再给可提交的入口）
    await waitFor(() => {
      expect(screen.getByText('管理员尚未开放注册')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('密码')).toBeNull()
    expect(useSession.getState().session).toBeNull()
  })
})
