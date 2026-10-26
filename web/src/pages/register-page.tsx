import { useQuery, useQueryClient } from '@tanstack/react-query'
import { InfoIcon, Loader2Icon, UserPlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { AuthShell } from '@/components/auth/auth-shell'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { describeAuthError, getSetupState, register } from '@/lib/auth-api'
import { ApiError } from '@/lib/api'
import { useSession } from '@/stores/session'

/**
 * 注册页（SPEC §4.2）。
 *
 * 开关由管理员在「系统管理 → 注册开关」控制，状态来自公开的 `GET /api/setup/state`：
 *   - `registrationEnabled != true` → **只显示关闭提示，DOM 里不出现注册表单**（连输入框都没有）；
 *   - 开关打开 → 注册即登录（`role='viewer'`，写接口仍由后端 403，前端隐藏按钮不等于安全）；
 *   - 系统还没初始化 → 引导去 `/setup`（第一个用户只能从初始化页建）。
 *
 * 后端仍是唯一判据：即使有人绕过页面直接打接口，关闭期间也只会拿到 403 `registration_closed`。
 */
export function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useSession((state) => state.session)
  const adopt = useSession((state) => state.adopt)

  const setupStateQuery = useQuery({
    queryKey: ['setup-state'],
    queryFn: getSetupState,
    retry: false,
    staleTime: 15_000,
  })
  const setupState = setupStateQuery.data

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session !== null) return <Navigate to="/jobs" replace />
  if (setupState !== undefined && !setupState.initialized) return <Navigate to="/setup" replace />

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const result = await register({ email, password, displayName })
      setPassword('')
      adopt(result)
      navigate('/jobs', { replace: true })
    } catch (caught) {
      setError(describeAuthError(caught))
      // 开关在别处被关掉：重新拉一次状态，页面会立刻切成「已关闭」提示，不再留可提交的表单。
      if (caught instanceof ApiError && caught.code === 'registration_closed') {
        void queryClient.invalidateQueries({ queryKey: ['setup-state'] })
      }
    } finally {
      setPending(false)
    }
  }

  const closed = setupState !== undefined && !setupState.registrationEnabled

  return (
    <AuthShell
      title={closed ? '注册未开放' : '注册账号'}
      subtitle={
        closed
          ? undefined
          : '注册后默认只读（viewer）：可以查看任务与执行记录，写操作由管理员授权。'
      }
      footer={
        <span className="text-xs">
          已有账号？<Link className="underline underline-offset-4" to="/login">去登录</Link>
        </span>
      }
    >
      {closed ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <InfoIcon className="size-4" />
              管理员尚未开放注册
            </CardTitle>
            <CardDescription>
              注册开关默认关闭，需要管理员在「系统管理 → 注册开关」里打开。已有账号可直接登录。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/login">去登录</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <form key="register-form" onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="register-display-name">昵称</FieldLabel>
              <Input
                id="register-display-name"
                name="displayName"
                type="text"
                autoComplete="nickname"
                autoFocus
                required
                disabled={pending}
                placeholder="显示在界面上的名字"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="register-email">邮箱</FieldLabel>
              <Input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={pending}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="register-password">密码</FieldLabel>
              <Input
                id="register-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                disabled={pending}
                placeholder="至少 8 个字符"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>
                注册即是登录；之后可在「设置 → 安全」开启第二因素与首选方法。
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error !== null && (
            <Alert variant="destructive">
              <UserPlusIcon />
              <AlertTitle>注册没有完成</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending || email.trim() === '' || password === ''}>
            {pending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />}
            {pending ? '正在注册…' : '注册并登录'}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
