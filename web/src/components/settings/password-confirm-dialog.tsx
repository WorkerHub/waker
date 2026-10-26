import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/**
 * 敏感变更的密码复验对话框（SPEC §5.3，照 eNotify `requirePassword`）。
 *
 * 解绑任一第二因素、删除 Passkey 都必须先复验当前密码 —— 后端会校验
 * （`password_required` / `invalid_password`），这里只是把「要输密码」这件事显式化，
 * 不是安全边界。密码只在这个对话框的组件状态里，提交后立刻清空，不落任何存储。
 */
export function PasswordConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  pending: boolean
  error: string | null
  onConfirm: (password: string) => void
}) {
  const [password, setPassword] = useState('')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPassword('')
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form
          key="password-confirm-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm(password)
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password-confirm">当前密码</FieldLabel>
              <Input
                id="password-confirm"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                disabled={pending}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>密码只用于这一步复验，不会被保存。</FieldDescription>
            </Field>
          </FieldGroup>

          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setPassword('')
                onOpenChange(false)
              }}
            >
              取消
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || password === ''}>
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
