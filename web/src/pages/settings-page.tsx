import { LogOutIcon, MonitorIcon, PaletteIcon, UserRoundIcon } from 'lucide-react'
import { useTheme } from 'next-themes'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { PageHeader } from '@/components/page-header'
import { ProfileSection } from '@/components/settings/profile-section'
import { SecuritySection } from '@/components/settings/security-section'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  getPlatformDomain,
  PLATFORM_NAME,
  PLATFORM_REPO_URL,
  PLATFORM_SPEC,
  PLATFORM_TAGLINE,
  PLATFORM_VERSION,
} from '@/lib/platform'
import { useSession } from '@/stores/session'

const THEME_LABEL: Record<string, string> = {
  light: '亮色',
  dark: '暗色',
  system: '跟随系统',
}

/**
 * 设置页（F3 + SPEC §5.3）。
 *
 * 分区（照《通用技术方案》§5A.3，不把个人安全设置塞进系统管理）：
 *   - 个人资料：昵称、改密码（viewer 也能用）；
 *   - 安全：TOTP / 邮件验证码 / Passkey / 首选方法（viewer 也能用，属于本人的东西）；
 *   - 外观与会话：纯展示 + 主题切换 + 退出。
 *
 * 系统管理（用户管理 / 注册开关 / 邮件服务）在 `/system`，仅 admin。
 */
export function SettingsPage() {
  const session = useSession((state) => state.session)
  const logout = useSession((state) => state.logout)
  const { theme } = useTheme()

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="设置"
        description="个人资料、第二因素（TOTP / 邮件验证码 / Passkey）、外观与当前会话。"
      />

      <ProfileSection />

      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold tracking-tight">安全</h2>
          <p className="text-xs text-muted-foreground">
            第二因素是自愿开启的：启用了哪几种，登录第二步就能选哪几种；解绑与关停需要复验密码。
          </p>
        </div>
        <SecuritySection />
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorIcon className="size-4" />
              平台信息
              <Badge variant="outline" className="font-mono">
                {PLATFORM_VERSION}
              </Badge>
            </CardTitle>
            <CardDescription>构建期事实，运行期不读 git、不发额外请求。</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="标识">
              <DetailRow label="名称" value={`${PLATFORM_NAME} · ${PLATFORM_TAGLINE}`} />
              <DetailRow label="版本" value={PLATFORM_VERSION} mono />
              <DetailRow label="域名" value={getPlatformDomain()} mono />
              <DetailRow
                label="仓库"
                value={
                  <a
                    className="underline underline-offset-4"
                    href={PLATFORM_REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {PLATFORM_REPO_URL}
                  </a>
                }
              />
              <DetailRow label="规格来源" value={PLATFORM_SPEC} />
            </DetailSection>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PaletteIcon className="size-4" />
              外观
            </CardTitle>
            <CardDescription>
              亮色 / 暗色 / 跟随系统三档，选择保存在本浏览器（`waker.theme`）。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="主题">
              <DetailRow label="当前" value={THEME_LABEL[theme ?? 'system'] ?? '跟随系统'} />
              <DetailRow
                label="切换"
                value={
                  <span className="inline-flex items-center gap-2">
                    <ThemeToggle />
                    <span className="text-xs text-muted-foreground">点右上角图标切换主题</span>
                  </span>
                }
              />
            </DetailSection>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRoundIcon className="size-4" />
              会话
            </CardTitle>
            <CardDescription>会话 12 小时有效，过期后回登录页重新登录。</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="当前登录">
              <DetailRow
                label="状态"
                value={
                  <Badge variant={session === null ? 'secondary' : 'default'}>
                    {session === null ? '未登录' : '已登录'}
                  </Badge>
                }
              />
              <DetailRow label="过期时间" value={formatDateTime(session?.expiresAt ?? null)} />
              <DetailRow
                label="剩余"
                value={session === null ? null : formatRelative(session.expiresAt)}
              />
              <DetailRow
                label="存储位置"
                value="本浏览器 localStorage，仅保存会话令牌与用户视图；项目令牌与 signing key 明文一律不落任何存储"
              />
            </DetailSection>
          </CardContent>
          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground">退出只清本地会话，不影响平台任务</span>
            <Button variant="outline" size="sm" onClick={logout} disabled={session === null}>
              <LogOutIcon />
              退出登录
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
