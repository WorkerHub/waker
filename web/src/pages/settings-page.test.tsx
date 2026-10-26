import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { SettingsPage } from '@/pages/settings-page'
import { formatDateTime } from '@/lib/format'
import { PLATFORM_DOMAIN, PLATFORM_REPO_URL, PLATFORM_VERSION } from '@/lib/platform'
import { authenticate, installFetchMock, renderWithProviders } from '@/test/utils'
import { useSession } from '@/stores/session'

/**
 * 设置页 smoke：平台信息（版本 / 域名）与当前会话可加载；
 * 页面纯本地数据（不发任何请求），也不渲染会话令牌。
 */
describe('设置页', () => {
  it('展示平台信息与当前会话，且不发任何请求、不渲染会话令牌', async () => {
    const fetchMock = installFetchMock(() => {
      throw new Error('设置页不该发请求')
    })
    authenticate()

    const { container } = renderWithProviders(<SettingsPage />)
    await screen.findByText('平台信息')

    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
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

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('没有可写设置项：不出输入框，退出登录只清本地会话', async () => {
    installFetchMock(() => {
      throw new Error('设置页不该发请求')
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<SettingsPage />)
    await screen.findByText('基础设置项')

    // 「按 SPEC 有则做，无则只做展示」：契约里没有可写设置项，页面就不给假开关。
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /退出登录/ }))
    await waitFor(() => {
      expect(useSession.getState().session).toBeNull()
    })
    expect(await screen.findByText('未登录')).toBeInTheDocument()
  })
})
