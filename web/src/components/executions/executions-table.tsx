import { ScrollTextIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExecutionView } from '@/lib/api'
import {
  EXECUTION_STATUS_LABEL,
  EXECUTION_TRIGGER_LABEL,
  executionStatusVariant,
  formatAttempts,
  formatDuration,
  jobLabel,
} from '@/lib/executions'
import { formatDateTime, formatRelative } from '@/lib/format'

/**
 * 执行记录表格：纯展示 + 把「看详情」的意图回传页面（不自己发请求）。
 *
 * 列直接对应契约字段：时间是排序键 `scheduledFor`（名义槽位，不含抖动），
 * 耗时是 `durationMs`，重试次数是 `attempt`（0 = 首次投递）。
 */
export function ExecutionsTable({
  executions,
  projectNames,
  onOpenDetail,
}: {
  executions: ExecutionView[]
  projectNames: Map<string, string>
  onOpenDetail: (execution: ExecutionView) => void
}) {
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-40">计划执行时间</TableHead>
            <TableHead className="min-w-44">任务</TableHead>
            <TableHead className="min-w-24">状态</TableHead>
            <TableHead className="min-w-24">触发</TableHead>
            <TableHead className="min-w-24">耗时</TableHead>
            <TableHead className="min-w-20">重试</TableHead>
            <TableHead className="min-w-20">回调</TableHead>
            <TableHead className="w-20 text-right">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {executions.map((execution) => (
            <TableRow key={execution.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{formatDateTime(execution.scheduledFor)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(execution.scheduledFor)}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {jobLabel(execution.jobId, execution.jobName)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {projectNames.get(execution.projectId) ?? execution.projectId}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant={executionStatusVariant(execution.status)}>
                    {EXECUTION_STATUS_LABEL[execution.status]}
                  </Badge>
                  {execution.misfire && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline">补跑</Badge>
                      </TooltipTrigger>
                      <TooltipContent>错过执行窗口后按 misfire 策略补的那一次</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {EXECUTION_TRIGGER_LABEL[execution.trigger]}
              </TableCell>
              <TableCell className="text-sm">{formatDuration(execution.durationMs)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatAttempts(execution.attempt)}
              </TableCell>
              <TableCell className="text-sm">
                {execution.responseStatus === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span
                    className={
                      execution.responseStatus >= 200 && execution.responseStatus < 300
                        ? 'text-muted-foreground'
                        : 'text-destructive'
                    }
                  >
                    {execution.responseStatus}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="查看执行详情"
                        onClick={() => onOpenDetail(execution)}
                      >
                        <ScrollTextIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>详情</TooltipContent>
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
