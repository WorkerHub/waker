import { useQueryClient } from '@tanstack/react-query'
import { IdCardIcon, KeyRoundIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { changePassword, describeAuthError, updateProfile } from '@/lib/auth-api'
import { formatDateTime } from '@/lib/format'
import { useMe } from '@/hooks/use-me'

/**
 * 「设置 → 个人资料」（SPEC §4.2 的 viewer 白名单里唯一的资料写入口）。
 *
 * 只做两件事，且都以接口为准：
 *   - 改昵称：`PATCH /api/me { displayName }`；
 *   - 改密码：`POST /api/me/password { currentPassword, newPassword }` —— **必须复验当前密码**
 *     （SPEC §5.3 的敏感变更），所以这里有一个独立的 `current-password` 框。
 *
 * 邮箱不可改：它是登录标识与邮件验证码的收件地址，改邮箱得走管理员删除重建（本单不做）。
 */
export function ProfileSection() {
  const meQuery = useMe()
  const queryClient = useQueryClient()
  const me = meQuery.data

  const [displayName, setDisplayName] = useState('')
  const [namePending, setNamePending] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameSaved, setNameSaved] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordPending, setPasswordPending] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSaved, setPasswordSaved] = useState(false)

  async function saveDisplayName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNamePending(true)
    setNameError(null)
    setNameSaved(false)
    try {
      await updateProfile(displayName.trim())
      setDisplayName('')
      setNameSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (caught) {
      setNameError(describeAuthError(caught))
    } finally {
      setNamePending(false)
    }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordPending(true)
    setPasswordError(null)
    setPasswordSaved(false)
    try {
      await changePassword({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setPasswordSaved(true)
    } catch (caught) {
      setPasswordError(describeAuthError(caught))
    } finally {
      setPasswordPending(false)
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IdCardIcon className="size-4" />
            个人资料
          </CardTitle>
          <CardDescription>昵称可以自己改；邮箱是登录标识，由管理员维护。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DetailSection title="当前账号">
            <DetailRow label="邮箱" value={me?.user.email ?? '—'} mono />
            <DetailRow label="昵称" value={me?.user.displayName ?? '—'} />
            <DetailRow
              label="角色"
              value={
                me === undefined ? (
                  '—'
                ) : (
                  <Badge variant={me.user.role === 'admin' ? 'default' : 'secondary'}>
                    {roleLabel(me.user.role)}
                  </Badge>
                )
              }
            />
            <DetailRow label="上次登录" value={formatDateTime(me?.user.lastLoginAt ?? null)} />
          </DetailSection>

          <form onSubmit={saveDisplayName} className="flex flex-col gap-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="profile-display-name">改昵称</FieldLabel>
                <Input
                  id="profile-display-name"
                  name="displayName"
                  type="text"
                  autoComplete="nickname"
                  required
                  disabled={namePending}
                  placeholder={me?.user.displayName ?? '新的昵称'}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
            </FieldGroup>
            {nameError !== null && (
              <Alert variant="destructive">
                <IdCardIcon />
                <AlertTitle>昵称没有保存</AlertTitle>
                <AlertDescription>{nameError}</AlertDescription>
              </Alert>
            )}
            {nameSaved && <p className="text-xs text-muted-foreground">昵称已更新。</p>}
            <Button type="submit" size="sm" disabled={namePending || displayName.trim() === ''}>
              {namePending ? <Loader2Icon className="animate-spin" /> : null}
              保存昵称
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" />
            改密码
          </CardTitle>
          <CardDescription>敏感变更：必须先验证当前密码（SPEC §5.3）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={savePassword} className="flex flex-col gap-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
                <Input
                  id="current-password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  disabled={passwordPending}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                <Input
                  id="new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  disabled={passwordPending}
                  placeholder="至少 8 个字符"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <FieldDescription>
                  改密只影响后续登录；当前会话是 12 小时无状态 JWT，不会立刻失效。
                </FieldDescription>
              </Field>
            </FieldGroup>

            {passwordError !== null && (
              <Alert variant="destructive">
                <KeyRoundIcon />
                <AlertTitle>密码没有改成功</AlertTitle>
                <AlertDescription>{passwordError}</AlertDescription>
              </Alert>
            )}
            {passwordSaved && <p className="text-xs text-muted-foreground">密码已更新。</p>}

            <Button
              type="submit"
              size="sm"
              disabled={passwordPending || currentPassword === '' || newPassword === ''}
            >
              {passwordPending ? <Loader2Icon className="animate-spin" /> : null}
              保存新密码
            </Button>
          </form>
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          忘记密码且没有可用的第二因素时，应用内没有恢复路径，只能走部署侧处置（SPEC §3.3）。
        </CardFooter>
      </Card>
    </div>
  )
}

export function roleLabel(role: 'admin' | 'viewer'): string {
  return role === 'admin' ? '管理员' : '只读'
}
