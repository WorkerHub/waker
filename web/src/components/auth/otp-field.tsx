import { Input } from '@/components/ui/input'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/**
 * 单框 OTP / TOTP 输入（舰队《通用技术方案》§5B 全信号集）。
 *
 * 自动填充要求逐条落在属性上（`vaultwarden` 实测按这些信号识别）：
 *   - `type="text"`：**不能**是 `password`，否则密码管理器把它当密码框、和真密码框串位；
 *   - `autocomplete="one-time-code"`：一次性验证码的标准信号；
 *   - `inputmode="numeric"` + `pattern="[0-9]*"`：移动端弹数字键盘；
 *   - 单框：不拆成 6 个格子（拆格会让密码管理器填第一个格子，且焦点流转要自己写）；
 *   - `name` / `id` 不含 `password` 字样（`code`）。
 *
 * 组件只做「信号 + 非数字过滤」，不自己实现键盘导航 / 粘贴分发 / 焦点管理 ——
 * 那些是单框输入本来就不需要的行为。
 */
export function OtpField({
  id,
  label = '验证码',
  description,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  invalid = false,
  length = 6,
}: {
  id: string
  label?: string
  description?: React.ReactNode
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  invalid?: boolean
  length?: number
}) {
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={invalid}
        disabled={disabled}
        placeholder={'0'.repeat(length)}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, length))}
        className={cn('text-center font-mono text-lg tracking-[0.4em]')}
      />
      {description !== undefined && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}
