import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SecuritySection } from '@/components/settings/security-section'
import type { MeView } from '@/lib/auth-api'
import {
  authenticate,
  installFetchMock,
  renderWithProviders,
  requestBody,
  requestUrl,
  resetSessionState,
} from '@/test/utils'

/**
 * 「设置 → 安全」区（SPEC §5.3 / §8.4）。
 *
 * 覆盖四件事：
 *   1. TOTP 绑定必须「URI/二维码 → 输码确认」两步，确认前不置位；
 *   2. 解绑 TOTP 与删除 Passkey 都要复验密码（后端强制，页面显式化）；
 *   3. 邮件 OTP 在 provider 未配置时明确提示且不可启用（有意与 eNotify 分叉）；
 *   4. Passkey 增 / 列 / 改名 / 删，删光由后端自动关闭。
 */

const PASSKEY_REGISTRATION_RESPONSE = {
  id: 'cred-2',
  rawId: 'cred-2',
  type: 'public-key',
  response: { clientDataJSON: 'a', attestationObject: 'b' },
  clientExtensionResults: {},
}

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => PASSKEY_REGISTRATION_RESPONSE),
  startRegistration: vi.fn(async () => PASSKEY_REGISTRATION_RESPONSE),
}))

function makeMe(overrides: Partial<MeView> = {}): MeView {
  return {
    user: {
      id: 'user-1',
      email: 'me@example.com',
      displayName: '我',
      role: 'admin',
      isActive: true,
      createdAt: 1_730_000_000_000,
      updatedAt: 1_730_000_000_000,
      lastLoginAt: null,
    },
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

function makeSetupState(emailProvider: 'none' | 'smtp') {
  return {
    schemaVersion: 4,
    initialized: true,
    adminExists: true,
    registrationEnabled: false,
    emailProvider,
  }
}

describe('设置页 · 安全区', () => {
  beforeEach(resetSessionState)

  it('TOTP 绑定：先给 otpauth URI + 二维码，输码确认后才置启用', async () => {
    let me = makeMe()
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('none') }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      if (url === '/api/me/2fa/totp/setup') {
        return { body: { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/waker:me@example.com?secret=JBSWY3DPEHPK3PXP' } }
      }
      if (url === '/api/me/2fa/totp/enable') {
        me = makeMe({
          twoFactor: {
            totpEnabled: true,
            emailOtpEnabled: false,
            passkeyEnabled: false,
            preferredMethod: 'totp',
          },
          availableMethods: ['totp'],
        })
        return { body: me }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SecuritySection />)

    await user.click(await screen.findByRole('button', { name: /绑定身份验证器/ }))

    // URI + 密钥 + 二维码都要展示（二维码由 `qrcode` 原生生成 SVG）
    expect(await screen.findByText(/otpauth:\/\/totp\/waker:me@example.com/)).toBeInTheDocument()
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'TOTP 二维码' })).toBeInTheDocument()

    // 输码确认：OTP 框走 §5B 信号
    const otp = screen.getByLabelText('验证器上的 6 位验证码')
    expect(otp).toHaveAttribute('type', 'text')
    expect(otp).toHaveAttribute('autoComplete', 'one-time-code')
    expect(otp).toHaveAttribute('inputMode', 'numeric')
    await user.type(otp, '123456')
    await user.click(screen.getByRole('button', { name: /确认启用/ }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => item[0] === '/api/me/2fa/totp/enable')
      expect(requestBody(call)).toEqual({ code: '123456' })
    })
    // 启用后换成「已启用 + 解绑」态
    expect(await screen.findByText('已绑定身份验证器。解绑会清掉服务端保存的 secret，之后登录只用其它已启用方法。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /解绑身份验证器/ })).toBeInTheDocument()
  })

  it('解绑 TOTP 必须复验密码', async () => {
    const me = makeMe({
      twoFactor: {
        totpEnabled: true,
        emailOtpEnabled: false,
        passkeyEnabled: false,
        preferredMethod: 'totp',
      },
      availableMethods: ['totp'],
    })
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('none') }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      if (url === '/api/me/2fa/totp/disable') {
        return { status: 403, body: { error: { code: 'invalid_password', message: 'x' } } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SecuritySection />)

    await user.click(await screen.findByRole('button', { name: /解绑身份验证器/ }))
    const dialog = await screen.findByRole('dialog')
    const passwordInput = within(dialog).getByLabelText('当前密码')
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(passwordInput).toHaveAttribute('autoComplete', 'current-password')

    await user.type(passwordInput, 'wrong-current')
    await user.click(within(dialog).getByRole('button', { name: '确认解绑' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => item[0] === '/api/me/2fa/totp/disable')
      expect(requestBody(call)).toEqual({ password: 'wrong-current' })
    })
    // 密码不对：留在对话框并给出提示，不静默关闭
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument()
  })

  it('邮件 OTP：provider 未配置时明确提示且发送按钮禁用，不静默置位', async () => {
    const me = makeMe()
    installFetchMock((url) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('none') }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    renderWithProviders(<SecuritySection />)

    expect(
      await screen.findByText('管理员尚未配置邮件服务，此方法暂不可用'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /发送验证码/ })).toBeDisabled()
  })

  it('邮件 OTP：已配置 provider 时先发码验码再启用', async () => {
    let me = makeMe()
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('smtp') }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      if (url === '/api/me/2fa/email-otp/send') {
        return { body: { sent: true, expiresAt: Date.now() + 300_000 } }
      }
      if (url === '/api/me/2fa/email-otp/enable') {
        me = makeMe({
          twoFactor: {
            totpEnabled: false,
            emailOtpEnabled: true,
            passkeyEnabled: false,
            preferredMethod: 'email_otp',
          },
          availableMethods: ['email_otp'],
        })
        return { body: me }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SecuritySection />)

    await user.click(await screen.findByRole('button', { name: /发送验证码/ }))
    const otp = await screen.findByLabelText('邮件验证码')
    expect(otp).toHaveAttribute('id', 'email-otp-setup-code')
    expect(otp).toHaveAttribute('autoComplete', 'one-time-code')

    await user.type(otp, '987654')
    await user.click(screen.getByRole('button', { name: /确认启用/ }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => item[0] === '/api/me/2fa/email-otp/enable')
      expect(requestBody(call)).toEqual({ code: '987654' })
    })
  })

  it('Passkey：注册回传原始 response、可改名、删除要复验密码，删光后自动关闭', async () => {
    let passkeys = [
      { id: 'cred-2', name: 'MacBook 指纹', createdAt: 1_730_000_000_000 },
      { id: 'cred-3', name: 'YubiKey', createdAt: 1_730_100_000_000 },
    ]
    const me = makeMe({
      twoFactor: {
        totpEnabled: false,
        emailOtpEnabled: false,
        passkeyEnabled: true,
        preferredMethod: 'passkey',
      },
      availableMethods: ['passkey'],
    })
    const fetchMock = installFetchMock((url, init) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('none') }
      if (url === '/api/me/2fa/passkeys' && (init.method ?? 'GET') === 'GET') {
        return { body: { passkeys } }
      }
      if (url === '/api/me/2fa/passkey/options') return { body: { challenge: 'abc', rp: { id: 'localhost' } } }
      if (url === '/api/me/2fa/passkey/verify') {
        passkeys = [...passkeys, { id: 'cred-9', name: '新设备', createdAt: 1_730_200_000_000 }]
        return { status: 201, body: { passkey: passkeys.at(-1) } }
      }
      if (url === '/api/me/2fa/passkeys/cred-2' && init.method === 'PATCH') {
        passkeys = passkeys.map((item) => (item.id === 'cred-2' ? { ...item, name: '改过的名字' } : item))
        return { body: { passkeys } }
      }
      if (url === '/api/me/2fa/passkeys/cred-2' && init.method === 'DELETE') {
        passkeys = passkeys.filter((item) => item.id !== 'cred-2')
        return { body: { passkeys } }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SecuritySection />)

    // 列表：脱敏字段（名称 + 添加时间），不含凭证材料
    expect(await screen.findByText('MacBook 指纹')).toBeInTheDocument()
    expect(screen.getByText('YubiKey')).toBeInTheDocument()

    // 添加：WebAuthn 交给库，回传原始 response + 名称
    await user.type(screen.getByLabelText('新 Passkey 名称'), '新设备')
    await user.click(screen.getByRole('button', { name: /添加 Passkey/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => requestUrl(item) === '/api/me/2fa/passkey/verify')
      expect(requestBody(call)).toEqual({
        response: PASSKEY_REGISTRATION_RESPONSE,
        name: '新设备',
      })
    })
    expect(await screen.findByText('新设备')).toBeInTheDocument()

    // 改名：普通对话框（不索取密码）
    await user.click(screen.getAllByRole('button', { name: '改名' })[0]!)
    const renameDialog = await screen.findByRole('dialog')
    const renameInput = within(renameDialog).getByLabelText('新名称')
    await user.clear(renameInput)
    await user.type(renameInput, '改过的名字')
    await user.click(within(renameDialog).getByRole('button', { name: '保存名称' }))
    expect(await screen.findByText('改过的名字')).toBeInTheDocument()

    // 删除：复验密码后 DELETE 带 password
    await user.click(screen.getAllByRole('button', { name: /删除/ })[0]!)
    const deleteDialog = await screen.findByRole('dialog')
    await user.type(within(deleteDialog).getByLabelText('当前密码'), 'my-password')
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => requestUrl(item) === '/api/me/2fa/passkeys/cred-2' && (item[1] as RequestInit).method === 'DELETE',
      )
      expect(requestBody(call)).toEqual({ password: 'my-password' })
    })
  })

  it('首选方法只在已启用方法里选，改动发 PUT /api/me/2fa/preferred', async () => {
    const me = makeMe({
      twoFactor: {
        totpEnabled: true,
        emailOtpEnabled: false,
        passkeyEnabled: true,
        preferredMethod: 'totp',
      },
      availableMethods: ['totp', 'passkey'],
    })
    const fetchMock = installFetchMock((url) => {
      if (url === '/api/me') return { body: me }
      if (url === '/api/setup/state') return { body: makeSetupState('none') }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      if (url === '/api/me/2fa/preferred') {
        return {
          body: makeMe({
            twoFactor: {
              totpEnabled: true,
              emailOtpEnabled: false,
              passkeyEnabled: true,
              preferredMethod: 'passkey',
            },
            availableMethods: ['passkey', 'totp'],
          }),
        }
      }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SecuritySection />)

    const select = (await screen.findByLabelText('首选第二因素')) as HTMLSelectElement
    // 选项只包含已启用方法（邮件验证码未启用，不该出现）
    await waitFor(() => {
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        '',
        'totp',
        'passkey',
      ])
    })

    await user.selectOptions(select, 'passkey')
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => item[0] === '/api/me/2fa/preferred')
      expect(requestBody(call)).toEqual({ method: 'passkey' })
    })
  })
})
