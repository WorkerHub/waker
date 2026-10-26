import { AlertCircleIcon } from 'lucide-react'

import { TimeRangeFields } from '@/components/time-range-fields'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type {
  ExecutionStatus,
  ExecutionTrigger,
  JobView,
  ProjectView,
} from '@/lib/api'
import {
  EXECUTION_STATUS_LABEL,
  EXECUTION_TRIGGER_LABEL,
  EMPTY_TIME_RANGE,
  type TimeRangeValue,
} from '@/lib/executions'

export interface ExecutionFiltersValue {
  projectId: string
  jobId: string
  status: ExecutionStatus | ''
  trigger: ExecutionTrigger | ''
  range: TimeRangeValue
}

export const EMPTY_EXECUTION_FILTERS: ExecutionFiltersValue = {
  projectId: '',
  jobId: '',
  status: '',
  trigger: '',
  range: EMPTY_TIME_RANGE,
}

/**
 * 执行记录筛选：每一项都直通 B6 `listExecutions` 的同名参数
 * （`projectId` / `jobId` / `status` / `trigger` / `scheduledFrom` / `scheduledTo`），
 * 前端不在本地二次过滤、也不拼契约外的字段。
 */
export function ExecutionFilters({
  value,
  projects,
  jobs,
  rangeError,
  onChange,
}: {
  value: ExecutionFiltersValue
  projects: ProjectView[]
  jobs: JobView[]
  rangeError: string | null
  onChange: (next: ExecutionFiltersValue) => void
}) {
  const jobsInProject =
    value.projectId === '' ? jobs : jobs.filter((job) => job.projectId === value.projectId)
  const dirty =
    value.projectId !== '' ||
    value.jobId !== '' ||
    value.status !== '' ||
    value.trigger !== '' ||
    value.range.from !== '' ||
    value.range.to !== ''

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="按项目筛选"
          size="sm"
          value={value.projectId}
          onChange={(event) =>
            // 换项目时清掉任务条件：任务属于项目，留着旧 jobId 只会查不到任何记录。
            onChange({ ...value, projectId: event.target.value, jobId: '' })
          }
        >
          <NativeSelectOption value="">全部项目</NativeSelectOption>
          {projects.map((project) => (
            <NativeSelectOption key={project.id} value={project.id}>
              {project.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          aria-label="按任务筛选"
          size="sm"
          value={value.jobId}
          onChange={(event) => onChange({ ...value, jobId: event.target.value })}
        >
          <NativeSelectOption value="">全部任务</NativeSelectOption>
          {jobsInProject.map((job) => (
            <NativeSelectOption key={job.id} value={job.id}>
              {job.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          aria-label="按状态筛选"
          size="sm"
          value={value.status}
          onChange={(event) =>
            onChange({ ...value, status: event.target.value as ExecutionStatus | '' })
          }
        >
          <NativeSelectOption value="">全部状态</NativeSelectOption>
          {Object.entries(EXECUTION_STATUS_LABEL).map(([status, label]) => (
            <NativeSelectOption key={status} value={status}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          aria-label="按触发方式筛选"
          size="sm"
          value={value.trigger}
          onChange={(event) =>
            onChange({ ...value, trigger: event.target.value as ExecutionTrigger | '' })
          }
        >
          <NativeSelectOption value="">全部触发方式</NativeSelectOption>
          {Object.entries(EXECUTION_TRIGGER_LABEL).map(([trigger, label]) => (
            <NativeSelectOption key={trigger} value={trigger}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty}
          onClick={() => onChange(EMPTY_EXECUTION_FILTERS)}
        >
          重置筛选
        </Button>
      </div>

      <TimeRangeFields
        value={value.range}
        onChange={(range) => onChange({ ...value, range })}
        fromLabel="计划执行时间（起）"
        toLabel="计划执行时间（止）"
      />

      {rangeError !== null && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{rangeError}，已暂停查询</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
