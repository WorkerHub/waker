import { KeyRoundIcon, Loader2Icon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { VersionFooter } from '@/components/version-footer'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useSession } from '@/stores/session'

/**
 * 登录 / 首次安装页。
 *
 * 单人所有者模型：不开放注册，只有「用部署期配置的 `SETUP_SECRET` 换 12 小时会话」这一条入口。
 * 表单按舰队《通用技术方案》§5B 的自动填充要求写：真 `<form>` + 语义 `name` +
 * `autoComplete="current-password"`，密码管理器能正确识别并填充。
 */
export function LoginPage() {
  const session = useSession((state) => state.session)
  const login = useSession((state) => state.login)
  const pending = useSession((state) => state.pending)
  const error = useSession((state) => state.error)
  const clearError = useSession((state) => state.clearError)
  const navigate = useNavigate()
  const [secret, setSecret] = useState('')

  if (session !== null) return <Navigate to="/jobs" replace />

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const ok = await login(secret)
    if (ok) {
      setSecret('')
      navigate('/jobs', { replace: true })
    }
  }

  return (
    <div className="flex min-h-svh flex-col">
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ZapIcon className="size-4.5" />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight">waker</span>
              <span className="text-xs text-muted-foreground">统一调度平台 · 管理面</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="setup-secret">SETUP_SECRET</FieldLabel>
                <Input
                  id="setup-secret"
                  name="setupSecret"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  required
                  placeholder="部署时配置的 SETUP_SECRET"
                  value={secret}
                  onChange={(event) => {
                    setSecret(event.target.value)
                    if (error !== null) clearError()
                  }}
                />
                <FieldDescription>
                  单人自托管：不支持注册，会话有效期 12 小时；过期后回到本页重新换会话。
                </FieldDescription>
              </Field>
            </FieldGroup>

            {error !== null && (
              <Alert variant="destructive">
                <KeyRoundIcon />
                <AlertTitle>无法建立会话</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={pending || secret.trim() === ''}>
              {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
              {pending ? '正在验证…' : '进入管理面'}
            </Button>
          </form>

          <p className="text-xs leading-relaxed text-muted-foreground">
            SETUP_SECRET 由部署关口写入 GitHub Secrets，平台侧只做常量时间比较；
            管理面所有请求随后都带会话 JWT（`Authorization: Bearer`）。
          </p>
        </div>
      </main>
      <VersionFooter />
    </div>
  )
}
