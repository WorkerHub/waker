import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LoginPage } from '@/pages/login-page'
import { useSession } from '@/stores/session'
import {
  installFetchMock,
  renderWithProviders,
  requestBody,
  resetSessionState,
} from '@/test/utils'

/**
 * 两步登录（SPEC §5.1 / §5B）。
 *
 * 这里断言的是**节点身份**而不是「文字变了」：密码步与 2FA 步必须是不同的 DOM 节点，
 * 否则密码管理器会把同一个输入框从「当前密码」重解释成「一次性验证码」（vaultwarden 串位）。
 */

const PASSKEY_RESPONSE = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' },
  clientExtensionResults: {},
}

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => PASSKEY_RESPONSE),
  startRegistration: vi.fn(async () => PASSKEY_RESPONSE),
}))

const SETUP_STATE = {
  schemaVersion: 4,
  initialized: true,
  adminExists: true,
  registrationEnabled: false,
  emailProvider: 'none',
}

function makeUser(displayName = '我') {
  return {
    id: 'user-1',
    email: 'me@example.com',
    displayName,
    role: 'viewer',
    isActive: true,
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    lastLoginAt: null,
  }
}

const SESSION = { token: 'session-token', expiresAt: Date.now() + 43_200_000 }

describe('登录页 · 密码步', () => {
  beforeEach(resetSessionState)

  it('自动填充信号：密码框独占 type=password + current-password，登录成功即拿会话', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      if (url === '/api/auth/login') {
        return { body: { requiresTwoFactor: false, user: makeUser(), session: SESSION } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    const email = await screen.findByLabelText('邮箱')
    expect(email).toHaveAttribute('type', 'email')
    expect(email).toHaveAttribute('autoComplete', 'username')

    const password = screen.getByLabelText('密码')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autoComplete', 'current-password')
    // 密码框独占：登录第一步的 DOM 里只有这一个 password 输入。
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1)

    await user.type(email, 'me@example.com')
    await user.type(password, 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/login')
    expect(requestBody(call)).toEqual({ email: 'me@example.com', password: 'correct-horse-battery' })
  })

  it('凭据错误时留在密码步并提示，不清掉已有本地会话语义（这里本就没有会话）', async () => {
    installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      if (url === '/api/auth/login') {
        return { status: 401, body: { error: { code: 'invalid_credentials', message: '邮箱或密码不正确' } } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('邮箱'), 'me@example.com')
    await user.type(screen.getByLabelText('密码'), 'wrong-password-1')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('邮箱或密码不正确')).toBeInTheDocument()
    expect(useSession.getState().session).toBeNull()
    // 403/401 不应该把页面推到第二步
    expect(useSession.getState().challenge).toBeNull()
  })

  it('注册入口按开关显隐（关闭时不出现注册链接）', async () => {
    installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    await screen.findByLabelText('密码')
    expect(screen.queryByRole('link', { name: '注册' })).toBeNull()
    expect(screen.getByText(/当前未开放/)).toBeInTheDocument()
  })
})

describe('登录页 · 第二步（2FA）', () => {
  beforeEach(resetSessionState)

  it('方法列表按后端顺序（preferred 优先），换步换 DOM 节点，验证码信号齐全', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      if (url === '/api/auth/login') {
        return {
          body: {
            requiresTwoFactor: true,
            user: makeUser(),
            // 后端已按 preferred 排序：passkey 在前
            methods: ['passkey', 'totp'],
            tempToken: 'temp-token',
            expiresAt: Date.now() + 300_000,
          },
        }
      }
      if (url === '/api/auth/2fa/verify') {
        return { body: { user: makeUser(), session: SESSION } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    const passwordNode = await screen.findByLabelText('密码')
    await user.type(screen.getByLabelText('邮箱'), 'me@example.com')
    await user.type(passwordNode, 'totp-login-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    // 步骤切换：密码框节点从文档里消失，第二步没有任何 password 输入。
    await waitFor(() => {
      expect(passwordNode.isConnected).toBe(false)
    })
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)

    // 方法列表顺序 = 后端顺序（preferred 优先），第一个带「推荐」标
    const methodGroup = screen.getByRole('group', { name: '第二因素方式' })
    const methodButtons = within(methodGroup).getAllByRole('button')
    expect(methodButtons[0]).toHaveTextContent('Passkey')
    expect(methodButtons[0]).toHaveTextContent('推荐')
    expect(methodButtons[1]).toHaveTextContent('身份验证器')
    // 默认选中第一个（= preferred）
    expect(methodButtons[0]).toHaveAttribute('aria-pressed', 'true')

    // 切到身份验证器：出现单框 OTP，§5B 全信号
    await user.click(methodButtons[1]!)
    const otp = screen.getByLabelText('身份验证器验证码')
    expect(otp).toHaveAttribute('type', 'text')
    expect(otp).toHaveAttribute('autoComplete', 'one-time-code')
    expect(otp).toHaveAttribute('inputMode', 'numeric')
    expect(otp).toHaveAttribute('name', 'code')
    expect(otp).toHaveAttribute('id', 'totp-code')
    expect((otp.getAttribute('name') ?? '').includes('password')).toBe(false)
    expect((otp.getAttribute('id') ?? '').includes('password')).toBe(false)

    // 切走再切回：验证码输入是**新节点**（key 变化强制换 DOM）
    await user.click(methodButtons[0]!)
    expect(screen.queryByLabelText('身份验证器验证码')).toBeNull()
    await user.click(methodButtons[1]!)
    const otpAgain = screen.getByLabelText('身份验证器验证码')
    expect(otpAgain).not.toBe(otp)

    // 非数字会被过滤掉，提交带 tempToken + method + code
    await user.type(otpAgain, '12a3456')
    expect(otpAgain).toHaveValue('123456')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/2fa/verify')
    expect(requestBody(call)).toEqual({ tempToken: 'temp-token', method: 'totp', code: '123456' })
  })

  it('邮件验证码：发送成功后出现单框 OTP；发送失败（未配 provider）明确提示且不出现输入框', async () => {
    let sendAttempts = 0
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      if (url === '/api/auth/login') {
        return {
          body: {
            requiresTwoFactor: true,
            user: makeUser(),
            methods: ['email_otp'],
            tempToken: 'temp-token',
            expiresAt: Date.now() + 300_000,
          },
        }
      }
      if (url === '/api/auth/2fa/otp/send') {
        sendAttempts += 1
        if (sendAttempts === 1) {
          return {
            status: 409,
            body: { error: { code: 'email_not_configured', message: '管理员尚未配置邮件服务' } },
          }
        }
        return { body: { sent: true, expiresAt: Date.now() + 300_000 } }
      }
      if (url === '/api/auth/2fa/verify') {
        return { body: { user: makeUser(), session: SESSION } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('邮箱'), 'me@example.com')
    await user.type(screen.getByLabelText('密码'), 'email-otp-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    // 失败关闭：明确提示，且没有可用的验证码输入框
    await user.click(await screen.findByRole('button', { name: /发送验证码/ }))
    expect(
      await screen.findByText('管理员尚未配置邮件服务，此方法暂不可用'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('邮件验证码')).toBeNull()

    // 第二次发送成功 → 出现 OTP 输入（同一个 key，但只在发送后才渲染）
    await user.click(screen.getByRole('button', { name: /发送验证码/ }))
    const otp = await screen.findByLabelText('邮件验证码')
    expect(otp).toHaveAttribute('id', 'email-otp-code')
    expect(otp).toHaveAttribute('autoComplete', 'one-time-code')

    await user.type(otp, '654321')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))
    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/2fa/verify')
    expect(requestBody(call)).toEqual({
      tempToken: 'temp-token',
      method: 'email_otp',
      code: '654321',
    })
  })

  it('Passkey：交给 @simplewebauthn/browser 完成断言，再回传原始 response', async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/setup/state') return { body: SETUP_STATE }
      if (url === '/api/auth/login') {
        return {
          body: {
            requiresTwoFactor: true,
            user: makeUser(),
            methods: ['passkey'],
            tempToken: 'temp-token',
            expiresAt: Date.now() + 300_000,
          },
        }
      }
      if (url === '/api/auth/2fa/passkey/options') return { body: { challenge: 'abc', rpId: 'localhost' } }
      if (url === '/api/auth/2fa/passkey/verify') {
        return { body: { user: makeUser(), session: SESSION } }
      }
      throw new Error(`未预期的请求：${url}`)
    })

    renderWithProviders(<LoginPage />, { route: '/login' })
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('邮箱'), 'me@example.com')
    await user.type(screen.getByLabelText('密码'), 'passkey-login-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await user.click(await screen.findByRole('button', { name: /使用 Passkey 登录/ }))

    await waitFor(() => {
      expect(useSession.getState().session?.token).toBe('session-token')
    })
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/auth/2fa/passkey/verify')
    expect(requestBody(call)).toEqual({ tempToken: 'temp-token', response: PASSKEY_RESPONSE })
  })
})
