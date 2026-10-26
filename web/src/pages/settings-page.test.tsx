import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { MeView } from '@/lib/auth-api'
import { formatDateTime } from '@/lib/format'
import { PLATFORM_DOMAIN, PLATFORM_REPO_URL, PLATFORM_VERSION } from '@/lib/platform'
import { SettingsPage } from '@/pages/settings-page'
import {
  authenticate,
  installFetchMock,
  renderWithProviders,
  resetSessionState,
} from '@/test/utils'
import { useSession } from '@/stores/session'

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
      lastLoginAt: 1_730_599_000_000,
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

describe('设置页', () => {
  beforeEach(resetSessionState)

  it('展示个人资料、安全区与平台信息，且不渲染会话令牌', async () => {
    installFetchMock((url) => {
      if (url === '/api/me') return { body: makeMe() }
      if (url === '/api/setup/state') {
        return {
          body: {
            schemaVersion: 4,
            initialized: true,
            adminExists: true,
            registrationEnabled: false,
            emailProvider: 'none',
          },
        }
      }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()

    const { container } = renderWithProviders(<SettingsPage />)
    await screen.findByText('平台信息')

    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
    // 分区：个人资料 / 安全 / 平台信息（安全区独立成段，不塞系统管理）
    expect(screen.getByText('个人资料')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '安全' })).toBeInTheDocument()
    expect(screen.getByText('身份验证器（TOTP）')).toBeInTheDocument()
    expect(screen.getAllByText('邮件验证码').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Passkey').length).toBeGreaterThan(0)

    // 平台信息是构建期事实：版本来自 __APP_VERSION__（vitest 里注入 'test'）。
    expect(screen.getAllByText(PLATFORM_VERSION).length).toBeGreaterThan(0)
    expect(container.textContent).toContain(PLATFORM_DOMAIN)
    expect(screen.getByRole('link', { name: PLATFORM_REPO_URL })).toHaveAttribute(
      'href',
      PLATFORM_REPO_URL,
    )

    // 会话：只展示有效期，不展示令牌本身。
    const session = useSession.getState().session
    expect(session).not.toBeNull()
    expect(container.textContent).toContain(formatDateTime(session?.expiresAt))
    expect(container.textContent).not.toContain(session?.token ?? '<no-token>')
  })

  it('退出登录只清本地会话', async () => {
    installFetchMock((url) => {
      if (url === '/api/me') return { body: makeMe() }
      if (url === '/api/setup/state') {
        return {
          body: {
            schemaVersion: 4,
            initialized: true,
            adminExists: true,
            registrationEnabled: false,
            emailProvider: 'none',
          },
        }
      }
      if (url === '/api/me/2fa/passkeys') return { body: { passkeys: [] } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SettingsPage />)
    await screen.findByText('平台信息')

    await user.click(screen.getByRole('button', { name: /退出登录/ }))
    await waitFor(() => {
      expect(useSession.getState().session).toBeNull()
    })
    expect(await screen.findByText('未登录')).toBeInTheDocument()
  })
})
