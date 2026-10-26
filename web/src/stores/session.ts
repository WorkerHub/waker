import { create } from 'zustand'

import {
  describeAuthError,
  loginWithPassword,
  type UserView,
  type SessionInfo,
  type TwoFactorMethod,
} from '@/lib/auth-api'
import { setAuthToken, setUnauthorizedHandler } from '@/lib/api'

/**
 * 会话 store（SPEC §5.2）：管理面 JWT 只存在浏览器 localStorage（12 小时有效，后端签发）。
 *
 * 保存三样东西，边界各不相同：
 *   - `session`：正式会话 `{ token, expiresAt }`，刷新页面不该要求重新登录，因此落 localStorage；
 *   - `user`：当前用户视图（角色 / 显示名 / 邮箱），落 localStorage 只为首屏就能按角色裁剪入口 ——
 *     **权限判定永远在后端**（viewer 的写请求照样 403），这里只是不给无权限的按钮；
 *   - `challenge`：两步登录的临时令牌（≤5 分钟、仅限 2FA 步）**只在内存**，
 *     一旦离开 2FA 页 / 刷新就重新走密码步 —— 临时令牌不落任何存储。
 *
 * bootstrap 令牌同理不落存储：它只活在 `/setup` 页面的组件状态里。
 */
const STORAGE_KEY = 'waker.session.v2'

/** 两步登录待办（密码步已通过、还差第二因素）。 */
export interface LoginChallenge {
  tempToken: string
  /** 临时令牌过期时刻（epoch ms）。 */
  expiresAt: number
  /** 可用方法，后端已按 preferred 优先排序，前端不重排。 */
  methods: TwoFactorMethod[]
  user: UserView
}

/** 密码步结果：直接登录 / 需要第二步 / 失败（错误已在 `error` 里）。 */
export type LoginStep = 'session' | 'two_factor' | 'failed'

interface Persisted {
  session: SessionInfo
  user: UserView | null
}

interface SessionState {
  session: SessionInfo | null
  user: UserView | null
  challenge: LoginChallenge | null
  /** 面向用户的错误提示（登录 / 2FA 页展示），null = 无错误。 */
  error: string | null
  pending: boolean

  login: (email: string, password: string) => Promise<LoginStep>
  /** 注册 / 建首管 / 2FA 通过后统一收口：写令牌 + 用户，落存储。 */
  adopt: (result: { user: UserView; session: SessionInfo }) => void
  setUser: (user: UserView) => void
  setChallenge: (challenge: LoginChallenge) => void
  clearChallenge: () => void
  setPending: (pending: boolean) => void
  setError: (message: string | null) => void
  clearError: () => void
  logout: () => void
}

function readPersisted(): Persisted | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Persisted>
    const session = parsed.session
    if (
      session === undefined ||
      typeof session.token !== 'string' ||
      typeof session.expiresAt !== 'number'
    ) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return { session, user: parsed.user ?? null }
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

function writePersisted(value: Persisted | null): void {
  if (typeof localStorage === 'undefined') return
  if (value === null) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

const initial = readPersisted()
// 首个请求之前就把令牌挂到 client 上（避免首屏查询漏带 Authorization）。
setAuthToken(initial?.session.token ?? null)

export const useSession = create<SessionState>((set, get) => ({
  session: initial?.session ?? null,
  user: initial?.user ?? null,
  challenge: null,
  error: null,
  pending: false,

  async login(email, password) {
    set({ pending: true, error: null })
    try {
      const result = await loginWithPassword(email, password)
      if (result.requiresTwoFactor) {
        // 临时令牌只在内存：它就是「第二因素待办」的唯一凭据。
        set({
          pending: false,
          error: null,
          challenge: {
            tempToken: result.tempToken,
            expiresAt: result.expiresAt,
            methods: result.methods,
            user: result.user,
          },
        })
        return 'two_factor'
      }

      setAuthToken(result.session.token)
      writePersisted({ session: result.session, user: result.user })
      set({ session: result.session, user: result.user, challenge: null, pending: false, error: null })
      return 'session'
    } catch (error) {
      set({ pending: false, error: describeAuthError(error) })
      return 'failed'
    }
  },

  adopt(result) {
    setAuthToken(result.session.token)
    writePersisted({ session: result.session, user: result.user })
    set({
      session: result.session,
      user: result.user,
      challenge: null,
      pending: false,
      error: null,
    })
  },

  setUser(user) {
    const session = get().session
    if (session !== null) writePersisted({ session, user })
    set({ user })
  },

  setChallenge(challenge) {
    set({ challenge, error: null })
  },

  clearChallenge() {
    set({ challenge: null })
  },

  setPending(pending) {
    set({ pending })
  },

  setError(message) {
    set({ error: message })
  },

  clearError() {
    set({ error: null })
  },

  logout() {
    setAuthToken(null)
    writePersisted(null)
    set({ session: null, user: null, challenge: null, error: null })
  },
}))

// 任何带令牌的请求收到 401（会话过期 / 被换掉 / 账号被禁用）→ 清会话回登录页。
// 公开鉴权路径（登录、2FA、初始化）的 401 由 `lib/api.ts` 排除，不会走到这里。
setUnauthorizedHandler(() => {
  writePersisted(null)
  useSession.setState({ session: null, user: null })
})
