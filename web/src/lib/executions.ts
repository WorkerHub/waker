import type {
  DeadLetterReplayState,
  DeadLetterView,
  ExecutionStatus,
  ExecutionTrigger,
  ExecutionView,
} from '@/lib/api'

/** 执行记录 / 死信页共用的一层「契约 → 展示」映射，不含任何执行语义。 */

export const EXECUTION_STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending: '等待投递',
  dispatched: '已投递',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  dead: '已进死信',
  skipped: '已跳过',
}

export const EXECUTION_TRIGGER_LABEL: Record<ExecutionTrigger, string> = {
  schedule: '调度触发',
  manual: '手动触发',
}

export const REPLAY_STATE_LABEL: Record<DeadLetterReplayState, string> = {
  pending: '待重放',
  replayed: '已重放',
}

export function executionStatusVariant(
  status: ExecutionStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'succeeded':
      return 'default'
    case 'running':
    case 'dispatched':
      return 'secondary'
    case 'failed':
    case 'dead':
      return 'destructive'
    case 'pending':
    case 'skipped':
      return 'outline'
  }
}

/**
 * 耗时展示：契约给的是 `durationMs`（未结束为 null），这里只做单位换算。
 * 没结束的执行不编时长为 0，直接显示「—」。
 */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '—'
  if (durationMs < 1000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

/** 重试次数列：`attempt` 是「已重试次数」（0 = 首次投递）。 */
export function formatAttempts(attempt: number): string {
  return attempt === 0 ? '首次' : `${attempt} 次`
}

/** 任务名兜底：`jobName` 是联表结果，老数据/任务行缺失时为 null。 */
export function jobLabel(jobId: string, jobName: string | null | undefined): string {
  return jobName === null || jobName === undefined || jobName === '' ? jobId : jobName
}

/** 死信只提供 `jobId`（B3 冻结的 `DeadLetterView` 没有 jobName），由调用方用任务列表映射。 */
export function deadLetterJobLabel(deadLetter: DeadLetterView, jobNames: Map<string, string>): string {
  return jobLabel(deadLetter.jobId, jobNames.get(deadLetter.jobId) ?? null)
}

/** 只有还没重放过的死信才提供「重放」入口。 */
export function canReplay(deadLetter: DeadLetterView): boolean {
  return deadLetter.replayedAt === null
}

/** 执行详情里「有没有回调结果」：WakerDO 只在拿到下游响应后写这两列。 */
export function hasCallbackResult(execution: ExecutionView): boolean {
  return execution.responseStatus !== null || execution.error !== null || execution.finishedAt !== null
}

/** 半开时间区间 `[from, to)`；`from < to` 才合法，`from === to` 是合法空区间但页面不发送。 */
export interface TimeRangeValue {
  from: string
  to: string
}

export const EMPTY_TIME_RANGE: TimeRangeValue = { from: '', to: '' }

export function timeRangeToEpoch(range: TimeRangeValue): { from: number | null; to: number | null } {
  return { from: toEpoch(range.from), to: toEpoch(range.to) }
}

function toEpoch(local: string): number | null {
  if (local === '') return null
  const parsed = new Date(local).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 前端只做「一眼可见」的区间合法性提示（`from > to` 契约会回 `invalid_argument`）；
 * 时区语义、半开区间判定仍在 WakerDO。
 */
export function timeRangeError(range: TimeRangeValue): string | null {
  const { from, to } = timeRangeToEpoch(range)
  if (from !== null && to !== null && from > to) return '起始时间必须早于结束时间'
  return null
}
