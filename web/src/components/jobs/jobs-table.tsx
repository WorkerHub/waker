import { CalendarClockIcon, PencilIcon, PlayIcon, RotateCcwIcon, TimerOffIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { JobView } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  canCancel,
  canEdit,
  canPause,
  canResume,
  canTrigger,
  jobStatusVariant,
} from '@/lib/jobs'
import { cn } from '@/lib/utils'

export type JobRowAction = 'pause' | 'resume' | 'cancel'

/** 任务列表表格：纯展示 + 把用户意图回传页面（不自己发请求）。 */
export function JobsTable({
  jobs,
  projectNames,
  onEdit,
  onTrigger,
  onAction,
  busyJobId,
}: {
  jobs: JobView[]
  projectNames: Map<string, string>
  onEdit: (job: JobView) => void
  onTrigger: (job: JobView) => void
  onAction: (job: JobView, action: JobRowAction) => void
  busyJobId: string | null
}) {
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-44">任务</TableHead>
            <TableHead className="min-w-32">项目</TableHead>
            <TableHead className="min-w-40">调度</TableHead>
            <TableHead className="min-w-36">下次执行</TableHead>
            <TableHead className="min-w-32">最近执行</TableHead>
            <TableHead className="min-w-24">状态</TableHead>
            <TableHead className="w-28 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id} className={cn(busyJobId === job.id && 'opacity-60')}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{job.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {JOB_KIND_LABEL[job.kind]}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm">
                {projectNames.get(job.projectId) ?? job.projectId}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs">
                    {job.kind === 'cron' ? (job.cron ?? '—') : '一次性'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {job.kind === 'one_shot' ? formatDateTime(job.runAt) : job.timezone}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                {job.nextRunAt === null ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex flex-col gap-0.5 text-sm">
                        {formatRelative(job.nextRunAt)}
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(job.nextRunAt)}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{formatDateTime(job.nextRunAt)}</TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDateTime(job.lastRunAt)}
              </TableCell>
              <TableCell>
                <Badge variant={jobStatusVariant(job.status)}>{JOB_STATUS_LABEL[job.status]}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="编辑任务"
                        disabled={!canEdit(job)}
                        onClick={() => onEdit(job)}
                      >
                        <PencilIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>编辑</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="立即触发一次"
                        disabled={!canTrigger(job) || busyJobId === job.id}
                        onClick={() => onTrigger(job)}
                      >
                        <PlayIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>手动触发</TooltipContent>
                  </Tooltip>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                        <CalendarClockIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40">
                      {canPause(job) && (
                        <DropdownMenuItem onSelect={() => onAction(job, 'pause')}>
                          <TimerOffIcon />
                          暂停任务
                        </DropdownMenuItem>
                      )}
                      {canResume(job) && (
                        <DropdownMenuItem onSelect={() => onAction(job, 'resume')}>
                          <RotateCcwIcon />
                          恢复任务
                        </DropdownMenuItem>
                      )}
                      {canCancel(job) && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => onAction(job, 'cancel')}>
                            取消任务
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
