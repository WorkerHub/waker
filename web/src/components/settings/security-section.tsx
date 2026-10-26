import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import QRCode from 'qrcode'
import {
  FingerprintIcon,
  Loader2Icon,
  MailIcon,
  PlusIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { OtpField } from '@/components/auth/otp-field'
import { PasswordConfirmDialog } from '@/components/settings/password-confirm-dialog'
import { roleLabel } from '@/components/settings/profile-section'
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  confirmTotpSetup,
  deletePasskey,
  describeAuthError,
  disableEmailOtp,
  disableTotp,
  enableEmailOtp,
  getSetupState,
  listPasskeys,
  passkeyRegisterOptions,
  registerPasskey,
  renamePasskey,
  sendEmailOtpSetupCode,
  setPreferredMethod,
  startTotpSetup,
  type MeView,
  type TwoFactorMethod,
} from '@/lib/auth-api'
import { formatDateTime } from '@/lib/format'
import { useMe } from '@/hooks/use-me'

const METHOD_LABEL: Record<TwoFactorMethod, string> = {
  totp: '身份验证器（TOTP）',
  email_otp: '邮件验证码',
  passkey: 'Passkey',
}

/**
 * 「设置 → 安全」区（SPEC §5.3）。
 *
 * 独立分区，**不塞系统管理**：viewer 也能管理自己的第二因素（权限矩阵里唯一的写白名单），
 * 系统管理里的用户管理 / 注册开关 / 邮件配置才是 admin 专属。
 *
 * 三条硬规则：
 *   1. 邮件 OTP 启用前必须发码验码；provider 未配置时页面明确提示「管理员尚未配置邮件服务，
 *      此方法暂不可用」并禁用入口，**不静默置位**（与 eNotify 存量行为的有意分叉）；
 *   2. 解绑 TOTP / 关闭邮件 OTP / 删 Passkey 都是敏感变更 → 弹密码复验（后端强制）；
 *   3. 首选方法只能在**已启用**的方法里选；改动以 `/api/me` 的返回为准。
 */
export function SecuritySection() {
  const meQuery = useMe()
  const setupStateQuery = useQuery({
    queryKey: ['setup-state'],
    queryFn: getSetupState,
    staleTime: 60_000,
  })

  const me = meQuery.data
  const providerConfigured =
    setupStateQuery.data !== undefined && setupStateQuery.data.emailProvider !== 'none'

  return (
    <div className="flex flex-col gap-3">
      <PreferredMethodCard me={me} />
      <div className="grid gap-3 lg:grid-cols-2">
        <TotpCard me={me} />
        <EmailOtpCard me={me} providerConfigured={providerConfigured} />
        <PasskeyCard />
      </div>
    </div>
  )
}

