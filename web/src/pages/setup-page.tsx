import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, KeyRoundIcon, Loader2Icon, ShieldCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { AuthShell } from '@/components/auth/auth-shell'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  beginSetup,
  createFirstAdmin,
  describeAuthError,
  getSetupState,
  type BootstrapTokenView,
} from '@/lib/auth-api'
import { ApiError } from '@/lib/api'
import { useSession } from '@/stores/session'

/**
 * `/setup` 初始化页（SPEC §3）。
 *
 * 两步，前端只负责呈现与信号，判定全在后端：
 *   1. 输 `SETUP_SECRET` → `POST /api/setup` 常量时间校验（按 IP 3 次/10 分钟限流）
 *      → 拿一次性 bootstrap 令牌（≤10 分钟、仅限建首个管理员）；
 *   2. 用令牌提交邮箱 / 密码 / 昵称 → `POST /api/setup/admin` 建首个管理员（`role='admin'`），
 *      令牌即刻作废，成功即拿正式会话。
 *
 * 已初始化（`adminExists`）时页面**只显示「已完成初始化，去登录」**：DOM 里不出现任何
 * setup 表单 —— SETUP_SECRET 在首个管理员存在后彻底失效（SPEC §3.2），不给输入框就没人能试。
 */
export function SetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const adopt = useSession((state) => state.adopt)
  const session = useSession((state) => state.session)

  const setupStateQuery = useQuery({
    queryKey: ['setup-state'],
    queryFn: getSetupState,
    retry: false,
    staleTime: 10_000,
  })

  const [secret, setSecret] = useState('')
  const [bootstrap, setBootstrap] = useState<BootstrapTokenView | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const beginMutation = useMutation({
    mutationFn: (value: string) => beginSetup(value),
    onSuccess: (value) => {
      setBootstrap(value)
    },
    onError: (caught) => {
      // 已经初始化过（密钥失效）：刷新状态，页面立刻切成「已完成初始化」。
      if (caught instanceof ApiError && caught.code === 'already_initialized') {
        void queryClient.invalidateQueries({ queryKey: ['setup-state'] })
      }
    },
  })

  const adminMutation = useMutation({
    mutationFn: () => {
      if (bootstrap === null) throw new Error('缺少 bootstrap 令牌')
      return createFirstAdmin({
        bootstrapToken: bootstrap.bootstrapToken,
        email,
        password,
        displayName,
      })
    },
    onSuccess: (result) => {
      adopt(result)
      setPassword('')
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] })
      navigate('/jobs', { replace: true })
    },
  })

  const state = setupStateQuery.data
  const initialized = state?.initialized === true

  // 未初始化时 `/setup` 就是唯一入口；已登录的人不该再看到初始化页。
  if (session !== null && !initialized) return <Navigate to="/jobs" replace />

  const error = beginMutation.error ?? adminMutation.error

  return (
    <AuthShell
      title={initialized ? '已完成初始化' : '初始化 waker'}
      subtitle={
        initialized
          ? '系统里已经有管理员账号，SETUP_SECRET 已失效。'
          : '首次使用需要一次初始化：验证部署期写入的 SETUP_SECRET，再创建第一个管理员账号。'
      }
      footer={
        <span className="text-xs leading-relaxed">
          初始化只在「系统里一个用户都没有」时可用；首个管理员建成后，SETUP_SECRET 对初始化接口一律失效。
        </span>
      }
    >
      {setupStateQuery.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          正在读取初始化状态…
        </div>
      ) : initialized ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-4" />
              已完成初始化
              <Badge variant="outline" className="font-mono">
                schema v{state?.schemaVersion ?? 0}
              </Badge>
            </CardTitle>
            <CardDescription>首个管理员已存在，不再需要 SETUP_SECRET。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/login">
                <KeyRoundIcon />
                去登录
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : bootstrap === null ? (
        <form
          key="setup-secret-step"
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            const submitted = secret
            // 提交后立刻清空 SETUP_SECRET 输入（§3.1 的框信号要求），无论成败都不再留在 DOM 里。
            setSecret('')
            beginMutation.mutate(submitted)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-secret">SETUP_SECRET</FieldLabel>
              <Input
                id="setup-secret"
                name="setup-secret"
                type="password"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                required
                disabled={beginMutation.isPending}
                placeholder="部署时写入的 SETUP_SECRET"
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value)
                  if (beginMutation.error !== null) beginMutation.reset()
                }}
              />
              <FieldDescription>
                提交后输入框会立刻清空；校验通过会发一枚 10 分钟内有效的 bootstrap 令牌，只用来建第一个管理员。
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error !== null && <SetupError error={error} phase="secret" />}

          <Button type="submit" disabled={beginMutation.isPending || secret.trim() === ''}>
            {beginMutation.isPending ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
            {beginMutation.isPending ? '正在校验…' : '验证并继续'}
          </Button>
        </form>
      ) : (
        <form
          key="setup-admin-step"
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            adminMutation.mutate()
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-email">管理员邮箱</FieldLabel>
              <Input
                id="setup-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                disabled={adminMutation.isPending}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-display-name">昵称</FieldLabel>
              <Input
                id="setup-display-name"
                name="displayName"
                type="text"
                autoComplete="nickname"
                required
                disabled={adminMutation.isPending}
                placeholder="显示在界面上的名字"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-password">密码</FieldLabel>
              <Input
                id="setup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                disabled={adminMutation.isPending}
                placeholder="至少 8 个字符"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>
                这是新建账号的密码，所以标 `new-password`（登录页的密码框才是 `current-password`）。
                首个管理员建成后可以再进「设置 → 安全」开启第二因素。
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error !== null && <SetupError error={error} phase="admin" />}

          <Button
            type="submit"
            disabled={adminMutation.isPending || email.trim() === '' || password === ''}
          >
            {adminMutation.isPending ? <Loader2Icon className="animate-spin" /> : <CheckCircle2Icon />}
            {adminMutation.isPending ? '正在创建…' : '创建管理员并进入'}
          </Button>

          <p className="text-xs leading-relaxed text-muted-foreground">
            bootstrap 令牌只存在这个页面的内存里，离开或刷新都要重新验证 SETUP_SECRET。
          </p>
        </form>
      )}
    </AuthShell>
  )
}

function SetupError({ error, phase }: { error: unknown; phase: 'secret' | 'admin' }) {
  return (
    <Alert variant="destructive">
      <KeyRoundIcon />
      <AlertTitle>初始化没有完成</AlertTitle>
      <AlertDescription>{setupErrorMessage(error, phase)}</AlertDescription>
    </Alert>
  )
}

/**
 * 初始化阶段的文案特化：`invalid_credentials` 在这里是「SETUP_SECRET 不对」，
 * 不能套用登录面的「邮箱或密码不正确」。其余错误码仍走统一的提示表。
 */
function setupErrorMessage(error: unknown, phase: 'secret' | 'admin'): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'SETUP_SECRET 不正确或未配置'
    if (error.code === 'already_initialized') return '已完成初始化，请直接登录'
    if (error.code === 'invalid_token') {
      return phase === 'admin'
        ? 'bootstrap 令牌无效或已过期，请重新验证 SETUP_SECRET'
        : '令牌无效或已过期，请重试'
    }
  }
  return describeAuthError(error)
}
