import { ZapIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { VersionFooter } from '@/components/version-footer'

/**
 * 未登录页面（初始化 / 登录 / 两步登录 / 注册）的公共外壳。
 *
 * 只做排版：品牌 + 居中卡片 + 页脚版本号。表单、信号、业务流程都在各自页面里，
 * 外壳不掺任何会话逻辑（避免「外观组件顺手改状态」）。
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <Link to="/login" className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ZapIcon className="size-4.5" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight">waker</span>
              <span className="text-xs text-muted-foreground">统一调度平台 · 管理面</span>
            </span>
          </Link>

          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle !== undefined && (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>

          {children}

          {footer !== undefined && (
            <div className="text-sm text-muted-foreground">{footer}</div>
          )}
        </div>
      </main>
      <VersionFooter />
    </div>
  )
}
