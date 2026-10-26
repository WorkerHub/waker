import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClockIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  KeyRoundIcon,
  LayersIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, getSystemStatus, isNotImplementedError, type SystemStatus } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

/**
 * 系统管理页（F3）。
 *
 * 数据面只有一个接口，且全是 B4 冻结契约里已有的字段：
 *
 *   GET /api/system/status → { status: SystemStatusView + secrets + queue }
 *     - watchdog 状态：`watchdogLastRunAt` / `watchdogLastDueJobs` / `nextWakeAt`；
 *     - WakerDO / SQLite：`schemaVersion` + `counts`（含 `pendingDispatches` 投递落后信号）；
 *     - 密钥状态位：`secrets.setupSecretConfigured` / `secrets.jwtSecretConfigured`（只有布尔）；
 *     - 队列摘要：`queue.main` / `queue.deadLetter` + `counts.deadLetters`。
 *
 * 页面**只读**：没有任何写操作，也没有任何凭据值与掩码 —— 契约里连掩码都不给，
 * 这里也不会去请求、存储或渲染 SETUP_SECRET / JWT_SECRET / signing key / 项目令牌。
 */
export function SystemPage() {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({ queryKey: ['system-status'], queryFn: getSystemStatus })
  const status = statusQuery.data

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="系统管理"
        description="平台运行状态快照：watchdog 校正、WakerDO 存储、密钥配置状态位与队列摘要。只读页面。"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={statusQuery.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['system-status'] })}
          >
            <RefreshCwIcon className={statusQuery.isFetching ? 'animate-spin' : undefined} />
            刷新
          </Button>
        }
      />

      {statusQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>系统状态加载失败</AlertTitle>
          <AlertDescription>{describeStatusError(statusQuery.error)}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
              重试
            </Button>
          </AlertAction>
        </Alert>
      )}

      {statusQuery.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      ) : status === undefined ? null : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>采集于 {formatDateTime(status.now)}</span>
            <span aria-hidden>·</span>
            <span>{formatRelative(status.now)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">SQLite schema v{status.schemaVersion}</span>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <WatchdogCard status={status} />
            <StorageCard status={status} />
            <QueueCard status={status} />
            <SecretsCard status={status} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlertIcon className="size-4" />
                尚未接入（等待冻结契约）
              </CardTitle>
              <CardDescription>
                规格 §6 把数据导出与告警渠道配置放在系统管理，但 B2/B4 冻结契约里没有对应接口。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DetailSection title="状态">
                <DetailRow label="数据导出" value="无接口：已在 ONE-381 提出，等后端冻结后接" />
                <DetailRow label="告警渠道" value="无接口：同上，未接入前不提供假开关" />
              </DetailSection>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function WatchdogCard({ status }: { status: SystemStatus }) {
  const neverRan = status.watchdogLastRunAt === null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlarmClockIcon className="size-4" />
          watchdog（全仓唯一 Cron）
          <Badge variant={neverRan ? 'outline' : 'default'}>
            {neverRan ? '尚未运行' : '已运行'}
          </Badge>
        </CardTitle>
        <CardDescription>每小时 ping WakerDO 校正 alarm，防 alarm 丢失与部署漂移。</CardDescription>
      </CardHeader>
      <CardContent>
        <DetailSection title="校正账本">
          <DetailRow
            label="上次运行"
            value={
              neverRan
                ? '从未记录'
                : `${formatDateTime(status.watchdogLastRunAt)}（${formatRelative(status.watchdogLastRunAt)}）`
            }
          />
          <DetailRow
            label="上次到期任务"
            value={
              status.watchdogLastDueJobs === null
                ? '—'
                : `${formatCount(status.watchdogLastDueJobs)} 个（watchdog 幂等，只补漏）`
            }
          />
          <DetailRow
            label="下次唤醒"
            value={
              status.nextWakeAt === null
                ? '无 alarm（当前没有待跑任务）'
                : `${formatDateTime(status.nextWakeAt)}（${formatRelative(status.nextWakeAt)}）`
            }
          />
        </DetailSection>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        alarm 为 at-least-once；重复唤醒只会补漏，不会重复执行已完成任务。
      </CardFooter>
    </Card>
  )
}

