import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlusIcon } from 'lucide-react'
import { useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { describeAuthError, getSystemSettings, setRegistrationEnabled } from '@/lib/auth-api'

/**
 * 系统管理 → 注册开关（SPEC §4.2 / §6.1，仅 admin）。
 *
 * 默认关闭（首个管理员建成时后端写 `'0'`）；打开后注册即生效，不加待批准队列。
 * 关闭**不影响存量用户登录** —— 开关只拦 `POST /api/auth/register`。
 */
export function RegistrationCard() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['system-settings'],
    queryFn: getSystemSettings,
    retry: false,
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enabled = settingsQuery.data?.registrationEnabled === true

  async function toggle(next: boolean) {
    setPending(true)
    setError(null)
    try {
      await setRegistrationEnabled(next)
      await queryClient.invalidateQueries({ queryKey: ['system-settings'] })
      // 注册页读的是公开的 /api/setup/state，开关一变就该同步。
      await queryClient.invalidateQueries({ queryKey: ['setup-state'] })
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlusIcon className="size-4" />
          注册开关
        </CardTitle>
        <CardDescription>开启后任何人都能注册；新用户默认只读（viewer）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field orientation="horizontal">
          <Switch
            id="registration-enabled"
            checked={enabled}
            disabled={pending || settingsQuery.isPending}
            onCheckedChange={(next) => void toggle(next)}
          />
          <FieldLabel htmlFor="registration-enabled">
            {enabled ? '注册已开放' : '注册已关闭'}
          </FieldLabel>
        </Field>

        {error !== null && (
          <Alert variant="destructive">
            <UserPlusIcon />
            <AlertTitle>开关没有保存</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        关闭只拦新注册；已注册用户照常登录。权限仍在接口层判定，开关与角色是两件事。
      </CardFooter>
    </Card>
  )
}
