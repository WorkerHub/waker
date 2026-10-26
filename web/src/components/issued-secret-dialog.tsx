import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, ShieldAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface IssuedSecret {
  label: string
  /** 明文，只在本次响应里出现；组件卸载后不复存在。 */
  value: string
  hint?: string
}

/**
 * 凭据「只展示一次」对话框（项目令牌 / signing key 共用）。
 *
 * 规格要求（F1）：明文只展示一次、复制即隐藏，之后页面只显示指纹/掩码 + 轮换入口。
 * 因此这里刻意做成「必须确认关闭」——不允许点遮罩或按 ESC 误关，
 * 也不写 localStorage / sessionStorage / 任何日志：关闭即从内存丢弃。
 */
export function IssuedSecretDialog({
  title,
  description,
  secrets,
  onClose,
  confirmLabel = '我已妥善保存，关闭',
}: {
  title: string
  description?: string
  secrets: IssuedSecret[]
  onClose: () => void
  confirmLabel?: string
}) {
  const [hidden, setHidden] = useState<boolean[]>(() => secrets.map(() => false))
  const [copied, setCopied] = useState<boolean[]>(() => secrets.map(() => false))

  // 每次发放 / 轮换都由调用方挂载一个新实例（关闭即卸载），
  // 所以这里的初始状态天然是「全部可见、未复制」，明文不会跨轮次残留在内存里。
  async function copy(index: number, value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error('复制失败，请手动选中后复制')
      return
    }
    setHidden((previous) => previous.map((flag, position) => (position === index ? true : flag)))
    setCopied((previous) => previous.map((flag, position) => (position === index ? true : flag)))
    toast.success('已复制，明文已隐藏')
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>明文只出现这一次</AlertTitle>
          <AlertDescription>
            关闭本对话框后，平台只保留指纹与掩码，无法再次查看明文；丢失只能重新轮换。
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-4">
          {secrets.map((secret, index) => {
            const masked = hidden[index] === true && copied[index] === true
            return (
              <div key={secret.label} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{secret.label}</span>
                  <div className="flex items-center gap-1">
                    {copied[index] === true && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setHidden((previous) =>
                            previous.map((flag, position) => (position === index ? !flag : flag)),
                          )
                        }
                      >
                        {masked ? <EyeIcon /> : <EyeOffIcon />}
                        {masked ? '显示' : '隐藏'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void copy(index, secret.value)}
                    >
                      {copied[index] === true ? <CheckIcon /> : <CopyIcon />}
                      {copied[index] === true ? '已复制' : '复制'}
                    </Button>
                  </div>
                </div>
                <code
                  data-testid={`issued-secret-${index}`}
                  className="block overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs break-all"
                >
                  {masked ? '••••••••••••••••••••••••••••' : secret.value}
                </code>
                {secret.hint !== undefined && (
                  <p className="text-xs text-muted-foreground">{secret.hint}</p>
                )}
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
