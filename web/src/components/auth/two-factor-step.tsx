import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { KeyRoundIcon, Loader2Icon, MailIcon, SmartphoneIcon } from 'lucide-react'
import { useState } from 'react'

import { OtpField } from '@/components/auth/otp-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  describeAuthError,
  passkeyLoginOptions,
  passkeyLoginVerify,
  sendLoginEmailOtp,
  verifyTwoFactorCode,
  type TwoFactorMethod,
} from '@/lib/auth-api'
import { cn } from '@/lib/utils'
import { useSession, type LoginChallenge } from '@/stores/session'

const METHOD_META: Record<
  TwoFactorMethod,
  { label: string; icon: typeof KeyRoundIcon; hint: string }
> = {
  totp: {
    label: '身份验证器',
    icon: SmartphoneIcon,
    hint: '打开身份验证器 App，输入当前 6 位验证码。',
  },
  email_otp: {
    label: '邮件验证码',
    icon: MailIcon,
    hint: '把 6 位验证码发到本人邮箱，5 分钟内有效。',
  },
  passkey: {
    label: 'Passkey',
    icon: KeyRoundIcon,
    hint: '用设备上的指纹 / 面容 / 安全密钥在本机完成验证。',
  },
}

/**
 * 两步登录的第二因素（SPEC §5.1 / §5B）。
 *
 * 为什么单独成一个组件：第一步（密码）与第二步必须是**不同的 DOM 节点**。
 * 页面在两者之间整块换掉 `form`（`key` 不同），密码框随之从文档里消失 ——
 * 密码管理器的「当前密码」框不会在第二步被复用成验证码框，也就不会串位。
 *
 * `challenge.methods` 已由后端按 `preferred_method` 排好序，这里**不重排**，
 * 只把第一项作为默认方法（第一个 tab 带「推荐」标）。
 */
export function TwoFactorStep({
  challenge,
  onCancel,
}: {
  challenge: LoginChallenge
  onCancel: () => void
}) {
  const adopt = useSession((state) => state.adopt)
  const [method, setMethod] = useState<TwoFactorMethod>(challenge.methods[0] ?? 'totp')
  const [code, setCode] = useState('')
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const meta = METHOD_META[method]
  const preferred = challenge.methods[0]

  function switchMethod(next: TwoFactorMethod) {
    setMethod(next)
    setCode('')
    setSentAt(null)
    setError(null)
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (method === 'passkey') return
    setPending(true)
    setError(null)
    try {
      const result = await verifyTwoFactorCode({
        tempToken: challenge.tempToken,
        method,
        code,
      })
      adopt(result)
    } catch (caught) {
      setError(describeAuthError(caught))
      setCode('')
    } finally {
      setPending(false)
    }
  }

  async function sendEmailCode() {
    setPending(true)
    setError(null)
    try {
      const result = await sendLoginEmailOtp(challenge.tempToken)
      setSentAt(result.expiresAt)
    } catch (caught) {
      // provider 未配置 / 发送失败都走这里：后端失败关闭，不会生成可用挑战，
      // 页面如实报错，不假装「已发送」。
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  async function loginWithPasskey() {
    setPending(true)
    setError(null)
    try {
      const options = await passkeyLoginOptions(challenge.tempToken)
      // WebAuthn 交互全交给 `@simplewebauthn/browser` 原生实现（不手搓 navigator.credentials 流程）。
      const response = await startAuthentication({
        optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
      })
      const result = await passkeyLoginVerify({ tempToken: challenge.tempToken, response })
      adopt(result)
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          密码已通过。{challenge.user.email} 开启了第二因素，请再验证一次。
        </p>
      </div>

      {challenge.methods.length > 1 && (
        <div
          className="flex flex-wrap gap-1 rounded-lg bg-muted p-1"
          role="group"
          aria-label="第二因素方式"
        >
          {challenge.methods.map((candidate) => {
            const candidateMeta = METHOD_META[candidate]
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === method}
                onClick={() => switchMethod(candidate)}
                className={cn(
                  'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                  candidate === method
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <candidateMeta.icon className="size-3.5" />
                {candidateMeta.label}
                {candidate === preferred && (
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    推荐
                  </Badge>
                )}
              </button>
            )
          })}
        </div>
      )}

      {error !== null && (
        <Alert variant="destructive">
          <KeyRoundIcon />
          <AlertTitle>验证没有通过</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {method === 'passkey' ? (
        // 换方法换节点：Passkey 走独立按钮，不残留验证码输入框。
        <div key="two-factor-passkey" className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{meta.hint}</p>
          <Button type="button" onClick={() => void loginWithPasskey()} disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            {pending ? '正在等待设备确认…' : '使用 Passkey 登录'}
          </Button>
        </div>
      ) : method === 'email_otp' ? (
        <div key="two-factor-email-otp" className="flex flex-col gap-3">
          {sentAt === null ? (
            <>
              <p className="text-xs text-muted-foreground">{meta.hint}</p>
              <Button type="button" variant="outline" onClick={() => void sendEmailCode()} disabled={pending}>
                {pending ? <Loader2Icon className="animate-spin" /> : <MailIcon />}
                {pending ? '正在发送…' : '发送验证码'}
              </Button>
            </>
          ) : (
            <form
              key="two-factor-email-otp-form"
              onSubmit={submitCode}
              className="flex flex-col gap-3"
            >
              <OtpField
                key="email-otp-code"
                id="email-otp-code"
                label="邮件验证码"
                description="已发送到本人邮箱，5 分钟内有效。"
                value={code}
                onChange={setCode}
                disabled={pending}
                autoFocus
                invalid={error !== null}
              />
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={pending || code.length !== 6}>
                  {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                  {pending ? '正在验证…' : '验证并登录'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void sendEmailCode()}
                  disabled={pending}
                >
                  重新发送
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <form key="two-factor-totp-form" onSubmit={submitCode} className="flex flex-col gap-3">
          <OtpField
            key="totp-code"
            id="totp-code"
            label="身份验证器验证码"
            description={meta.hint}
            value={code}
            onChange={setCode}
            disabled={pending}
            autoFocus
            invalid={error !== null}
          />
          <Button type="submit" disabled={pending || code.length !== 6}>
            {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            {pending ? '正在验证…' : '验证并登录'}
          </Button>
        </form>
      )}

      <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
        返回密码登录
      </Button>
    </div>
  )
}
