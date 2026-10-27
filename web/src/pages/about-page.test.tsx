import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AboutPage } from '@/pages/about-page'
import { getPlatformDomain, PLATFORM_REPO_URL, PLATFORM_VERSION } from '@/lib/platform'
import { installFetchMock, renderWithProviders } from '@/test/utils'

/** 关于页 smoke：纯静态页面可加载，内容与 SPEC v1.0 一致，且不发任何请求。 */
describe('关于页', () => {
  it('展示平台定位、内核要点与版本信息，且不发任何请求', async () => {
    const fetchMock = installFetchMock(() => {
      throw new Error('关于页不该发请求')
    })

    const { container } = renderWithProviders(<AboutPage />)
    await screen.findByRole('heading', { level: 1, name: '关于' })

    // 内核要点（SPEC v1.0）
    expect(screen.getByText('Durable Object Alarm 内核')).toBeInTheDocument()
    expect(screen.getByText('两类任务模型')).toBeInTheDocument()
    expect(screen.getByText('单一真源')).toBeInTheDocument()
    expect(screen.getByText('回调协议 v2')).toBeInTheDocument()
    expect(screen.getAllByText(/1（watchdog，每小时）/).length).toBeGreaterThan(0)

    // 版本与环境；域名取运行时当前访问域名（test 环境：jsdom 的 location.host）
    expect(screen.getAllByText(PLATFORM_VERSION).length).toBeGreaterThan(0)
    expect(getPlatformDomain()).toBe(window.location.host)
    expect(container.textContent).toContain(window.location.host)
    expect(screen.getByRole('link', { name: PLATFORM_REPO_URL })).toHaveAttribute(
      'href',
      PLATFORM_REPO_URL,
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
