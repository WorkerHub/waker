import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProjectView } from '@/lib/api'
import { ProjectsPage } from '@/pages/projects-page'
import { authenticate, installFetchMock, renderWithProviders, requestBody } from '@/test/utils'

const existingProject: ProjectView = {
  id: 'project-1',
  name: 'shortlink',
  callbackUrl: 'https://shortlink.example.com',
  status: 'active',
  tokenFingerprint: 'f0f0f0f0f0f0f0f0',
  tokenCreatedAt: 1_730_000_000_000,
  tokenRotatedAt: null,
  signingKey: {
    id: 'key-1',
    algorithm: 'HMAC-SHA256',
    fingerprint: 'a1a1a1a1a1a1a1a1',
    createdAt: 1_730_000_000_000,
    rotatedAt: null,
  },
  createdAt: 1_730_000_000_000,
  updatedAt: 1_730_000_000_000,
}

const PLAINTEXT_TOKEN = 'wkr_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const PLAINTEXT_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
const NEW_TOKEN_FINGERPRINT = 'abc1234567890def'
const NEW_KEY_FINGERPRINT = 'bbbbccccddddeeee'

describe('项目管理页', () => {
  it('新建项目后令牌明文只展示一次：复制即隐藏，关闭后只剩指纹', async () => {
    let projects: ProjectView[] = [existingProject]

    installFetchMock((url, init) => {
      if (url === '/api/projects' && init.method === 'POST') {
        const created: ProjectView = {
          ...existingProject,
          id: 'project-2',
          name: 'post',
          callbackUrl: 'https://post.example.com',
          tokenFingerprint: NEW_TOKEN_FINGERPRINT,
          signingKey: {
            id: 'key-2',
            algorithm: 'HMAC-SHA256',
            fingerprint: 'fedcba9876543210',
            createdAt: 1_730_000_000_000,
            rotatedAt: null,
          },
        }
        projects = [existingProject, created]
        return {
          status: 201,
          body: {
            project: created,
            token: PLAINTEXT_TOKEN,
            signingKey: {
              id: 'key-2',
              algorithm: 'HMAC-SHA256',
              secret: PLAINTEXT_SECRET,
              fingerprint: 'fedcba9876543210',
              createdAt: 1_730_000_000_000,
            },
          },
        }
      }
      if (url === '/api/projects') return { body: { projects } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ProjectsPage />)
    await screen.findByText('shortlink')
    // 列表里只有指纹，没有任何明文
    expect(screen.getByText(/指纹 f0f0f0f0f0f0f0f0/)).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /新建项目/ })[0]!)
    await user.type(screen.getByLabelText('项目名'), 'post')
    await user.type(screen.getByLabelText('回调地址'), 'https://post.example.com')
    await user.click(screen.getByRole('button', { name: /创建项目/ }))

    // 一次性对话框里两把凭据都是明文
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(PLAINTEXT_TOKEN)).toBeInTheDocument()
    expect(within(dialog).getByText(PLAINTEXT_SECRET)).toBeInTheDocument()

    // 复制令牌 → 剪贴板拿到明文（user-event 的剪贴板替身），页面上的明文随即隐藏
    await user.click(within(dialog).getAllByRole('button', { name: '复制' })[0]!)
    await expect(navigator.clipboard.readText()).resolves.toBe(PLAINTEXT_TOKEN)
    await waitFor(() => {
      expect(within(dialog).queryByText(PLAINTEXT_TOKEN)).not.toBeInTheDocument()
    })

    await user.click(within(dialog).getByRole('button', { name: /我已妥善保存/ }))

    // 关闭后：明文彻底消失，只剩指纹，且没有落到任何浏览器存储
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.queryByText(PLAINTEXT_TOKEN)).not.toBeInTheDocument()
    expect(screen.queryByText(PLAINTEXT_SECRET)).not.toBeInTheDocument()
    expect(await screen.findByText(new RegExp(`指纹 ${NEW_TOKEN_FINGERPRINT}`))).toBeInTheDocument()
    expect(Object.keys(localStorage)).toHaveLength(0)
    expect(sessionStorage.getItem(PLAINTEXT_TOKEN)).toBeNull()
  })

  it('新建项目的请求体严格是 { name, callbackUrl }', async () => {
    const fetchMock = installFetchMock((url, init) => {
      if (url === '/api/projects' && init.method === 'POST') {
        return {
          status: 201,
          body: {
            project: existingProject,
            token: PLAINTEXT_TOKEN,
            signingKey: {
              id: 'key-1',
              algorithm: 'HMAC-SHA256',
              secret: PLAINTEXT_SECRET,
              fingerprint: 'a1a1a1a1a1a1a1a1',
              createdAt: 1_730_000_000_000,
            },
          },
        }
      }
      if (url === '/api/projects') return { body: { projects: [] } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ProjectsPage />)
    await user.click(screen.getAllByRole('button', { name: /新建项目/ })[0]!)
    await user.type(screen.getByLabelText('项目名'), 'post')
    await user.type(screen.getByLabelText('回调地址'), 'https://post.example.com')
    await user.click(screen.getByRole('button', { name: /创建项目/ }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
      )
      expect(requestBody(postCall)).toEqual({
        name: 'post',
        callbackUrl: 'https://post.example.com',
      })
    })
  })

  it('轮换 signing key 后只显示新指纹，明文只在对话框里出现一次', async () => {
    let projects: ProjectView[] = [existingProject]

    installFetchMock((url) => {
      if (url === '/api/projects/project-1/signing-key/rotate') {
        const rotated: ProjectView = {
          ...existingProject,
          signingKey: {
            ...existingProject.signingKey!,
            id: 'key-2',
            fingerprint: NEW_KEY_FINGERPRINT,
            rotatedAt: 1_730_000_500_000,
          },
        }
        projects = [rotated]
        return {
          body: {
            project: rotated,
            signingKey: {
              id: 'key-2',
              algorithm: 'HMAC-SHA256',
              secret: PLAINTEXT_SECRET,
              fingerprint: NEW_KEY_FINGERPRINT,
              createdAt: 1_730_000_500_000,
            },
          },
        }
      }
      if (url === '/api/projects') return { body: { projects } }
      throw new Error(`未预期的请求：${url}`)
    })
    authenticate()
    const user = userEvent.setup()

    renderWithProviders(<ProjectsPage />)
    await screen.findByText('shortlink')

    await user.click(screen.getAllByRole('button', { name: /轮换|发放/ }).at(-1)!)
    await user.click(await screen.findByRole('button', { name: '确认轮换' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(PLAINTEXT_SECRET)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '复制' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(PLAINTEXT_SECRET)
    await user.click(within(dialog).getByRole('button', { name: /我已妥善保存/ }))

    expect(
      await screen.findByText(new RegExp(`指纹 ${NEW_KEY_FINGERPRINT}`)),
    ).toBeInTheDocument()
    expect(screen.queryByText(PLAINTEXT_SECRET)).not.toBeInTheDocument()
  })
})
