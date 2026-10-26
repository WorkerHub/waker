import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { setAuthToken } from '@/lib/api'
import { useSession } from '@/stores/session'

// Radix（菜单 / 对话框 / tooltip）在 jsdom 里依赖这几个浏览器 API。
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  window.HTMLElement.prototype.setPointerCapture = vi.fn()
  window.HTMLElement.prototype.releasePointerCapture = vi.fn()
  if (typeof window.matchMedia !== 'function') {
    // next-themes 用它读系统偏好；jsdom 没有实现。
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  window.ResizeObserver =
    window.ResizeObserver ??
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  // 会话是模块级 store：用例之间必须显式复位，否则上一个用例的登录态会串到下一个。
  useSession.setState({ session: null, error: null, pending: false })
  setAuthToken(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
