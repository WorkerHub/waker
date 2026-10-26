import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** 详情面板的分区（执行详情 / 死信详情共用同一套排版）。 */
export function DetailSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description !== undefined && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex flex-col divide-y rounded-lg border">{children}</div>
    </section>
  )
}

/** 一行「字段名 → 值」；值是长文本时自动换行，空值统一显示 `—`。 */
export function DetailRow({
  label,
  value,
  mono = false,
  className,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  className?: string
}) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className={cn('flex flex-wrap items-start gap-2 px-3 py-2 text-sm', className)}>
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          mono && 'font-mono text-xs',
          empty && 'text-muted-foreground',
        )}
      >
        {empty ? '—' : value}
      </span>
    </div>
  )
}
