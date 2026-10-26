import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircleIcon, CheckCircle2Icon, RefreshCwIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { CursorPager } from '@/components/cursor-pager'
import { DeadLetterDetailDialog } from '@/components/dead-letters/dead-letter-detail-dialog'
import {
  DeadLetterFilters,
  EMPTY_DEAD_LETTER_FILTERS,
  type DeadLetterFiltersValue,
} from '@/components/dead-letters/dead-letter-filters'
import { DeadLettersTable } from '@/components/dead-letters/dead-letters-table'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiError,
  isNotImplementedError,
  listDeadLetters,
  listJobs,
  listProjects,
  PAGE_LIMIT_MAX,
  replayDeadLetter,
  type DeadLetterView,
  type ReplayDeadLetterResult,
} from '@/lib/api'
import { deadLetterJobLabel, timeRangeError, timeRangeToEpoch } from '@/lib/executions'
import { formatDateTime } from '@/lib/format'

const PAGE_SIZE = 25

/**
 * 死信队列页（F2）。
 *
 * 数据面：B6 冻结的 `listDeadLetters`（HTTP `GET /api/dead-letters`）+ B3 冻结的
 * `replayDeadLetter`（HTTP `POST /api/dead-letters/{id}/replay`）。
 * 「能不能重放」由后端判定（`replayed_at` 已写入 = 已重放；任务已取消时后端回
 * `job_cancelled`），前端只按契约字段收敛入口，不自己推断业务状态。
 */
