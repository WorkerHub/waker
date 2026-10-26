import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { JobKind, JobStatus, ProjectView } from '@/lib/api'
import { JOB_KIND_LABEL, JOB_STATUS_LABEL } from '@/lib/jobs'

export interface JobFiltersValue {
  projectId: string
  kind: JobKind | ''
  status: JobStatus | ''
}

export const EMPTY_FILTERS: JobFiltersValue = { projectId: '', kind: '', status: '' }

/**
 * 列表筛选：三个筛选项与后端 `GET /api/jobs` 的 query 一一对应
 * （`projectId` / `kind` / `status`），前端不多传字段、不在本地二次过滤。
 */
export function JobFilters({
  value,
  projects,
  onChange,
}: {
  value: JobFiltersValue
  projects: ProjectView[]
  onChange: (next: JobFiltersValue) => void
}) {
  const dirty = value.projectId !== '' || value.kind !== '' || value.status !== ''

  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="按项目筛选"
        size="sm"
        value={value.projectId}
        onChange={(event) => onChange({ ...value, projectId: event.target.value })}
      >
        <NativeSelectOption value="">全部项目</NativeSelectOption>
        {projects.map((project) => (
          <NativeSelectOption key={project.id} value={project.id}>
            {project.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <NativeSelect
        aria-label="按类型筛选"
        size="sm"
        value={value.kind}
        onChange={(event) => onChange({ ...value, kind: event.target.value as JobKind | '' })}
      >
        <NativeSelectOption value="">全部类型</NativeSelectOption>
        <NativeSelectOption value="cron">{JOB_KIND_LABEL.cron}</NativeSelectOption>
        <NativeSelectOption value="one_shot">{JOB_KIND_LABEL.one_shot}</NativeSelectOption>
      </NativeSelect>

      <NativeSelect
        aria-label="按状态筛选"
        size="sm"
        value={value.status}
        onChange={(event) => onChange({ ...value, status: event.target.value as JobStatus | '' })}
      >
        <NativeSelectOption value="">全部状态</NativeSelectOption>
        {Object.entries(JOB_STATUS_LABEL).map(([status, label]) => (
          <NativeSelectOption key={status} value={status}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <Button
        variant="ghost"
        size="sm"
        disabled={!dirty}
        onClick={() => onChange(EMPTY_FILTERS)}
      >
        重置筛选
      </Button>
    </div>
  )
}
