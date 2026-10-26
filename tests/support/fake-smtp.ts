import { createServer, type Server, type Socket } from 'node:net'

/**
 * 测试用的最小 SMTP 服务器（真 TCP，`cloudflare:sockets` 能直接连）。
 *
 * 只实现平台发送路径会用到的那几步：EHLO / STARTTLS（明确拒绝）/ MAIL FROM / RCPT TO /
 * DATA / QUIT。**不用 TLS、不校验口令**，所以测试里的 SMTP 配置不填 username/password
 * （移植自 eNotify 的传输层在「服务器不支持 STARTTLS 且没有凭据」时按明文继续）。
 */

export interface FakeSmtpMessage {
  from: string
  to: string
  subject: string
  html: string
  raw: string
}

export interface FakeSmtp {
  host: string
  port: number
  messages: FakeSmtpMessage[]
  close(): Promise<void>
}

function decodeHeaderValue(value: string): string {
  // `=?UTF-8?B?<base64>?=`（smtp-transport 只发这一种编码）
  const match = /=\?UTF-8\?B\?([^?]*)\?=/i.exec(value)
  if (match === null) return value
  try {
    return Buffer.from(match[1]!, 'base64').toString('utf8')
  } catch {
    return value
  }
}

function parseMessage(raw: string): FakeSmtpMessage {
  const separator = raw.indexOf('\r\n\r\n')
  const headers = separator === -1 ? raw : raw.slice(0, separator)
  const body = separator === -1 ? '' : raw.slice(separator + 4)

  const header = (name: string): string => {
    const line = headers
      .split('\r\n')
      .find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    return line === undefined ? '' : line.slice(line.indexOf(':') + 1).trim()
  }

  const fromMatch = /<([^>]*)>/.exec(header('From'))
  const toHeader = header('To')
  const toMatch = /<([^>]*)>/.exec(toHeader)
  let html: string
  try {
    html = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
  } catch {
    html = ''
  }

  return {
    from: fromMatch?.[1] ?? '',
    to: toMatch?.[1] ?? toHeader,
    subject: decodeHeaderValue(header('Subject')),
    html,
    raw,
  }
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtpMessage[] = []

  const server: Server = createServer((socket: Socket) => {
    let buffer = ''
    let inData = false
    let dataBuffer = ''

    const send = (line: string): void => {
      socket.write(`${line}\r\n`)
    }

    send('220 waker-fake ESMTP')

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')

      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) return
          dataBuffer += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          messages.push(parseMessage(dataBuffer))
          dataBuffer = ''
          send('250 OK queued')
          continue
        }

        const eol = buffer.indexOf('\r\n')
        if (eol === -1) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)

        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          // 多行应答：最后一行用空格（RFC 5321）
          socket.write('250-waker-fake\r\n250-8BITMIME\r\n250 HELP\r\n')
        } else if (upper.startsWith('STARTTLS')) {
          send('500 STARTTLS not supported here')
        } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          send('250 OK')
        } else if (upper === 'DATA') {
          inData = true
          dataBuffer = ''
          send('354 End data with <CR><LF>.<CR><LF>')
        } else if (upper === 'QUIT') {
          send('221 Bye')
          socket.end()
          return
        } else if (upper === 'RSET' || upper === 'NOOP') {
          send('250 OK')
        } else {
          send('502 Command not implemented')
        }
      }
    })

    socket.on('error', () => {
      /* 客户端提前断开：测试里不算失败 */
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('假 SMTP 服务器启动失败')

  return {
    host: '127.0.0.1',
    port: address.port,
    messages,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
      })
    },
  }
}
