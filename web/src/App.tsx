import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from '@/components/layout/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getSetupState } from '@/lib/auth-api'
import { DeadLettersPage } from '@/pages/dead-letters-page'
import { ExecutionsPage } from '@/pages/executions-page'
import { JobsPage } from '@/pages/jobs-page'
import { LoginPage } from '@/pages/login-page'
import { ProjectsPage } from '@/pages/projects-page'
import { RegisterPage } from '@/pages/register-page'
import { SetupPage } from '@/pages/setup-page'
import { AboutPage } from '@/pages/about-page'
import { SettingsPage } from '@/pages/settings-page'
import { SystemPage } from '@/pages/system-page'
import { useSession } from '@/stores/session'

/**
 * 路由表。
 *
 * 未登录面：`/setup` 初始化、`/login` 登录（含两步登录第二步）、`/register` 注册。
 * 登录面：F1 任务 / F2 执行记录与死信 / F3 设置、关于、系统管理。
 */

/**
 * 未初始化闸门（SPEC §3.1）：库里一个用户都没有时，打开任意页面都引导去 `/setup`。
 *
 * 判据是公开的 `GET /api/setup/state`，不是本地状态 —— 换个浏览器打开也知道该初始化。
 * 探测失败（离线等）时不拦，让各页面按自己的错误提示处理，避免整站白屏。
 */
function SetupGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const setupStateQuery = useQuery({
    queryKey: ['setup-state'],
    queryFn: getSetupState,
    retry: false,
    staleTime: 30_000,
  })

  if (setupStateQuery.data !== undefined && !setupStateQuery.data.initialized) {
    if (pathname !== '/setup') return <Navigate to="/setup" replace />
  }
  return <>{children}</>
}

/** 未持有会话时一律回登录页；会话过期由 client 的 401 处理清掉。 */
function RequireSession() {
  const session = useSession((state) => state.session)
  if (session === null) return <Navigate to="/login" replace />
  return <AppShell />
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 契约错误（404/409/401）重试没有意义；网络抖动由用户点刷新处理。
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
    },
  })
}

export function App() {
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SetupGate>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<RequireSession />}>
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/dead-letters" element={<DeadLettersPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/system" element={<SystemPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/about" element={<AboutPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/jobs" replace />} />
          </Routes>
        </SetupGate>
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
