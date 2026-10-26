import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ReactNode } from 'react'

/**
 * 亮 / 暗 / 自动三档主题（WorkerHub 通用方案要求）。
 *
 * 用 `next-themes`（shadcn 官方主题方案，不依赖 Next.js 运行时）：
 * 它负责 `class` 切换、系统偏好监听与 localStorage 记忆，页面不手写这些行为。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="waker.theme"
    >
      {children}
    </NextThemesProvider>
  )
}
