import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon, MailIcon, SaveIcon, SendIcon } from 'lucide-react'
import { useState } from 'react'

import { DetailRow, DetailSection } from '@/components/detail-rows'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  describeAuthError,
  getSystemSettings,
  sendTestEmail,
  updateEmailSettings,
  type EmailProvider,
  type SystemSettingsView,
  type UpdateEmailSettingsInput,
} from '@/lib/auth-api'

const PROVIDER_LABEL: Record<EmailProvider, string> = {
  none: '不启用（none）',
  smtp: 'SMTP',
  resend: 'Resend',
}

/**
 * 系统管理 → 邮件服务配置（SPEC §6.1，仅 admin）。
 *
 * 这是邮件验证码登录的前置子系统，**上线后由管理员在页面里运行时填**（配置不进 CI、不进 secret）。
 *
 * 脱敏规则（与后端视图一致，前端不额外保存任何明文）：
 *   - SMTP 密码 / Resend API Key 只显示「已配置 / 未配置」，永不回显；
 *   - 输入框留空 = 不修改（提交时省略该字段），只有真填了才会覆盖；
 *   - 保存成功后本地明文立刻清空，页面重新以脱敏视图为准。
 */
export function EmailSettingsCard() {
  const settingsQuery = useQuery({
    queryKey: ['system-settings'],
    queryFn: getSystemSettings,
    retry: false,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailIcon className="size-4" />
          邮件服务
          <Badge variant="outline">
            {settingsQuery.data === undefined
              ? '读取中'
              : PROVIDER_LABEL[settingsQuery.data.email.provider]}
          </Badge>
        </CardTitle>
        <CardDescription>
          邮件验证码登录与「发送测试邮件」都走这里配置的通道；未配置时邮件验证码不可用（失败关闭）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settingsQuery.isPending ? (
          <Skeleton className="h-56 w-full rounded-lg" />
        ) : settingsQuery.data === undefined ? (
          <Alert variant="destructive">
            <MailIcon />
            <AlertTitle>邮件配置加载失败</AlertTitle>
            <AlertDescription>请稍后刷新；没有配置时邮件验证码登录不可用。</AlertDescription>
          </Alert>
        ) : (
          // key 用服务端视图：保存成功后表单重新以脱敏结果为准（明文不留在组件状态里）。
          <EmailSettingsForm
            key={JSON.stringify(settingsQuery.data)}
            settings={settingsQuery.data}
          />
        )}
      </CardContent>
    </Card>
  )
}