/** 首选方法：登录第二步默认排在第一位（后端 `#availableMethods` 已按 preferred 排序）。 */
function PreferredMethodCard({ me }: { me: MeView | undefined }) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const methods = me?.availableMethods ?? []
  const preferred = me?.twoFactor.preferredMethod ?? ''

  async function change(method: string) {
    if (method === '') return
    setPending(true)
    setError(null)
    try {
      await setPreferredMethod(method as TwoFactorMethod)
      await queryClient.invalidateQueries({ queryKey: ['me'] })
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
          <StarIcon className="size-4" />
          首选第二因素
          {me !== undefined && (
            <Badge variant="secondary">{roleLabel(me.user.role)}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          两步登录时优先呈现的方法；没设偏好就按「身份验证器 → Passkey → 邮件验证码」的默认顺序。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <DetailSection title="已启用方法">
          <DetailRow
            label="身份验证器"
            value={<EnabledBadge enabled={me?.twoFactor.totpEnabled === true} />}
          />
          <DetailRow
            label="邮件验证码"
            value={<EnabledBadge enabled={me?.twoFactor.emailOtpEnabled === true} />}
          />
          <DetailRow
            label="Passkey"
            value={<EnabledBadge enabled={me?.twoFactor.passkeyEnabled === true} />}
          />
          <DetailRow
            label="偏好"
            value={
              preferred === '' ? '未设置（按默认顺序）' : METHOD_LABEL[preferred as TwoFactorMethod]
            }
          />
        </DetailSection>

        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label="首选第二因素"
            value={preferred}
            disabled={pending || methods.length === 0}
            onChange={(event) => void change(event.target.value)}
          >
            <NativeSelectOption value="">未设置（按默认顺序）</NativeSelectOption>
            {methods.map((method) => (
              <NativeSelectOption key={method} value={method}>
                {METHOD_LABEL[method]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <span className="text-xs text-muted-foreground">
            {methods.length === 0 ? '先启用至少一种方法' : '只能选已启用的方法'}
          </span>
        </div>

        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

/** TOTP：setup（otpauth URI + 二维码）→ 输码确认才置 enabled；解绑清 secret 并复验密码。 */
function TotpCard({ me }: { me: MeView | undefined }) {
  const queryClient = useQueryClient()
  const [setupData, setSetupData] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const enabled = me?.twoFactor.totpEnabled === true

  async function beginSetup() {
    setPending(true)
    setError(null)
    try {
      setSetupData(await startTotpSetup())
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await confirmTotpSetup(code)
      setSetupData(null)
      setCode('')
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (caught) {
      setError(describeAuthError(caught))
      setCode('')
    } finally {
      setPending(false)
    }
  }

  async function disable(password: string) {
    setPending(true)
    setError(null)
    try {
      await disableTotp(password)
      setConfirmOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['me'] })
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
          <SmartphoneIcon className="size-4" />
          身份验证器（TOTP）
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? '已启用' : '未启用'}</Badge>
        </CardTitle>
        <CardDescription>6 位、30 秒刷新、±1 个窗口；同一验证码用过即失效（防重放）。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && !confirmOpen && (
          <Alert variant="destructive">
            <SmartphoneIcon />
            <AlertTitle>操作没有完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              已绑定身份验证器。解绑会清掉服务端保存的 secret，之后登录只用其它已启用方法。
            </p>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
              <Trash2Icon />
              解绑身份验证器
            </Button>
          </div>
        ) : setupData === null ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              绑定后用验证器 App 生成验证码，多一层保护；解绑需要复验密码。
            </p>
            <Button size="sm" onClick={() => void beginSetup()} disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
              绑定身份验证器
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-4">
              <TotpQrCode uri={setupData.uri} />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  用验证器 App 扫二维码，或手动输入密钥：
                </span>
                <code className="rounded-md border bg-muted px-2 py-1 font-mono text-xs break-all">
                  {setupData.secret}
                </code>
                <span className="text-xs text-muted-foreground">otpauth URI：</span>
                <code className="rounded-md border bg-muted px-2 py-1 font-mono text-[11px] break-all">
                  {setupData.uri}
                </code>
              </div>
            </div>

            <form key="totp-confirm-form" onSubmit={confirm} className="flex flex-col gap-3">
              <OtpField
                id="totp-setup-code"
                label="验证器上的 6 位验证码"
                description="输入一次正确验证码才会真正启用（服务端同时把 secret 落库）。"
                value={code}
                onChange={setCode}
                disabled={pending}
                autoFocus
                invalid={error !== null}
              />
              <Button type="submit" size="sm" disabled={pending || code.length !== 6}>
                {pending ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                确认启用
              </Button>
            </form>
          </div>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        secret 以密文信封存 WakerDO（复用 keyring 的 KEK 派生），不明文落库。
      </CardFooter>

      <PasswordConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="解绑身份验证器"
        description="解绑是敏感变更，需要验证当前密码。解绑后这个方法不会再出现在登录第二步。"
        confirmLabel="确认解绑"
        pending={pending}
        error={error}
        onConfirm={(password) => void disable(password)}
      />
    </Card>
  )
}

/** 邮件 OTP：provider 未配置时明确挡住（不静默置位），启用必须先发码验码。 */
function EmailOtpCard({
  me,
  providerConfigured,
}: {
  me: MeView | undefined
  providerConfigured: boolean
}) {
  const queryClient = useQueryClient()
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const enabled = me?.twoFactor.emailOtpEnabled === true

  async function send() {
    setPending(true)
    setError(null)
    try {
      await sendEmailOtpSetupCode()
      setSent(true)
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  async function enable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await enableEmailOtp(code)
      setSent(false)
      setCode('')
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (caught) {
      setError(describeAuthError(caught))
      setCode('')
    } finally {
      setPending(false)
    }
  }

  async function disable(password: string) {
    setPending(true)
    setError(null)
    try {
      await disableEmailOtp(password)
      setConfirmOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['me'] })
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
          <MailIcon className="size-4" />
          邮件验证码
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? '已启用' : '未启用'}</Badge>
        </CardTitle>
        <CardDescription>登录第二步的验证码发到本人邮箱，5 分钟有效、验后即失效。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!providerConfigured && (
          <Alert>
            <MailIcon />
            <AlertTitle>管理员尚未配置邮件服务，此方法暂不可用</AlertTitle>
            <AlertDescription>
              邮件服务（SMTP / Resend）由管理员在「系统管理 → 邮件服务」配置。未配置时启用会造出一个永远收不到码的方法，
              所以这里直接挡住。
            </AlertDescription>
          </Alert>
        )}

        {error !== null && !confirmOpen && (
          <Alert variant="destructive">
            <MailIcon />
            <AlertTitle>操作没有完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">已启用邮件验证码登录。</p>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
              <Trash2Icon />
              关闭邮件验证码
            </Button>
          </div>
        ) : !sent ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              启用前会先发一枚验证码到本人邮箱，验码通过才置为启用。
            </p>
            <Button size="sm" onClick={() => void send()} disabled={pending || !providerConfigured}>
              {pending ? <Loader2Icon className="animate-spin" /> : <MailIcon />}
              发送验证码
            </Button>
          </div>
        ) : (
          <form key="email-otp-setup-form" onSubmit={enable} className="flex flex-col gap-3">
            <OtpField
              id="email-otp-setup-code"
              label="邮件验证码"
              description="已发送到本人邮箱，5 分钟内有效。"
              value={code}
              onChange={setCode}
              disabled={pending}
              autoFocus
              invalid={error !== null}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending || code.length !== 6}>
                {pending ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                确认启用
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void send()} disabled={pending}>
                重新发送
              </Button>
            </div>
          </form>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        验证码只存哈希，5 分钟后过期；发送失败不会留下可用验证码（失败关闭）。
      </CardFooter>

      <PasswordConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="关闭邮件验证码"
        description="关闭是敏感变更，需要验证当前密码。"
        confirmLabel="确认关闭"
        pending={pending}
        error={error}
        onConfirm={(password) => void disable(password)}
      />
    </Card>
  )
}

/** Passkey：增 / 列 / 改名 / 删（删光后后端自动清 enabled），删除需复验密码。 */
function PasskeyCard() {
  const queryClient = useQueryClient()
  const passkeysQuery = useQuery({ queryKey: ['passkeys'], queryFn: listPasskeys, retry: false })
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const passkeys = passkeysQuery.data ?? []

  async function addPasskey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const options = await passkeyRegisterOptions()
      // WebAuthn 注册交互全部交给 `@simplewebauthn/browser`（不手搓 navigator.credentials 流程）。
      const response = await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      })
      await registerPasskey({ response, name: name.trim() === '' ? '我的 Passkey' : name.trim() })
      setName('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['passkeys'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ])
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  async function rename() {
    if (renaming === null) return
    setPending(true)
    setError(null)
    try {
      await renamePasskey(renaming.id, renaming.name.trim())
      setRenaming(null)
      await queryClient.invalidateQueries({ queryKey: ['passkeys'] })
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(false)
    }
  }

  async function remove(password: string) {
    if (deleting === null) return
    setPending(true)
    setError(null)
    try {
      await deletePasskey(deleting, password)
      setDeleting(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['passkeys'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ])
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
          <FingerprintIcon className="size-4" />
          Passkey
          <Badge variant={passkeys.length > 0 ? 'default' : 'outline'}>
            {passkeys.length > 0 ? `${passkeys.length} 个` : '未启用'}
          </Badge>
        </CardTitle>
        <CardDescription>
          用设备指纹 / 面容 / 安全密钥登录；全部删除后自动关闭这个方法。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && deleting === null && renaming === null && (
          <Alert variant="destructive">
            <FingerprintIcon />
            <AlertTitle>操作没有完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {passkeysQuery.isPending ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有注册 Passkey。</p>
        ) : (
          <DetailSection title="已注册">
            {passkeys.map((passkey) => (
              <div
                key={passkey.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{passkey.name}</span>
                  <span className="text-xs text-muted-foreground">
                    添加于 {formatDateTime(passkey.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}
                  >
                    改名
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(passkey.id)}>
                    <Trash2Icon />
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </DetailSection>
        )}

        <form key="passkey-add-form" onSubmit={addPasskey} className="flex flex-col gap-3">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="passkey-name">新 Passkey 名称</FieldLabel>
              <Input
                id="passkey-name"
                name="passkeyName"
                type="text"
                autoComplete="off"
                disabled={pending}
                placeholder="例如：MacBook 指纹"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription>
                点「添加」后浏览器会弹出系统认证器对话框，用本机生物识别或安全密钥完成注册。
              </FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
            添加 Passkey
          </Button>
        </form>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        公钥与计数器存 WakerDO，接口只回 id / 名称 / 创建时间（凭证材料不外泄）。
      </CardFooter>

      <PasswordConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title="删除 Passkey"
        description="删除是敏感变更，需要验证当前密码。删光全部 Passkey 会自动关闭这个方法。"
        confirmLabel="确认删除"
        pending={pending}
        error={error}
        onConfirm={(password) => void remove(password)}
      />

      {/* 改名不是敏感变更：普通对话框，不索取密码。 */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>给 Passkey 改名</DialogTitle>
            <DialogDescription>名称只用于你自己区分设备，不影响凭证本身。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="passkey-rename">新名称</FieldLabel>
              <Input
                id="passkey-rename"
                name="passkeyName"
                type="text"
                autoComplete="off"
                autoFocus
                disabled={pending}
                value={renaming?.name ?? ''}
                onChange={(event) => {
                  if (renaming === null) return
                  setRenaming({ id: renaming.id, name: event.target.value })
                }}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              disabled={pending || renaming === null || renaming.name.trim() === ''}
              onClick={() => void rename()}
            >
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              保存名称
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** otpauth URI → 二维码（`qrcode` 原生 SVG 输出，不手搓编码）。 */
function TotpQrCode({ uri }: { uri: string }) {
  // 结果带上 uri：换一次绑定就是一次新的渲染，不需要在 effect 里同步重置状态。
  const [rendered, setRendered] = useState<{ uri: string; svg: string } | null>(null)
  const [failedUri, setFailedUri] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toString(uri, { type: 'svg', margin: 1, width: 176 })
      .then((value) => {
        if (!cancelled) setRendered({ uri, svg: value })
      })
      .catch(() => {
        if (!cancelled) setFailedUri(uri)
      })
    return () => {
      cancelled = true
    }
  }, [uri])

  if (failedUri === uri) {
    return (
      <p className="text-xs text-muted-foreground">
        二维码生成失败，请手动把下方密钥填进验证器 App。
      </p>
    )
  }

  const svg = rendered !== null && rendered.uri === uri ? rendered.svg : null
  if (svg === null) return <Skeleton className="size-44 rounded-lg" />

  return (
    <div
      role="img"
      aria-label="TOTP 二维码"
      className="size-44 shrink-0 rounded-lg border bg-white p-1 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? '已启用' : '未启用'}</Badge>
}
