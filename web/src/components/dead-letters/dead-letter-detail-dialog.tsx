import { DetailRow, DetailSection } from '@/components/detail-rows'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DeadLetterView } from '@/lib/api'
import { canReplay, deadLetterJobLabel, formatAttempts, REPLAY_STATE_LABEL } from '@/lib/executions'
import { formatDateTime, prettyJson } from '@/lib/format'

/**
 * 死信详情：失败原因 + 载荷（`DeadLetterView.payload` 是契约里唯一带载荷的视图）+ 重放留痕。
 *
 * 载荷只读展示（`<pre>`），不解析成表单、也不回写任何东西；重放动作在列表页由用户显式触发。
 */
export function DeadLetterDetailDialog({
  deadLetter,
  jobNames,
  projectNames,
  onOpenChange,
}: {
  deadLetter: DeadLetterView | null
  jobNames: Map<string, string>
  projectNames: Map<string, string>
  onOpenChange: (open: boolean) => void
}) {
  const replayable = deadLetter !== null && canReplay(deadLetter)

  return (
    <Dialog open={deadLetter !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            死信详情
            {deadLetter !== null && (
              <Badge variant={replayable ? 'secondary' : 'outline'}>
                {REPLAY_STATE_LABEL[replayable ? 'pending' : 'replayed']}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {deadLetter?.id ?? ''}
          </DialogDescription>
        </DialogHeader>

        {deadLetter !== null && (
          <div className="flex flex-col gap-4">
            <DetailSection title="概览">
              <DetailRow label="来源任务" value={deadLetterJobLabel(deadLetter, jobNames)} />
              <DetailRow
                label="项目"
                value={projectNames.get(deadLetter.projectId) ?? deadLetter.projectId}
              />
              <DetailRow label="任务 ID" value={deadLetter.jobId} mono />
              <DetailRow label="executionId" value={deadLetter.executionId} mono />
              <DetailRow label="尝试次数" value={formatAttempts(deadLetter.attempts)} />
              <DetailRow label="进死信时间" value={formatDateTime(deadLetter.createdAt)} />
            </DetailSection>

            <DetailSection title="失败原因">
              <DetailRow label="错误信息" value={deadLetter.error} mono />
            </DetailSection>

            <DetailSection title="载荷" description="重放会按这份载荷重新投递一次。">
              <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                {prettyJson(deadLetter.payload)}
              </pre>
            </DetailSection>

            <DetailSection title="重放留痕">
              <DetailRow
                label="重放时刻"
                value={deadLetter.replayedAt === null ? null : formatDateTime(deadLetter.replayedAt)}
              />
              <DetailRow label="新执行 ID" value={deadLetter.replayedExecutionId} mono />
            </DetailSection>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
