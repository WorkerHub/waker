import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * keyset 游标分页器（执行记录 / 死信两页共用）。
 *
 * 契约里没有页码：`nextCursor` 是唯一翻页依据，所以这里只维护「每页入口游标」的栈，
 * 用来支持「上一页」，绝不编造页码或跳过游标。
 */
export function CursorPager({
  pageSize,
  currentPage,
  canPrev,
  nextCursor,
  isFetching,
  onPrev,
  onNext,
}: {
  pageSize: number
  currentPage: number
  canPrev: boolean
  nextCursor: string | null | undefined
  isFetching: boolean
  onPrev: () => void
  onNext: (cursor: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        第 {currentPage} 页 · 每页最多 {pageSize} 条
        {isFetching && <Loader2Icon className="ml-2 inline size-3 animate-spin" />}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={!canPrev || isFetching} onClick={onPrev}>
          <ChevronLeftIcon />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={nextCursor === null || nextCursor === undefined || isFetching}
          onClick={() => {
            if (nextCursor !== null && nextCursor !== undefined) onNext(nextCursor)
          }}
        >
          下一页
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  )
}