function StorageCard({ status }: { status: SystemStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseIcon className="size-4" />
          WakerDO 存储（SQLite）
          <Badge variant="outline" className="font-mono">
            schema v{status.schemaVersion}
          </Badge>
        </CardTitle>
        <CardDescription>
          单一真源：单实例 WakerDO，不建 D1、不用 KV、不双写。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DetailSection title="库内计数">
          <DetailRow label="项目" value={formatCount(status.counts.projects)} />
          <DetailRow
            label="任务"
            value={`${formatCount(status.counts.jobs)} 个（active ${formatCount(status.counts.activeJobs)}）`}
          />
          <DetailRow label="执行记录" value={formatCount(status.counts.executions)} />
          <DetailRow
            label="待投递"
            value={
              status.counts.pendingDispatches > 0
                ? `${formatCount(status.counts.pendingDispatches)} 条（Queue 投递落后）`
                : '0 条'
            }
          />
        </DetailSection>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        真源在 DO SQLite，管理面经 RPC 读取，不轮询共享 D1。
      </CardFooter>
    </Card>
  )
}

function QueueCard({ status }: { status: SystemStatus }) {
  const backlog = status.counts.pendingDispatches

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayersIcon className="size-4" />
          Queue 摘要
          <Badge variant={backlog > 0 ? 'destructive' : 'default'}>
            {backlog > 0 ? '有积压' : '正常'}
          </Badge>
        </CardTitle>
        <CardDescription>主队列做分发缓冲，死信转存 DO 后可在页面重放。</CardDescription>
      </CardHeader>
      <CardContent>
        <DetailSection title="队列">
          <DetailRow label="主队列" value={status.queue.main} mono />
          <DetailRow
            label="待投递"
            value={`${formatCount(backlog)} 条（= 状态 pending 的执行）`}
          />
          <DetailRow label="死信队列" value={status.queue.deadLetter} mono />
          <DetailRow
            label="死信条数"
            value={
              <span className="inline-flex flex-wrap items-center gap-2">
                {formatCount(status.counts.deadLetters)} 条
                <Link className="underline underline-offset-4" to="/dead-letters">
                  去死信队列
                </Link>
              </span>
            }
          />
        </DetailSection>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        队列深度不是平台可读项：这里用「待投递 / 死信」计数作为积压信号。
      </CardFooter>
    </Card>
  )
}

function SecretsCard({ status }: { status: SystemStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          密钥配置状态
          <Badge variant="outline">只读状态位</Badge>
        </CardTitle>
        <CardDescription>
          只报「是否已配置」，平台绝不回显任何密钥值（连掩码都没有）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DetailSection title="环境密钥" description="值由 GitHub Secrets → secrets.json → wrangler 持有，页面永不接触">
          <SecretStateRow label="SETUP_SECRET" configured={status.secrets.setupSecretConfigured} />
          <SecretStateRow label="JWT_SECRET" configured={status.secrets.jwtSecretConfigured} />
        </DetailSection>
        <DetailSection title="项目凭据" description="明文只在发放/轮换时出现一次，事后仅存指纹">
          <DetailRow label="项目令牌" value="见项目管理页（只展示指纹，不展示值）" />
          <DetailRow label="signing key" value="见项目管理页（只展示指纹与算法）" />
        </DetailSection>
      </CardContent>
      <CardFooter className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2Icon className="size-3" />
        页面、接口与日志都不含密钥明文
      </CardFooter>
    </Card>
  )
}

function SecretStateRow({ label, configured }: { label: string; configured: boolean }) {
  return (
    <DetailRow
      label={label}
      value={
        <span className="inline-flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'destructive'}>
            {configured ? '已配置' : '未配置'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {configured ? '缺失将导致部署/登录失败' : '部署前须在 GitHub Secrets 配置'}
          </span>
        </span>
      }
    />
  )
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function describeStatusError(error: unknown): string {
  if (isNotImplementedError(error)) {
    return '后端还没挂载 /api/system/status（HTTP 501）：等后端接入后再回来刷新。'
  }
  if (error instanceof ApiError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return '请稍后重试'
}
