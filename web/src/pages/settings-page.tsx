import { LogOutIcon, MonitorIcon, PaletteIcon, SlidersHorizontalIcon, UserRoundIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Link } from 'react-router-dom'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { PageHeader } from '@/components/page-header'
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
  PLATFORM_DOMAIN,
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
 * 设置页（F3）。
 *
 * 数据面只有两处、都是**已有真源**：
 *   - 平台信息：构建期事实（`lib/platform.ts`，与页脚同一个版本号来源）；
 *   - 会话：`stores/session.ts` 里本地保存的 12 小时 JWT 有效期。
 *
 * 这里**没有**可写的「基础设置项」：SPEC §6 里归设置/系统管理的告警渠道配置、数据导出
 * 都还没有 B2/B4 冻结契约（已在 ONE-381 评论里提出等后端），所以本页只做展示与主题切换，
 * 不自己发明设置键、不伪造保存行为。
 */
export function SettingsPage() {
  const session = useSession((state) => state.session)
  const logout = useSession((state) => state.logout)
  const { theme } = useTheme()

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="设置"
        description="平台标识、外观与当前会话。平台没有需要业务填写的配置项，可写设置等待冻结契约。"
      />

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
              <DetailRow label="域名" value={PLATFORM_DOMAIN} mono />
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
                    <span className="text-xs text-muted-foreground">
                      点右上角图标切换主题
                    </span>
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
            <CardDescription>
              单人所有者模型：不开放注册，`SETUP_SECRET` 换 12 小时会话令牌。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="当前登录">
              <DetailRow
                label="状态"
                value={<Badge variant={session === null ? 'secondary' : 'default'}>
                  {session === null ? '未登录' : '已登录'}
                </Badge>}
              />
              <DetailRow label="过期时间" value={formatDateTime(session?.expiresAt ?? null)} />
              <DetailRow
                label="剩余"
                value={session === null ? null : formatRelative(session.expiresAt)}
              />
              <DetailRow
                label="存储位置"
                value="本浏览器 localStorage，仅保存会话令牌；项目令牌与 signing key 明文一律不落任何存储"
              />
            </DetailSection>
          </CardContent>
          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground">
              退出只清本地会话，不影响平台任务
            </span>
            <Button variant="outline" size="sm" onClick={logout} disabled={session === null}>
              <LogOutIcon />
              退出登录
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontalIcon className="size-4" />
              基础设置项
            </CardTitle>
            <CardDescription>尚未提供接口的配置项在此列出，不做可保存的假开关。</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="状态">
              <DetailRow label="可写配置" value="平台当前没有可写设置项" />
              <DetailRow
                label="等待契约"
                value="告警渠道配置、数据导出（SPEC §6）尚无 B2/B4 冻结接口，已提交后端，接入后在此开放"
              />
            </DetailSection>
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground">
            需要平台运行状态请看 <Link className="underline underline-offset-4" to="/system">系统管理</Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
