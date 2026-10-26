import { DetailRow, DetailSection } from '@/components/detail-rows'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ExecutionView } from '@/lib/api'
import {
  EXECUTION_STATUS_LABEL,
  EXECUTION_TRIGGER_LABEL,
  executionStatusVariant,
  formatAttempts,
  formatDuration,
  hasCallbackResult,
  jobLabel,
} from '@/lib/executions'
import { formatDateTime } from '@/lib/format'

/**
 * 执行详情（F2）：请求侧与回调侧的摘要 + 错误信息。
 *
 * 全部字段来自 B6 冻结的 `ExecutionView`（不含 `payload` / `signingKeyId` ——
 * 载荷不随列表批量下发），所以「请求摘要」只展示调度侧已知事实，
 * 载荷明文在这里**不展示也不自造**。
 */
export function ExecutionDetailDialog({
  execution,
  projectNames,
  onOpenChange,
}: {
  execution: ExecutionView | null
  projectNames: Map<string, string>
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={execution !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            执行详情
            {execution !== null && (
              <Badge variant={executionStatusVariant(execution.status)}>
                {EXECUTION_STATUS_LABEL[execution.status]}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {execution?.id ?? ''}
          </DialogDescription>
        </DialogHeader>

        {execution !== null && (
          <div className="flex flex-col gap-4">
            <DetailSection title="概览">
              <DetailRow label="任务" value={jobLabel(execution.jobId, execution.jobName)} />
              <DetailRow
                label="项目"
                value={projectNames.get(execution.projectId) ?? execution.projectId}
              />
              <DetailRow
                label="触发方式"
                value={
                  execution.misfire
                    ? `${EXECUTION_TRIGGER_LABEL[execution.trigger]}（补跑）`
                    : EXECUTION_TRIGGER_LABEL[execution.trigger]
                }
              />
              <DetailRow label="重试次数" value={formatAttempts(execution.attempt)} />
              <DetailRow
                label="跳过原因"
                value={execution.skipReason === null ? null : execution.skipReason}
                mono
              />
            </DetailSection>

            <DetailSection
              title="请求摘要"
              description="调度侧的投递事实；载荷（payload）不在列表契约里下发，此处不展示。"
            >
              <DetailRow label="计划执行时刻" value={formatDateTime(execution.scheduledFor)} />
              <DetailRow label="分发时刻" value={formatDateTime(execution.dispatchAt)} />
              <DetailRow label="创建时刻" value={formatDateTime(execution.createdAt)} />
              <DetailRow label="任务 ID" value={execution.jobId} mono />
            </DetailSection>

            <DetailSection title="回调响应摘要">
              {hasCallbackResult(execution) ? (
                <>
                  <DetailRow
                    label="响应状态码"
                    value={execution.responseStatus === null ? null : execution.responseStatus}
                  />
                  <DetailRow label="开始时刻" value={formatDateTime(execution.startedAt)} />
                  <DetailRow label="结束时刻" value={formatDateTime(execution.finishedAt)} />
                  <DetailRow label="耗时" value={formatDuration(execution.durationMs)} />
                </>
              ) : (
                <DetailRow
                  label="响应"
                  value="下游还没回写回调结果（未开始或仍在执行）"
                  className="text-muted-foreground"
                />
              )}
              <DetailRow
                label="错误信息"
                value={execution.error === null ? null : execution.error}
                mono
              />
            </DetailSection>

            <DetailSection title="自续" description="一次性任务可自续到下一次执行（B3 冻结语义）。">
              <DetailRow
                label="续期时刻"
                value={execution.renewalAt === null ? null : formatDateTime(execution.renewalAt)}
              />
              <DetailRow
                label="续期失败原因"
                value={execution.renewalError === null ? null : execution.renewalError}
                mono
              />
            </DetailSection>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
