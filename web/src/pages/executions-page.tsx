import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircleIcon, RefreshCwIcon, ScrollTextIcon } from 'lucide-react'
import { useState } from 'react'

import { CursorPager } from '@/components/cursor-pager'
import { ExecutionDetailDialog } from '@/components/executions/execution-detail-dialog'
import {
  EMPTY_EXECUTION_FILTERS,
  ExecutionFilters,
  type ExecutionFiltersValue,
} from '@/components/executions/execution-filters'
import { ExecutionsTable } from '@/components/executions/executions-table'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  listExecutions,
  listJobs,
  listProjects,
  isNotImplementedError,
  PAGE_LIMIT_MAX,
  type ExecutionView,
} from '@/lib/api'
import { timeRangeError, timeRangeToEpoch } from '@/lib/executions'

const PAGE_SIZE = 25

/**
 * 执行记录页（F2）。
 *
 * 数据面只走 B6 冻结的查询契约 `listExecutions`
 * （HTTP `GET /api/executions`: `jobId` / `projectId` / `status` / `trigger` /
 * `scheduledFrom` / `scheduledTo` / `limit` / `cursor`）：筛选与翻页全部下推给 WakerDO，
 * 前端不本地过滤、不编页码（`nextCursor` 是唯一翻页依据）。
 */
export function ExecutionsPage() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<ExecutionFiltersValue>(EMPTY_EXECUTION_FILTERS)
  // keyset 分页没有页码，只保留「每页入口游标」的栈来支持「上一页」。
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])
  const [detail, setDetail] = useState<ExecutionView | null>(null)

  const cursor = cursorStack.at(-1) ?? null
  const page = cursorStack.length
  const rangeError = timeRangeError(filters.range)
  const { from, to } = timeRangeToEpoch(filters.range)

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  // 任务下拉的数据源：契约的 `listJobs`（分页上限 200），按所选项目收敛。
  const jobsQuery = useQuery({
    queryKey: ['jobs', 'execution-filter', filters.projectId],
    queryFn: () =>
      listJobs({
        projectId: filters.projectId === '' ? undefined : filters.projectId,
        limit: PAGE_LIMIT_MAX,
      }),
  })

  const executionsQuery = useQuery({
    queryKey: [
      'executions',
      filters.projectId,
      filters.jobId,
      filters.status,
      filters.trigger,
      from,
      to,
      cursor,
    ],
    queryFn: () =>
      listExecutions({
        projectId: filters.projectId === '' ? undefined : filters.projectId,
        jobId: filters.jobId === '' ? undefined : filters.jobId,
        status: filters.status === '' ? undefined : filters.status,
        trigger: filters.trigger === '' ? undefined : filters.trigger,
        // 半开区间 [from, to)：只发用户真的填了的那一端。
        scheduledFrom: from ?? undefined,
        scheduledTo: to ?? undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
    // 区间非法时后端会回 `invalid_argument`；前端先停手，避免拿必然失败的参数打接口。
    enabled: rangeError === null,
  })

  const projects = projectsQuery.data ?? []
  const jobs = jobsQuery.data?.jobs ?? []
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const executions = executionsQuery.data?.executions ?? []
  const dirty = hasFilters(filters)

  function applyFilters(next: ExecutionFiltersValue) {
    setFilters(next)
    setCursorStack([null])
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['executions'] })
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
    void queryClient.invalidateQueries({ queryKey: ['jobs'] })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="执行记录"
        description="每一次调度、手动触发与死信重放都会落一条执行记录；按任务、状态、触发方式与时间区间查询。"
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCwIcon />
            刷新
          </Button>
        }
      />

      <ExecutionFilters
        value={filters}
        projects={projects}
        jobs={jobs}
        rangeError={rangeError}
        onChange={applyFilters}
      />

      {executionsQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>执行记录加载失败</AlertTitle>
          <AlertDescription>
            {describeError(executionsQuery.error, '请稍后重试')}
            {isNotImplementedError(executionsQuery.error) && (
              <span className="mt-1 block text-xs">
                管理面还没有挂载执行记录查询路由（`GET /api/executions`，B6 的
                `listExecutions` 已就位）。这个路径挂上之后本页无需改动即可使用。
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void executionsQuery.refetch()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {executionsQuery.isPending && rangeError === null ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : executionsQuery.isError && executions.length === 0 ? null : executions.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>{dirty ? '没有符合条件的执行记录' : '还没有执行记录'}</EmptyTitle>
            <EmptyDescription>
              {dirty
                ? '换个任务、状态或时间区间再试；筛选条件会原样下推给平台查询。'
                : '任务被调度或手动触发后，这里按计划执行时间倒序展示每一条执行。'}
            </EmptyDescription>
          </EmptyHeader>
          {dirty && (
            <EmptyContent>
              <Button size="sm" onClick={() => applyFilters(EMPTY_EXECUTION_FILTERS)}>
                重置筛选
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ExecutionsTable
          executions={executions}
          projectNames={projectNames}
          onOpenDetail={setDetail}
        />
      )}

      <CursorPager
        pageSize={PAGE_SIZE}
        currentPage={page}
        canPrev={cursorStack.length > 1}
        nextCursor={executionsQuery.data?.nextCursor}
        isFetching={executionsQuery.isFetching}
        onPrev={() => setCursorStack((stack) => stack.slice(0, -1))}
        onNext={(next) => setCursorStack((stack) => [...stack, next])}
      />

      <ExecutionDetailDialog
        execution={detail}
        projectNames={projectNames}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      />
    </div>
  )
}

function hasFilters(value: ExecutionFiltersValue): boolean {
  return (
    value.projectId !== '' ||
    value.jobId !== '' ||
    value.status !== '' ||
    value.trigger !== '' ||
    value.range.from !== '' ||
    value.range.to !== ''
  )
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return fallback
}
