import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { getMe } from '@/lib/auth-api'
import { useSession } from '@/stores/session'

/**
 * 当前用户资料 + 2FA 状态（`GET /api/me`），并同步进会话 store。
 *
 * 为什么单独一个 hook：角色（admin / viewer）决定页面显示哪些管理入口，
 * 而角色由后端在每次请求时读库判定 —— 前端只在拿到 `/api/me` 后同步一份，
 * 用于**裁剪入口**，绝不用它替代接口层的 403。
 */
export function useMe() {
  const session = useSession((state) => state.session)
  const setUser = useSession((state) => state.setUser)

  const query = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: session !== null,
    retry: false,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.data !== undefined) setUser(query.data.user)
  }, [query.data, setUser])

  return query
}