export function DeadLettersPage() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<DeadLetterFiltersValue>(EMPTY_DEAD_LETTER_FILTERS)
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])
  const [detail, setDetail] = useState<DeadLetterView | null>(null)
  const [replayTarget, setReplayTarget] = useState<DeadLetterView | null>(null)
  const [lastReplay, setLastReplay] = useState<ReplayDeadLetterResult | null>(null)

  const cursor = cursorStack.at(-1) ?? null
  const page = cursorStack.length
  const rangeError = timeRangeError(filters.range)
  const { from, to } = timeRangeToEpoch(filters.range)

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  const jobsQuery = useQuery({
    queryKey: ['jobs', 'dead-letter-filter', filters.projectId],
    queryFn: () =>
      listJobs({
        projectId: filters.projectId === '' ? undefined : filters.projectId,
        limit: PAGE_LIMIT_MAX,
      }),
  })

  const deadLettersQuery = useQuery({
    queryKey: [
      'dead-letters',
      filters.projectId,
      filters.jobId,
      filters.replayState,
      from,
      to,
      cursor,
    ],
    queryFn: () =>
      listDeadLetters({
        projectId: filters.projectId === '' ? undefined : filters.projectId,
        jobId: filters.jobId === '' ? undefined : filters.jobId,
        replayState: filters.replayState === '' ? undefined : filters.replayState,
        // 半开区间 [from, to)，字段名按本接口契约（createdFrom / createdTo）。
        createdFrom: from ?? undefined,
        createdTo: to ?? undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
    enabled: rangeError === null,
  })

  const projects = projectsQuery.data ?? []
  const jobs = jobsQuery.data?.jobs ?? []
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const jobNames = new Map(jobs.map((job) => [job.id, job.name]))
  const deadLetters = deadLettersQuery.data?.deadLetters ?? []
  const dirty = hasFilters(filters)

  const replayMutation = useMutation({
    mutationFn: (deadLetter: DeadLetterView) => replayDeadLetter(deadLetter.id),
    onSuccess: async (result) => {
      setLastReplay(result)
      toast.success('已重放，平台新建了一条手动执行', {
        description: `executionId ${result.executionId} · 计划 ${formatDateTime(result.scheduledFor)}`,
      })
      await queryClient.invalidateQueries({ queryKey: ['dead-letters'] })
    },
    onError: (error, deadLetter) => {
      setLastReplay(null)
      toast.error(describeError(error, `重放 ${deadLetterJobLabel(deadLetter, jobNames)} 失败`))
    },
  })

  function applyFilters(next: DeadLetterFiltersValue) {
    setFilters(next)
    setCursorStack([null])
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['dead-letters'] })
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
    void queryClient.invalidateQueries({ queryKey: ['jobs'] })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="死信队列"
        description="超过重试上限或遇到配置类错误的任务会落到这里；重放会用同一任务、同一载荷新建一条手动执行。"
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCwIcon />
            刷新
          </Button>
        }
      />

      <DeadLetterFilters
        value={filters}
        projects={projects}
        jobs={jobs}
        rangeError={rangeError}
        onChange={applyFilters}
      />

      {lastReplay !== null && (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>重放已排入</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs break-all">executionId {lastReplay.executionId}</span>
            <span className="block text-xs text-muted-foreground">
              计划执行 {formatDateTime(lastReplay.scheduledFor)} ·{' '}
              <Link className="underline underline-offset-2" to="/executions">
                去执行记录查看
              </Link>
            </span>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭重放结果"
              onClick={() => setLastReplay(null)}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      )}

      {deadLettersQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>死信列表加载失败</AlertTitle>
          <AlertDescription>
            {describeError(deadLettersQuery.error, '请稍后重试')}
            {isNotImplementedError(deadLettersQuery.error) && (
              <span className="mt-1 block text-xs">
                管理面还没有挂载死信查询与重放路由（`GET /api/dead-letters`、
                `POST /api/dead-letters/{'{id}'}/replay`，B6/B3 的 RPC 已就位）。挂上之后本页无需改动即可使用。
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void deadLettersQuery.refetch()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {deadLettersQuery.isPending && rangeError === null ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : deadLettersQuery.isError && deadLetters.length === 0 ? null : deadLetters.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>{dirty ? '没有符合条件的死信' : '死信队列是空的'}</EmptyTitle>
            <EmptyDescription>
              {dirty
                ? '换个任务、重放状态或时间区间再试；筛选条件会原样下推给平台查询。'
                : '下游连续失败超过重试上限、或缺少 signing key 这类配置错误，才会落到死信队列。'}
            </EmptyDescription>
          </EmptyHeader>
          {dirty && (
            <EmptyContent>
              <Button size="sm" onClick={() => applyFilters(EMPTY_DEAD_LETTER_FILTERS)}>
                重置筛选
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <DeadLettersTable
          deadLetters={deadLetters}
          jobNames={jobNames}
          busyDeadLetterId={replayMutation.isPending ? (replayMutation.variables?.id ?? null) : null}
          onReplay={setReplayTarget}
          onOpenDetail={setDetail}
        />
      )}

      <CursorPager
        pageSize={PAGE_SIZE}
        currentPage={page}
        canPrev={cursorStack.length > 1}
        nextCursor={deadLettersQuery.data?.nextCursor}
        isFetching={deadLettersQuery.isFetching}
        onPrev={() => setCursorStack((stack) => stack.slice(0, -1))}
        onNext={(next) => setCursorStack((stack) => [...stack, next])}
      />

      <DeadLetterDetailDialog
        deadLetter={detail}
        jobNames={jobNames}
        projectNames={projectNames}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      />

      <AlertDialog
        open={replayTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReplayTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              重放死信「{replayTarget === null ? '' : deadLetterJobLabel(replayTarget, jobNames)}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              平台会以同一任务、同一载荷新建一条手动执行并立即投递；原死信只会被标记为已重放，
              不会删除，也不会自动再次重试。任务已取消时重放会被后端拒绝。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (replayTarget !== null) replayMutation.mutate(replayTarget)
                setReplayTarget(null)
              }}
            >
              确认重放
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function hasFilters(value: DeadLetterFiltersValue): boolean {
  return (
    value.projectId !== '' ||
    value.jobId !== '' ||
    value.replayState !== '' ||
    value.range.from !== '' ||
    value.range.to !== ''
  )
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return fallback
}
