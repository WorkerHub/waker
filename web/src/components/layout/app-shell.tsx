import {
  CalendarClockIcon,
  FolderKanbanIcon,
  LogOutIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  ZapIcon,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import { ThemeToggle } from '@/components/theme-toggle'
import { VersionFooter } from '@/components/version-footer'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'

/**
 * 应用外壳：品牌 + 导航 + 主题切换 + 退出 + 页脚版本号。
 *
 * 导航顺序即作业流：任务 → 执行记录 → 死信 → 项目。
 * F3（设置 / 系统管理）后续子单追加到同一份 `NAV_ITEMS`，不需要改外壳结构。
 */
const NAV_ITEMS = [
  { to: '/jobs', label: '任务管理', icon: CalendarClockIcon },
  { to: '/executions', label: '执行记录', icon: ScrollTextIcon },
  { to: '/dead-letters', label: '死信队列', icon: TriangleAlertIcon },
  { to: '/projects', label: '项目管理', icon: FolderKanbanIcon },
] as const

export function AppShell() {
  const logout = useSession((state) => state.logout)

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-6">
          <NavLink to="/jobs" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ZapIcon className="size-4" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">waker</span>
              <span className="text-[11px] text-muted-foreground">统一调度平台</span>
            </span>
          </NavLink>

          <nav className="flex items-center gap-1" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOutIcon />
              退出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <Outlet />
      </main>

      <VersionFooter />
    </div>
  )
}
