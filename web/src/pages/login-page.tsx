import { useQuery } from '@tanstack/react-query'
import { KeyRoundIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { AuthShell } from '@/components/auth/auth-shell'
import { TwoFactorStep } from '@/components/auth/two-factor-step'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { getSetupState } from '@/lib/auth-api'
import { useSession } from '@/stores/session'

/**
 * 登录页（SPEC §5.1）：两步，密码 → 第二因素。
 *
 * 表单自动填充照《通用技术方案》§5B 全信号集：
 *   - 密码框独占 `type="password"` + `autocomplete="current-password"`（本页第一步有且只有它）；
 *   - 邮箱框 `autocomplete="username"`，与密码框同属一个 form，密码管理器按一条凭据填充；
 *   - 第二步**整块换掉 form**（不同 `key`）+ 验证码框是 `type="text"` + `one-time-code`，
 *     且第二步的 DOM 里**没有任何 password 输入** —— 两步的节点身份不同，自动填充不会串位。
 *
 * 未初始化的系统不显示登录表单，直接引导去 `/setup`（SPEC §3.1）。
 */
export function LoginPage() {
  const session = useSession((state) => state.session)
  const challenge = useSession((state) => state.challenge)
  const error = useSession((state) => state.error)
  const pending = useSession((state) => state.pending)
  const login = useSession((state) => state.login)
  const clearChallenge = useSession((state) => state.clearChallenge)
  const clearError = useSession((state) => state.clearError)

  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const setupStateQuery = useQuery({
    queryKey: ['setup-state'],
    queryFn: getSetupState,
    retry: false,
    staleTime: 30_000,
  })
  const setupState = setupStateQuery.data

  if (session !== null) return <Navigate to="/jobs" replace />
  // 未初始化时没有可登录的账号：引导去初始化页（该页自己会显示「已完成初始化」的反向状态）。
  if (setupState !== undefined && !setupState.initialized) return <Navigate to="/setup" replace />

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const step = await login(email, password)
    if (step === 'session') {
      setPassword('')
      navigate('/jobs', { replace: true })
    }
  }

  return (
    <AuthShell
      title={challenge === null ? '登录 waker' : '两步验证'}
      subtitle={
        challenge === null
          ? '用邮箱与密码登录。开启了第二因素的账号还会多一步验证。'
          : undefined
      }
      footer={
        challenge === null ? (
          setupState?.registrationEnabled === true ? (
            <span className="text-xs">
              还没有账号？<Link className="underline underline-offset-4" to="/register">注册</Link>
              <span className="text-muted-foreground">（注册后默认只读权限，由管理员升级）</span>
            </span>
          ) : (
            <span className="text-xs leading-relaxed text-muted-foreground">
              注册入口由管理员在「系统管理 → 注册开关」控制，当前未开放。
            </span>
          )
        ) : undefined
      }
    >
      {challenge === null ? (
        <form key="login-password-step" onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                disabled={pending}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  if (error !== null) clearError()
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="login-password">密码</FieldLabel>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={pending}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  if (error !== null) clearError()
                }}
              />
              <FieldDescription>
                会话 12 小时有效；过期后回到本页重新登录。
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error !== null && (
            <Alert variant="destructive">
              <KeyRoundIcon />
              <AlertTitle>无法登录</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending || email.trim() === '' || password === ''}>
            {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            {pending ? '正在验证…' : '登录'}
          </Button>
        </form>
      ) : (
        // 整块替换：第二步与第一步没有任何共享的表单节点。
        <div key="login-two-factor-step">
          <TwoFactorStep
            challenge={challenge}
            onCancel={() => {
              clearChallenge()
              clearError()
              setPassword('')
            }}
          />
        </div>
      )}
    </AuthShell>
  )
}