function EmailSettingsForm({ settings }: { settings: SystemSettingsView }) {
  const queryClient = useQueryClient()

  const [provider, setProvider] = useState<EmailProvider>(settings.email.provider)
  const [host, setHost] = useState(settings.email.smtp.host)
  const [port, setPort] = useState(String(settings.email.smtp.port))
  const [username, setUsername] = useState(settings.email.smtp.username)
  const [smtpPassword, setSmtpPassword] = useState('')
  const [from, setFrom] = useState(settings.email.smtp.from)
  const [fromName, setFromName] = useState(settings.email.smtp.fromName)
  const [secure, setSecure] = useState(settings.email.smtp.secure)

  const [resendApiKey, setResendApiKey] = useState('')
  const [resendFrom, setResendFrom] = useState(settings.email.resend.from)
  const [resendFromName, setResendFromName] = useState(settings.email.resend.fromName)

  const [testTo, setTestTo] = useState('')
  const [pending, setPending] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending('save')
    setError(null)
    setNotice(null)
    try {
      const payload: UpdateEmailSettingsInput = { provider }
      if (provider === 'smtp') {
        payload.smtp = {
          // 留空 = 不改：空串不进请求体。
          host: host.trim() === '' ? undefined : host.trim(),
          port: port.trim() === '' ? undefined : Number(port),
          username: username.trim() === '' ? undefined : username.trim(),
          password: smtpPassword === '' ? undefined : smtpPassword,
          from: from.trim() === '' ? undefined : from.trim(),
          fromName: fromName.trim() === '' ? undefined : fromName.trim(),
          secure,
        }
      }
      if (provider === 'resend') {
        payload.resend = {
          apiKey: resendApiKey === '' ? undefined : resendApiKey,
          from: resendFrom.trim() === '' ? undefined : resendFrom.trim(),
          fromName: resendFromName.trim() === '' ? undefined : resendFromName.trim(),
        }
      }
      await updateEmailSettings(payload)
      setSmtpPassword('')
      setResendApiKey('')
      setNotice('邮件服务配置已保存。')
      await queryClient.invalidateQueries({ queryKey: ['system-settings'] })
      await queryClient.invalidateQueries({ queryKey: ['setup-state'] })
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(null)
    }
  }

  async function test() {
    setPending('test')
    setError(null)
    setNotice(null)
    try {
      await sendTestEmail(testTo.trim())
      setNotice(testTo.trim() === '' ? '测试邮件已发送到你的管理员邮箱。' : `测试邮件已发送到 ${testTo.trim()}。`)
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <DetailSection title="当前状态（脱敏）">
        <DetailRow label="通道" value={PROVIDER_LABEL[settings.email.provider]} />
        <DetailRow
          label="SMTP 密码"
          value={<ConfiguredBadge configured={settings.email.smtp.passwordConfigured} />}
        />
        <DetailRow
          label="Resend API Key"
          value={<ConfiguredBadge configured={settings.email.resend.apiKeyConfigured} />}
        />
      </DetailSection>

      <form key="email-settings-form" onSubmit={save} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email-provider">邮件通道</FieldLabel>
            <NativeSelect
              id="email-provider"
              value={provider}
              disabled={pending !== null}
              onChange={(event) => setProvider(event.target.value as EmailProvider)}
            >
              <NativeSelectOption value="none">不启用（none）</NativeSelectOption>
              <NativeSelectOption value="smtp">SMTP</NativeSelectOption>
              <NativeSelectOption value="resend">Resend</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              选 none 时邮件验证码登录被挡住（后端失败关闭，不会假装发送成功）。
            </FieldDescription>
          </Field>
        </FieldGroup>

        {provider === 'smtp' && (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="smtp-host">SMTP 主机</FieldLabel>
              <Input
                id="smtp-host"
                name="host"
                type="text"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                placeholder="smtp.example.com"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-port">端口</FieldLabel>
              <Input
                id="smtp-port"
                name="port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                disabled={pending !== null}
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
              <FieldDescription>587 = STARTTLS；465 = 隐式 TLS（配下面的「隐式 TLS」开关）。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-username">用户名</FieldLabel>
              <Input
                id="smtp-username"
                name="username"
                type="text"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-password">密码</FieldLabel>
              <Input
                id="smtp-password"
                name="smtpPassword"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                placeholder={
                  settings.email.smtp.passwordConfigured ? '已配置，留空表示不修改' : '未配置'
                }
                value={smtpPassword}
                onChange={(event) => setSmtpPassword(event.target.value)}
              />
              <FieldDescription>密码以密文信封落库，接口只回「是否已配置」，永不回显。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-from">发件地址</FieldLabel>
              <Input
                id="smtp-from"
                name="from"
                type="email"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                placeholder="noreply@example.com"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-from-name">发件人名称</FieldLabel>
              <Input
                id="smtp-from-name"
                name="fromName"
                type="text"
                autoComplete="off"
                disabled={pending !== null}
                placeholder="waker"
                value={fromName}
                onChange={(event) => setFromName(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="smtp-secure"
                checked={secure}
                disabled={pending !== null}
                onCheckedChange={setSecure}
              />
              <FieldLabel htmlFor="smtp-secure">隐式 TLS（465）</FieldLabel>
            </Field>
          </FieldGroup>
        )}

        {provider === 'resend' && (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="resend-api-key">API Key</FieldLabel>
              <Input
                id="resend-api-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                placeholder={
                  settings.email.resend.apiKeyConfigured ? '已配置，留空表示不修改' : '未配置'
                }
                value={resendApiKey}
                onChange={(event) => setResendApiKey(event.target.value)}
              />
              <FieldDescription>API Key 以密文信封落库，接口只回「是否已配置」。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="resend-from">发件地址</FieldLabel>
              <Input
                id="resend-from"
                name="from"
                type="email"
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                placeholder="noreply@example.com"
                value={resendFrom}
                onChange={(event) => setResendFrom(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="resend-from-name">发件人名称</FieldLabel>
              <Input
                id="resend-from-name"
                name="fromName"
                type="text"
                autoComplete="off"
                disabled={pending !== null}
                placeholder="waker"
                value={resendFromName}
                onChange={(event) => setResendFromName(event.target.value)}
              />
            </Field>
          </FieldGroup>
        )}

        {provider === 'none' && (
          <p className="text-xs text-muted-foreground">
            当前不启用邮件通道。切到 SMTP / Resend 并填好必填项后再保存。
          </p>
        )}

        {error !== null && (
          <Alert variant="destructive">
            <MailIcon />
            <AlertTitle>操作没有完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice !== null && <p className="text-xs text-muted-foreground">{notice}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={pending !== null}>
            {pending === 'save' ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            保存配置
          </Button>
          <Input
            aria-label="测试邮件收件地址"
            name="testTo"
            type="email"
            autoComplete="off"
            className="max-w-56"
            disabled={pending !== null}
            placeholder="留空发给自己"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending !== null || settings.email.provider === 'none'}
            onClick={() => void test()}
          >
            {pending === 'test' ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
            发送测试邮件
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          测试邮件用**已保存**的配置发送：先保存再测；失败会明确报错，不会假装已发送。
        </p>
      </form>
    </div>
  )
}

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return (
    <Badge variant={configured ? 'default' : 'outline'}>
      {configured ? '已配置（不回显）' : '未配置'}
    </Badge>
  )
}
