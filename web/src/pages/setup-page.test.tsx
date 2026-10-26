import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { SetupPage } from '@/pages/setup-page'
import { useSession } from '@/stores/session'
import {
  installFetchMock,
  renderWithProviders,
  requestBody,
  resetSessionState,
} from '@/test/utils'

/**
 * `/setup` 初始化页（SPEC §3 / §8.1）。
 *
 * 断言的三个状态都是**互斥**的：
 *   1. 未初始化 → 只有 SETUP_SECRET 表单；
 *   2. 拿到 bootstrap 令牌 → 只有建首管表单（bootstrap 令牌留在内存，不回显）；
 *   3. 已初始化 → 只有「已完成初始化，去登录」，**DOM 里没有 setup 表单**。
 */

const SESSION = { token: 'session-token', expiresAt: Date.now() + 43_200_000 }

const UNINITIALIZED = {
  schemaVersion: 4,
  initialized: false,
  adminExists: false,
  registrationEnabled: false,
  emailProvider: 'none',
}

const INITIALIZED = {
  schemaVersion: 4,
  initialized: true,
  adminExists: true,
  registrationEnabled: false,
  emailProvider: 'none',
}

describe('初始化页', () => {
  beforeEach(resetSessionState)

  it('SETUP_SECRET 框的 §5B 信号：id/name=setup-secret、autocomplete=off、提交后清空', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: UNINITIALIZED }
      if (url === '/api/setup') {
        return { status: 401, body: { error: { code: 'invalid_credentials', message: 'x' } } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<SetupPage />, { route: '/setup' })
    const user = userEvent.setup()

    const input = (await screen.findByLabelText('SETUP_SECRET')) as HTMLInputElement
    expect(input).toHaveAttribute('id', 'setup-secret')
    expect(input).toHaveAttribute('name', 'setup-secret')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autoComplete', 'off')

    await user.type(input, 'wrong-setup-secret')
    await user.click(screen.getByRole('button', { name: /验证并继续/ }))

    // 提交后立刻清空（错密钥也一样，桌面不应留着 secret）
    await waitFor(() => {
      expect(input.value).toBe('')
    })
    expect(await screen.findByText('SETUP_SECRET 不正确或未配置')).toBeInTheDocument()
    // 仍在第一步：没有建首管表单
    expect(screen.queryByLabelText('管理员邮箱')).toBeNull()

    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/setup')
    expect(requestBody(call)).toEqual({ setupSecret: 'wrong-setup-secret' })
  })

  it('密钥通过后进入建首管表单：bootstrap 令牌随请求提交，成功后拿到会话', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: UNINITIALIZED }
      if (url === '/api/setup') {
        return {
          body: {
            schemaVersion: 4,
            adminExists: false,
            bootstrapToken: 'bootstrap-token',
            expiresAt: Date.now() + 600_000,
          },
        }
      }
      if (url === '/api/setup/admin') {
        return {
          status: 201,
          body: {
            user: {
              id: 'user-1',
              email: 'admin@example.com',
              displayName: '管理员',
              role: 'admin',
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

    renderWithProviders(<SetupPage />, { route: '/setup' })
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('SETUP_SECRET'), 'good-secret')
    await user.click(screen.getByRole('button', { name: /验证并继续/ }))

    // 第二步：邮箱 / 昵称 / 密码（新建密码 → new-password）
    const email = await screen.findByLabelText('管理员邮箱')
    expect(email).toHaveAttribute('autoComplete', 'email')
    const password = screen.getByLabelText('密码')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autoComplete', 'new-password')

    await user.type(email, 'admin@example.com')
    await user.type(screen.getByLabelText('昵称'), '管理员')
    await user.type(password, 'first-admin-pass')
    await user.click(screen.getByRole('button', { name: /创建管理员并进入/ }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    expect(useSession.getState().user?.role).toBe('admin')

    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/setup/admin')
    expect(requestBody(call)).toEqual({
      bootstrapToken: 'bootstrap-token',
      email: 'admin@example.com',
      password: 'first-admin-pass',
      displayName: '管理员',
    })
  })

  it('已初始化：只显示「已完成初始化，去登录」，DOM 里没有任何 setup 表单', async () => {
    installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: INITIALIZED }
      throw new Error(`未预期的请求：${url}`)
    })

    const { container } = renderWithProviders(<SetupPage />, { route: '/setup' })

    expect(
      await screen.findByRole('heading', { level: 1, name: '已完成初始化' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /去登录/ })).toHaveAttribute('href', '/login')
    // 表单类节点一个都不许出现（没有输入框、没有提交按钮、没有 form 元素）
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(container.querySelectorAll('form')).toHaveLength(0)
    expect(screen.queryByText('SETUP_SECRET')).toBeNull()
  })

  it('未初始化时打开任意页面都会被引导到 /setup（SPEC §3.1）', async () => {
    installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: UNINITIALIZED }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<App />, { route: '/login' })

    // 落在初始化页，而不是登录页
    expect(await screen.findByRole('heading', { name: '初始化 waker' })).toBeInTheDocument()
    expect(screen.queryByLabelText('邮箱')).toBeNull()
  })
})
