import { useId } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { TimeRangeValue } from '@/lib/executions'

/**
 * 时间区间筛选（执行记录 / 死信两页共用）。
 *
 * 契约两侧字段名不同（`scheduledFrom`/`scheduledTo` 与 `createdFrom`/`createdTo`），
 * 所以这里只提供「取值 + 原样回传」，拼 query 由页面按各自契约字段做。
 * 区间语义由后端定死为半开 `[from, to)`，前端不换算、不做事后过滤。
 */
export function TimeRangeFields({
  value,
  onChange,
  fromLabel = '起始时间',
  toLabel = '结束时间',
}: {
  value: TimeRangeValue
  onChange: (next: TimeRangeValue) => void
  fromLabel?: string
  toLabel?: string
}) {
  const fieldId = useId()

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${fieldId}-from`} className="text-xs text-muted-foreground">
          {fromLabel}
        </Label>
        <Input
          id={`${fieldId}-from`}
          aria-label={fromLabel}
          type="datetime-local"
          className="w-52"
          value={value.from}
          onChange={(event) => onChange({ ...value, from: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${fieldId}-to`} className="text-xs text-muted-foreground">
          {toLabel}
        </Label>
        <Input
          id={`${fieldId}-to`}
          aria-label={toLabel}
          type="datetime-local"
          className="w-52"
          value={value.to}
          onChange={(event) => onChange({ ...value, to: event.target.value })}
        />
      </div>
    </div>
  )
}
