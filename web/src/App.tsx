import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from '@/components/layout/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DeadLettersPage } from '@/pages/dead-letters-page'
import { ExecutionsPage } from '@/pages/executions-page'
import { JobsPage } from '@/pages/jobs-page'
import { LoginPage } from '@/pages/login-page'
import { ProjectsPage } from '@/pages/projects-page'
import { AboutPage } from '@/pages/about-page'
import { SettingsPage } from '@/pages/settings-page'
import { SystemPage } from '@/pages/system-page'
import { useSession } from '@/stores/session'

/**
 * 路由表。
 *
 * F1：任务管理（`/jobs`）、项目管理（`/projects`）。
 * F2：执行记录（`/executions`）、死信队列（`/dead-letters`）。
 * F3：设置（`/settings`）、关于（`/about`）、系统管理（`/system`）。
 */

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
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
