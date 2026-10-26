import { create } from 'zustand'

import {
  ApiError,
  createSession,
  setAuthToken,
  setUnauthorizedHandler,
  type SessionInfo,
} from '@/lib/api'

/**
 * 会话 store：管理面 JWT 只存在浏览器 localStorage（12 小时有效，后端签发）。
 *
 * 为什么是 localStorage 而不是内存：刷新页面不该要求重新输入 SETUP_SECRET；
 * 令牌本身是短期 JWT，且后端不提供 refresh —— 过期即回登录页，语义简单可预期。
 * 注意：这里**只**保存会话令牌，signing key / 项目令牌明文一律不落任何存储。
 */
const STORAGE_KEY = 'waker.session.v1'

interface SessionState {
  session: SessionInfo | null
  /** 换会话失败时的错误（登录页展示），null = 无错误。 */
  error: string | null
  pending: boolean
  login: (setupSecret: string) => Promise<boolean>
  logout: () => void
  clearError: () => void
}

function readStoredSession(): SessionInfo | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SessionInfo>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt }
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

function writeStoredSession(session: SessionInfo | null): void {
  if (typeof localStorage === 'undefined') return
  if (session === null) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

const initialSession = readStoredSession()
// 首个请求之前就把令牌挂到 client 上（避免首屏查询漏带 Authorization）。
setAuthToken(initialSession?.token ?? null)

export const useSession = create<SessionState>((set) => ({
  session: initialSession,
  error: null,
  pending: false,

  async login(setupSecret: string) {
    set({ pending: true, error: null })
    try {
      const session = await createSession(setupSecret)
      setAuthToken(session.token)
      writeStoredSession(session)
      set({ session, pending: false })
      return true
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.code === 'unauthorized'
            ? 'SETUP_SECRET 不正确'
            : error.message
          : error instanceof Error
            ? error.message
            : '登录失败'
      set({ pending: false, error: message })
      return false
    }
  },

  logout() {
    setAuthToken(null)
    writeStoredSession(null)
    set({ session: null, error: null })
  },

  clearError() {
    set({ error: null })
  },
}))

// 任何带令牌的请求收到 401（会话过期 / 被换掉）→ 清会话回登录页。
setUnauthorizedHandler(() => {
  writeStoredSession(null)
  useSession.setState({ session: null })
})
