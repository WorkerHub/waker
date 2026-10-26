import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { LoginPage } from '@/pages/login-page'
import { useSession } from '@/stores/session'
import { installFetchMock, renderWithProviders, requestBody } from '@/test/utils'

describe('登录页（首次安装）', () => {
  it('输入按 §5B 自动填充规范标注，提交后换取会话', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/auth/setup') {
        return { body: { session: { token: 'session-token', expiresAt: Date.now() + 43_200_000 } } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    const input = screen.getByLabelText('SETUP_SECRET')
    expect(input).toHaveAttribute('name', 'setupSecret')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autoComplete', 'current-password')

    await user.type(input, 'my-setup-secret')
    await user.click(screen.getByRole('button', { name: /进入管理面/ }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/setup')
    expect(requestBody(call)).toEqual({ setupSecret: 'my-setup-secret' })
  })

  it('SETUP_SECRET 错误时留在登录页并提示', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/setup') {
        return { status: 401, body: { error: { code: 'unauthorized', message: 'SETUP_SECRET 不正确或未配置' } } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('SETUP_SECRET'), 'wrong-secret')
    await user.click(screen.getByRole('button', { name: /进入管理面/ }))

    expect(await screen.findByText('SETUP_SECRET 不正确')).toBeInTheDocument()
    expect(useSession.getState().session).toBeNull()
  })
})
