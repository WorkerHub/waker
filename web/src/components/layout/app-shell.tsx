import {
  CalendarClockIcon,
  FolderKanbanIcon,
  InfoIcon,
  LogOutIcon,
  ScrollTextIcon,
  ServerCogIcon,
  SettingsIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  ZapIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { VersionFooter } from '@/components/version-footer'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useMe } from '@/hooks/use-me'
import { useSession } from '@/stores/session'

/**
 * 应用外壳：品牌 + 导航 + 主题切换 + 退出 + 页脚版本号。
 *
 * 导航顺序即作业流：任务 → 执行记录 → 死信 → 项目。
 * F3 的设置 / 关于 / 系统管理属于低频入口，收在右侧的「系统」菜单里
 * （Radix DropdownMenu = shadcn 原生组件，不另造导航控件），主流程导航不被挤长。
 */
const NAV_ITEMS = [
  { to: '/jobs', label: '任务管理', icon: CalendarClockIcon },
  { to: '/executions', label: '执行记录', icon: ScrollTextIcon },
  { to: '/dead-letters', label: '死信队列', icon: TriangleAlertIcon },
  { to: '/projects', label: '项目管理', icon: FolderKanbanIcon },
] as const

const SYSTEM_ITEMS = [
  { to: '/system', label: '系统管理', icon: ServerCogIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
  { to: '/about', label: '关于', icon: InfoIcon },
] as const

export function AppShell() {
  const logout = useSession((state) => state.logout)
  const user = useSession((state) => state.user)
  // 每次进入管理面都核对一次 `/api/me`：降级 / 禁用 / 改名在下次刷新就生效（权限仍在接口层）。
  useMe()
  const { pathname } = useLocation()
  const inSystemSection = SYSTEM_ITEMS.some((item) => pathname.startsWith(item.to))

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(inSystemSection && 'bg-secondary text-secondary-foreground')}
                >
                  <ServerCogIcon />
                  系统
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {SYSTEM_ITEMS.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    asChild
                    className={cn(pathname === item.to && 'bg-secondary text-secondary-foreground')}
                  >
                    <NavLink to={item.to}>
                      <item.icon className="size-4" />
                      {item.label}
                    </NavLink>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {user !== null && (
              <span className="hidden items-center gap-1.5 pr-1 sm:flex">
                <UserRoundIcon className="size-3.5 text-muted-foreground" />
                <span className="max-w-32 truncate text-xs text-muted-foreground">
                  {user.displayName}
                </span>
                <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                  {user.role === 'admin' ? '管理员' : '只读'}
                </Badge>
              </span>
            )}
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
