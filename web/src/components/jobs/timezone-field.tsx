import { useEffect, useRef, useState } from 'react'

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  COMMON_TIME_ZONES,
  CUSTOM_TIME_ZONE_VALUE,
  isCommonTimeZone,
  timeZoneLabel,
} from '@/lib/timezones'

/**
 * 时区字段：可见的常用时区下拉 + 「自定义」手填任意 IANA 名。
 *
 * 下拉只列常用预置（用户定版）；清单之外的时区切到自定义模式手填 IANA 名，
 * 合法性仍是后端 `invalid_timezone` 说了算，这里只做即时预检。
 */
export function TimeZoneField({
  id,
  value,
  onChange,
  error,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  error?: { message?: string }
}) {
  // 初始模式跟着当前值走：编辑一个非常用（或手填时代的）时区任务会直接进自定义模式，
  // 原值带着显示，不会被悄悄改写成预置项。
  const [manual, setManual] = useState(() => !isCommonTimeZone(value))
  const lastEmitted = useRef<string | null>(null)

  // 外部换值（对话框重置、切到另一个任务）时同步模式；自己手输入产生的变更不重置模式，
  // 否则刚好打进某个预置名的那一刻输入框会消失。
  useEffect(() => {
    if (lastEmitted.current === value) return
    setManual(!isCommonTimeZone(value))
  }, [value])

  const manualInputId = `${id}-manual`

  return (
    <Field>
      <FieldLabel htmlFor={id}>时区</FieldLabel>
      <NativeSelect
        id={id}
        className="w-full"
        value={manual ? CUSTOM_TIME_ZONE_VALUE : value}
        onChange={(event) => {
          const next = event.target.value
          if (next === CUSTOM_TIME_ZONE_VALUE) {
            setManual(true)
            return
          }
          setManual(false)
          onChange(next)
        }}
      >
        {COMMON_TIME_ZONES.map((timeZone) => (
          <NativeSelectOption key={timeZone} value={timeZone}>
            {timeZoneLabel(timeZone)}
          </NativeSelectOption>
        ))}
        <NativeSelectOption value={CUSTOM_TIME_ZONE_VALUE}>
          自定义（手动输入）
        </NativeSelectOption>
      </NativeSelect>

      {manual && (
        <Input
          id={manualInputId}
          value={value}
          placeholder="Asia/Shanghai"
          autoComplete="off"
          spellCheck={false}
          aria-label="自定义 IANA 时区"
          onChange={(event) => {
            lastEmitted.current = event.target.value
            onChange(event.target.value)
          }}
        />
      )}

      <FieldDescription>
        {manual
          ? '填写任意 IANA 时区名，例如 Europe/Berlin；常用时区可在上方直接选。'
          : '以上是常用时区；其他 IANA 时区切到「自定义」手动填写。'}
      </FieldDescription>
      <FieldError errors={[error]} />
    </Field>
  )
}
