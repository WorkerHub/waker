import type { JobKind, JobStatus, JobView } from '@/lib/api'

/** 任务列表 / 表单共用的一层「契约 → 展示」映射，不含任何调度语义。 */

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  active: '启用中',
  paused: '已暂停',
  cancelled: '已取消',
  completed: '已完成',
}

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  cron: 'cron 周期',
  one_shot: 'one-shot 一次性',
}

export const MISFIRE_LABEL = {
  fire_once: '补跑一次',
  skip: '跳过',
  fire_all: '逐个补齐',
} as const

export const CONCURRENCY_LABEL = {
  forbid: '禁止并发',
  allow: '允许并发',
} as const

export function jobStatusVariant(
  status: JobStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'active':
      return 'default'
    case 'paused':
      return 'secondary'
    case 'cancelled':
      return 'destructive'
    case 'completed':
      return 'outline'
  }
}

/** 编辑只改调度参数：name / kind / project 是契约里的不可变键（改名等于换任务）。 */
export function canEdit(job: JobView): boolean {
  return job.status === 'active' || job.status === 'paused'
}

export function canPause(job: JobView): boolean {
  return job.status === 'active'
}

export function canResume(job: JobView): boolean {
  return job.status === 'paused'
}

/** `cancel` 是终态：已取消 / 已完成的任务不再提供取消入口。 */
export function canCancel(job: JobView): boolean {
  return job.status === 'active' || job.status === 'paused'
}

/** 契约：paused / completed 可手动触发，cancelled 不可。 */
export function canTrigger(job: JobView): boolean {
  return job.status !== 'cancelled'
}

/** 调度摘要：cron 任务展示原始表达式，one-shot 展示执行时刻（由调用方决定格式化）。 */
export function jobScheduleSummary(job: JobView): string {
  return job.kind === 'cron' ? (job.cron ?? '—') : '一次性'
}
