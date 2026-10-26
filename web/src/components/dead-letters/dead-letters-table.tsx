import { RotateCcwIcon, ScrollTextIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DeadLetterView } from '@/lib/api'
import { canReplay, deadLetterJobLabel, formatAttempts, REPLAY_STATE_LABEL } from '@/lib/executions'
import { formatDateTime } from '@/lib/format'

/**
 * 死信表格：来源任务 / executionId / 失败原因 / 重试次数 / 重放状态 + 重放入口。
 *
 * 字段全部来自 B3 冻结的 `DeadLetterView`：`attempts` 是「累计尝试次数」，
 * 与执行记录的 `attempt`（已重试次数）语义不同，标签也照契约分开写。
 * 事件顺序（未重放优先）由 WakerDO 定，前端不改排序。
 */
export function DeadLettersTable({
  deadLetters,
  jobNames,
  busyDeadLetterId,
  onReplay,
  onOpenDetail,
}: {
  deadLetters: DeadLetterView[]
  jobNames: Map<string, string>
  busyDeadLetterId: string | null
  onReplay: (deadLetter: DeadLetterView) => void
  onOpenDetail: (deadLetter: DeadLetterView) => void
}) {
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-44">来源任务</TableHead>
            <TableHead className="min-w-44">executionId</TableHead>
            <TableHead className="min-w-56">失败原因</TableHead>
            <TableHead className="min-w-20">尝试次数</TableHead>
            <TableHead className="min-w-40">进死信时间</TableHead>
            <TableHead className="min-w-28">重放状态</TableHead>
            <TableHead className="w-24 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deadLetters.map((deadLetter) => (
            <TableRow key={deadLetter.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{deadLetterJobLabel(deadLetter, jobNames)}</span>
                  <span className="font-mono text-xs break-all text-muted-foreground">
                    {deadLetter.jobId}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {deadLetter.executionId}
              </TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="line-clamp-2 text-sm text-destructive">{deadLetter.error}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md break-words">{deadLetter.error}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-sm">{formatAttempts(deadLetter.attempts)}</TableCell>
              <TableCell className="text-sm">{formatDateTime(deadLetter.createdAt)}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <Badge variant={canReplay(deadLetter) ? 'secondary' : 'outline'}>
                    {REPLAY_STATE_LABEL[canReplay(deadLetter) ? 'pending' : 'replayed']}
                  </Badge>
                  {deadLetter.replayedExecutionId !== null && (
                    <span className="font-mono text-xs break-all text-muted-foreground">
                      → {deadLetter.replayedExecutionId}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="查看死信详情"
                        onClick={() => onOpenDetail(deadLetter)}
                      >
                        <ScrollTextIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>详情</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="重放死信"
                        disabled={!canReplay(deadLetter) || busyDeadLetterId === deadLetter.id}
                        onClick={() => onReplay(deadLetter)}
                      >
                        <RotateCcwIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {canReplay(deadLetter) ? '重放' : '已重放过，不能再次重放'}
                    </TooltipContent>
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
