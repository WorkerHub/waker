import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setAuthToken } from '@/lib/api'
import { useSession } from '@/stores/session'

/** 清掉上一个用例留下的会话（store 与 localStorage 都是模块级状态，跨用例会互相污染）。 */
export function resetSessionState(): void {
  setAuthToken(null)
  if (typeof localStorage !== 'undefined') localStorage.clear()
  useSession.setState({
    session: null,
    user: null,
    challenge: null,
    error: null,
    pending: false,
  })
}

/** 测试用会话：同时把令牌挂到 API client 与 store（与真实登录后的状态一致）。 */
export const TEST_SESSION_TOKEN = 'test-session-token'

export function authenticate(): void {
  setAuthToken(TEST_SESSION_TOKEN)
  useSession.setState({
    session: { token: TEST_SESSION_TOKEN, expiresAt: Date.now() + 3_600_000 },
    error: null,
  })
}

/** 渲染页面 + 真 Provider（主题 / 查询 / 路由 / Tooltip / Toast），不 mock 平台内部组件。 */
export function renderWithProviders(ui: ReactElement, { route = '/' } = {}): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

export interface MockResponse {
  status?: number
  body?: unknown
}

export type FetchHandler = (
  url: string,
  init: RequestInit,
) => MockResponse | Promise<MockResponse>

/**
 * 替身只放在最外层的 HTTP 边界（`fetch`）：页面 → API client → 契约 URL/请求体
 * 全都是真跑的，断言可以直接对着请求 URL 与 body 做。
 */
export function installFetchMock(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const response = await handler(url, init ?? {})
    return new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 记录到 `fetchMock.mock.calls` 里的请求体（JSON 反序列化）。 */
export function requestBody(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined
  const body = init?.body
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : {}
}

export function requestUrl(call: unknown[] | undefined): string {
  const input = call?.[0]
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : ''
}
