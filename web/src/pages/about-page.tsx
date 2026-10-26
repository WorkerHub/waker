import {
  AlarmClockIcon,
  CalendarClockIcon,
  DatabaseIcon,
  LayersIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from 'lucide-react'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  PLATFORM_DOMAIN,
  PLATFORM_NAME,
  PLATFORM_REPO_URL,
  PLATFORM_RUNTIME,
  PLATFORM_SPEC,
  PLATFORM_TAGLINE,
  PLATFORM_VERSION,
} from '@/lib/platform'

/** 内核要点（全部来自 SPEC v1.0，不是运行期数据）。 */
const ARCHITECTURE = [
  {
    icon: CalendarClockIcon,
    title: '两类任务模型',
    body: 'cron 周期任务（表达式 + 时区，部署期声明）与 one-shot 一次性任务（runAt，运行期创建/取消、可自续）。',
  },
  {
    icon: AlarmClockIcon,
    title: 'Durable Object Alarm 内核',
    body: '到点才唤醒：alarm 触发时执行全部 next_run_at ≤ now 的任务，天然回看补发，不丢分钟。',
  },
  {
    icon: LayersIcon,
    title: 'Queue 只做分发缓冲',
    body: 'alarm → 主队列 → consumer → 下游回调；非 2xx 走重试与死信队列，死信转存供页面重放。',
  },
  {
    icon: DatabaseIcon,
    title: '单一真源',
    body: '任务与执行记录只存在 WakerDO 的 SQLite 里：不建 D1、不用 KV、不做双写。',
  },
  {
    icon: AlarmClockIcon,
    title: '唯一 watchdog Cron',
    body: `全仓只有 ${PLATFORM_RUNTIME.cronTriggers} 一个 Cron Trigger，只做一件事：定时 ping DO 校正 alarm，防 alarm 丢失与部署漂移。`,
  },
  {
    icon: ScrollTextIcon,
    title: '回调协议 v2',
    body: '下游以 Hono 路由挂载 /_scheduler，同步 await 到业务完成才回 2xx；每项目独立签名，HMAC-SHA256 + 时间窗防重放。',
  },
] as const

/**
 * 关于页（F3）。
 *
 * 只讲平台是什么、怎么搭的、版本是哪一个 —— 数据全部来自 SPEC v1.0 与构建期常量，
 * 不查任何运行期接口（要运行状态去系统管理页）。
 */
export function AboutPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="关于"
        description={`${PLATFORM_NAME}（${PLATFORM_TAGLINE}）：用 1 个 watchdog Cron + Durable Object Alarm + Queue，取代各项目自有的 Cron Trigger。`}
        actions={<Badge variant="outline" className="font-mono">{PLATFORM_VERSION}</Badge>}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>要解决的问题</CardTitle>
            <CardDescription>从「周期扫表」回到「到期才执行」。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              Cloudflare 免费层的 Cron Triggers 是**账号级**上限（5 个），舰队项目数一多就撞墙。
              更麻烦的是旧做法本身是轮询：每小时全表扫到期提醒、每 5 分钟扫到期信件，精度只有
              小时/分钟级，漏一分钟就丢一分钟。
            </p>
            <p>
              平台把调度收敛成一处：下游只注册任务，平台用 Durable Object Alarm 精确到点唤醒，
              经 Queue 分发并带签名回调下游；下游同步 await 到业务完成再回 2xx，成败对平台可见
              （旧的 `waitUntil` + 立即 OK 语义已废弃）。
            </p>
            <p>
              下游默认走官方 cron；waker 是**可选**部署模式，接入后可不再申请 Cron Trigger。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>版本与环境</CardTitle>
            <CardDescription>构建期事实与部署约定。</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSection title="版本">
              <DetailRow label="版本" value={PLATFORM_VERSION} mono />
              <DetailRow label="域名" value={PLATFORM_DOMAIN} mono />
              <DetailRow label="规格" value={PLATFORM_SPEC} />
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
            </DetailSection>
            <DetailSection title="运行形态" description="单人自托管，不做多租户">
              <DetailRow label="Cron" value={PLATFORM_RUNTIME.cronTriggers} />
              <DetailRow label="DO 实例" value={PLATFORM_RUNTIME.doInstance} mono />
              <DetailRow label="主队列" value={PLATFORM_RUNTIME.mainQueue} mono />
              <DetailRow label="死信队列" value={PLATFORM_RUNTIME.deadLetterQueue} mono />
            </DetailSection>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ARCHITECTURE.map((item) => (
          <Card key={item.title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <item.icon className="size-4 text-muted-foreground" />
                {item.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs leading-relaxed text-muted-foreground">
              {item.body}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="size-4" />
            明确的边界
          </CardTitle>
          <CardDescription>规格里写死「不做」的部分，避免预期错位。</CardDescription>
        </CardHeader>
        <CardContent>
          <DetailSection title="不承诺">
            <DetailRow label="精度" value="分钟级，不承诺秒级；alarm 不是硬实时，可能有秒~分钟级延迟" />
            <DetailRow label="编排" value="不做任务间依赖、不做可视化编排、不做亚分钟调度" />
            <DetailRow label="多租户" value="本版单人自托管，单一 WakerDO 实例，不分片" />
            <DetailRow label="凭据" value="signing key 明文只在发放/轮换时出现一次；页面只展示指纹与状态位" />
          </DetailSection>
        </CardContent>
      </Card>
    </div>
  )
}
