import type { EmailSendConfig } from '../do/auth-types'

/**
 * 邮件发送（SPEC §6）：**移植 eNotify `worker/src/services/email.ts`** 的现行做法 ——
 * provider 二选一（smtp / resend）+ 收件地址校验 + 防 CRLF 注入，不新发明传输层。
 *
 * 与 eNotify 的两点差别：
 *   1. 配置由调用方传入（waker 的配置存在 WakerDO 的 `waker_meta`，密文信封，
 *      解密后的明文只在 DO → Worker 的内存里）。
 *   2. 发送**失败关闭**由调用方保证：失败时不出网就报错、不生成/不消费挑战（SPEC §6.2）。
 */

/** RFC 5322 简化式（与 eNotify 逐字一致）+ 显式拒绝 CR/LF 注入。 */
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export function isValidEmail(email: unknown): email is string {
  return (
    typeof email === 'string' &&
    email.length > 0 &&
    email.length <= 254 &&
    EMAIL_RE.test(email) &&
    !email.includes('\r') &&
    !email.includes('\n')
  )
}

export interface EmailMessage {
  to: string
  subject: string
  html: string
}

export interface SendResult {
  ok: boolean
  error?: string
}

/** 按配置的 provider 发送一封邮件；provider 为 none / 配置不全 → 明确失败。 */
export async function sendEmailWithConfig(
  config: EmailSendConfig,
  message: EmailMessage,
): Promise<SendResult> {
  if (!isValidEmail(message.to)) return { ok: false, error: '收件地址不合法' }

  if (config.provider === 'none') return { ok: false, error: '尚未配置邮件服务' }

  if (config.provider === 'resend') return sendViaResend(config, message)
  if (config.provider === 'smtp') return sendViaSmtp(config, message)

  return { ok: false, error: `未知的邮件通道：${String(config.provider)}` }
}

async function sendViaResend(config: EmailSendConfig, message: EmailMessage): Promise<SendResult> {
  const resend = config.resend
  if (resend === null || resend.apiKey.length === 0) {
    return { ok: false, error: 'Resend 未配置 API Key' }
  }

  const from = resend.from.length > 0 ? resend.from : 'noreply@example.com'
  const fromName = (resend.fromName.length > 0 ? resend.fromName : 'waker').replace(/[\r\n]/g, '')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [message.to],
      subject: message.subject,
      html: message.html,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    return { ok: false, error: `Resend 发送失败（${response.status}）：${text.slice(0, 200)}` }
  }
  return { ok: true }
}

async function sendViaSmtp(config: EmailSendConfig, message: EmailMessage): Promise<SendResult> {
  const smtp = config.smtp
  if (smtp === null || smtp.host.length === 0) return { ok: false, error: 'SMTP 未配置主机' }

  // 动态导入：`cloudflare:sockets` 只有 Worker 运行时能解析，放到真正要发信时再加载，
  // 免得「只做 HTTP 鉴权」的纯 Node 单测因为这条传输层依赖而 import 失败。
  const { sendSmtpMessage } = await import('./smtp-transport')
  const result = await sendSmtpMessage(
    {
      host: smtp.host,
      port: smtp.port,
      username: smtp.username,
      password: smtp.password,
      secure: smtp.secure,
    },
    {
      to: message.to,
      subject: message.subject,
      html: message.html,
      from: smtp.from.length > 0 ? smtp.from : 'noreply@example.com',
      fromName: smtp.fromName.length > 0 ? smtp.fromName : 'waker',
    },
  )

  return result.success ? { ok: true } : { ok: false, error: result.error ?? 'SMTP 发送失败' }
}

/** 2FA 邮件 OTP 正文（照 eNotify `sendOTPEmail` 的中文文案）。 */
export function otpEmailMessage(to: string, code: string): EmailMessage {
  return {
    to,
    subject: 'waker 验证码',
    html: `<p>您的验证码是：<strong>${code}</strong></p><p>有效期 5 分钟。</p>`,
  }
}

/** 「发送测试邮件」正文。 */
export function testEmailMessage(to: string): EmailMessage {
  return {
    to,
    subject: 'waker 邮件服务测试',
    html: `<p>这是一封来自 waker 的测试邮件，收到即代表邮件服务配置可用。</p><p>发送时间（北京时间）：${new Date(
      Date.now() + 8 * 60 * 60 * 1000,
    )
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19)}</p>`,
  }
}
