import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircleIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { EMPTY_FILTERS, JobFilters, type JobFiltersValue } from '@/components/jobs/job-filters'
import { JobFormDialog } from '@/components/jobs/job-form-dialog'
import { JobsTable, type JobRowAction } from '@/components/jobs/jobs-table'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  listJobs,
  listProjects,
  runJobAction,
  triggerJob,
  type JobView,
} from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { canPause, canResume } from '@/lib/jobs'

const PAGE_SIZE = 25

/**
 * 任务管理页（F1）。
 *
 * 数据面只走 B4 冻结的管理面 API：`GET /api/jobs`（分页 + 筛选）、`POST /api/jobs`、
 * `PATCH /api/jobs/:id`、`pause` / `resume` / `cancel` / `trigger`。
 * 状态机语义（终态不可恢复、暂停期间不补跑）由 WakerDO 决定，前端只在操作入口上做可见性收敛。
 */
export function JobsPage() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<JobFiltersValue>(EMPTY_FILTERS)
  // keyset 分页没有页码，只保留「每页入口游标」的栈，用来支持「上一页」。
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])
  const [formState, setFormState] = useState<{ open: boolean; mode: 'create' | 'edit'; job?: JobView }>({
    open: false,
    mode: 'create',
  })
  const [cancelTarget, setCancelTarget] = useState<JobView | null>(null)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)

  const cursor = cursorStack.at(-1) ?? null
  const page = cursorStack.length

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  const jobsQuery = useQuery({
    queryKey: ['jobs', filters.projectId, filters.kind, filters.status, cursor],
    queryFn: () =>
      listJobs({
        projectId: filters.projectId === '' ? undefined : filters.projectId,
        kind: filters.kind === '' ? undefined : filters.kind,
        status: filters.status === '' ? undefined : filters.status,
        cursor,
        limit: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  })

  const projects = projectsQuery.data ?? []
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const jobs = jobsQuery.data?.jobs ?? []

  function applyFilters(next: JobFiltersValue) {
    setFilters(next)
    setCursorStack([null])
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  const actionMutation = useMutation({
    mutationFn: ({ job, action }: { job: JobView; action: JobRowAction }) =>
      runJobAction(job.id, action),
    onMutate: ({ job }) => setBusyJobId(job.id),
    onSuccess: async (job) => {
      const label = job.status === 'paused' ? '已暂停' : job.status === 'active' ? '已恢复' : '已取消'
      toast.success(`${job.name} ${label}`)
      await queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error, { job }) => toast.error(describeError(error, `操作 ${job.name} 失败`)),
    onSettled: () => setBusyJobId(null),
  })

  const triggerMutation = useMutation({
    mutationFn: (job: JobView) => triggerJob(job.id),
    onMutate: (job) => setBusyJobId(job.id),
    onSuccess: (result, job) => {
      toast.success(`已排入执行：${job.name}`, {
        description: `executionId ${result.executionId} · 计划 ${formatDateTime(result.scheduledFor)}`,
      })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error, job) => toast.error(describeError(error, `触发 ${job.name} 失败`)),
    onSettled: () => setBusyJobId(null),
  })

  function handleRowAction(job: JobView, action: JobRowAction) {
    if (action === 'cancel') {
      setCancelTarget(job)
      return
    }
    if ((action === 'pause' && !canPause(job)) || (action === 'resume' && !canResume(job))) return
    actionMutation.mutate({ job, action })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="任务管理"
        description="cron 周期任务与 one-shot 一次性任务；每次执行都按策略字段判定重试、并发与抖动。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCwIcon />
              刷新
            </Button>
            <Button size="sm" onClick={() => setFormState({ open: true, mode: 'create' })}>
              <PlusIcon />
              新建任务
            </Button>
          </>
        }
      />

      <JobFilters value={filters} projects={projects} onChange={applyFilters} />

      {jobsQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>任务列表加载失败</AlertTitle>
          <AlertDescription>
            {describeError(jobsQuery.error, '请稍后重试')}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void jobsQuery.refetch()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {jobsQuery.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>还没有任务</EmptyTitle>
            <EmptyDescription>
              新建 cron 任务做周期调度，或给下游建 one-shot 任务做一次性触发。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setFormState({ open: true, mode: 'create' })}>
              <PlusIcon />
              新建任务
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <JobsTable
          jobs={jobs}
          projectNames={projectNames}
          busyJobId={busyJobId}
          onEdit={(job) => setFormState({ open: true, mode: 'edit', job })}
          onTrigger={(job) => triggerMutation.mutate(job)}
          onAction={handleRowAction}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          第 {page} 页 · 每页最多 {PAGE_SIZE} 条
          {jobsQuery.isFetching && <Loader2Icon className="ml-2 inline size-3 animate-spin" />}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={cursorStack.length <= 1 || jobsQuery.isFetching}
            onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
          >
            <ChevronLeftIcon />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!jobsQuery.data?.nextCursor || jobsQuery.isFetching}
            onClick={() => {
              const next = jobsQuery.data?.nextCursor
              if (next) setCursorStack((stack) => [...stack, next])
            }}
          >
            下一页
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <JobFormDialog
        open={formState.open}
        onOpenChange={(open) => setFormState((state) => ({ ...state, open }))}
        mode={formState.mode}
        job={formState.job}
        projects={projects}
      />

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>取消任务「{cancelTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              取消是终态：之后不能再恢复或手动触发，执行历史保留。确认要取消吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留任务</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (cancelTarget !== null) actionMutation.mutate({ job: cancelTarget, action: 'cancel' })
                setCancelTarget(null)
              }}
            >
              确认取消
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return fallback
}
