import { AlertCircleIcon } from 'lucide-react'

import { TimeRangeFields } from '@/components/time-range-fields'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { DeadLetterReplayState, JobView, ProjectView } from '@/lib/api'
import {
  EMPTY_TIME_RANGE,
  REPLAY_STATE_LABEL,
  type TimeRangeValue,
} from '@/lib/executions'

export interface DeadLetterFiltersValue {
  projectId: string
  jobId: string
  replayState: DeadLetterReplayState | ''
  range: TimeRangeValue
}

export const EMPTY_DEAD_LETTER_FILTERS: DeadLetterFiltersValue = {
  projectId: '',
  jobId: '',
  replayState: '',
  range: EMPTY_TIME_RANGE,
}

/**
 * 死信筛选：直通 B6 `listDeadLetters` 的同名参数
 * （`projectId` / `jobId` / `replayState` / `createdFrom` / `createdTo`）。
 */
export function DeadLetterFilters({
  value,
  projects,
  jobs,
  rangeError,
  onChange,
}: {
  value: DeadLetterFiltersValue
  projects: ProjectView[]
  jobs: JobView[]
  rangeError: string | null
  onChange: (next: DeadLetterFiltersValue) => void
}) {
  const jobsInProject =
    value.projectId === '' ? jobs : jobs.filter((job) => job.projectId === value.projectId)
  const dirty =
    value.projectId !== '' ||
    value.jobId !== '' ||
    value.replayState !== '' ||
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
          aria-label="按重放状态筛选"
          size="sm"
          value={value.replayState}
          onChange={(event) =>
            onChange({ ...value, replayState: event.target.value as DeadLetterReplayState | '' })
          }
        >
          <NativeSelectOption value="">全部重放状态</NativeSelectOption>
          {Object.entries(REPLAY_STATE_LABEL).map(([state, label]) => (
            <NativeSelectOption key={state} value={state}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty}
          onClick={() => onChange(EMPTY_DEAD_LETTER_FILTERS)}
        >
          重置筛选
        </Button>
      </div>

      <TimeRangeFields
        value={value.range}
        onChange={(range) => onChange({ ...value, range })}
        fromLabel="进死信时间（起）"
        toLabel="进死信时间（止）"
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
