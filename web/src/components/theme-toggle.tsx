import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const THEMES = [
  { value: 'light', label: '亮色', icon: SunIcon },
  { value: 'dark', label: '暗色', icon: MoonIcon },
  { value: 'system', label: '跟随系统', icon: MonitorIcon },
] as const

/** 主题三档切换（亮 / 暗 / 自动），选择结果由 next-themes 持久化。 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const current = THEMES.find((item) => item.value === theme) ?? THEMES[2]
  const Icon = current.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`主题：${current.label}`}
          title={`主题：${current.label}`}
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          {THEMES.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} className="gap-2">
              <item.icon className="size-4" />
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
