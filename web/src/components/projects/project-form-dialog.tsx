import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircleIcon, Loader2Icon, SaveIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  ApiError,
  createProject,
  updateProject,
  type CreateProjectResult,
  type ProjectView,
} from '@/lib/api'

const projectFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: '请填写项目名' })
    .max(100, { error: '项目名最多 100 字符' }),
  callbackUrl: z
    .string()
    .trim()
    .min(1, { error: '请填写回调地址' })
    .url({ error: '必须是完整 URL，例如 https://your-worker.example.com' }),
})

type ProjectFormValues = z.infer<typeof projectFormSchema>

/**
 * 项目新建 / 编辑表单。
 *
 * 新建成功后的应答里带**一次性明文凭据**（项目令牌 + signing key），
 * 这里不自己展示，交给页面的「只展示一次」对话框处理，避免明文在组件树里多存活一层。
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project?: ProjectView
  onCreated: (result: CreateProjectResult) => void
}) {
  const queryClient = useQueryClient()
  const isEdit = project !== undefined

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: { name: '', callbackUrl: '' },
  })

  useEffect(() => {
    if (!open) return
    form.reset({ name: project?.name ?? '', callbackUrl: project?.callbackUrl ?? '' })
  }, [open, project, form])

  const mutation = useMutation({
    mutationFn: async (values: ProjectFormValues) => {
      if (isEdit && project !== undefined) {
        return updateProject(project.id, {
          name: values.name.trim(),
          callbackUrl: values.callbackUrl.trim(),
        })
      }
      return createProject({ name: values.name.trim(), callbackUrl: values.callbackUrl.trim() })
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onOpenChange(false)
      if ('token' in result) {
        onCreated(result)
      } else {
        toast.success(`项目已更新：${result.name}`)
      }
    },
  })

  const serverError =
    mutation.error === null
      ? null
      : {
          code: mutation.error instanceof ApiError ? mutation.error.code : 'internal',
          message: mutation.error instanceof Error ? mutation.error.message : '保存失败',
        }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑项目' : '新建项目'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '项目名与回调地址可改；凭据不在这里改，走各自的轮换入口。'
              : '建项目的同时发放首个项目令牌与第一把 signing key，两者明文只展示一次。'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">项目名</FieldLabel>
              <Input id="project-name" placeholder="your-worker" {...form.register('name')} />
              <FieldError errors={[form.formState.errors.name]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="project-callback-url">回调地址</FieldLabel>
              <Input
                id="project-callback-url"
                placeholder="https://your-worker.example.com"
                autoComplete="off"
                spellCheck={false}
                {...form.register('callbackUrl')}
              />
              <FieldDescription>
                下游 Worker 的根地址（可带 `/_waker/execute`），平台按它拼回调并做 HMAC 签名。
              </FieldDescription>
              <FieldError errors={[form.formState.errors.callbackUrl]} />
            </Field>
          </FieldGroup>

          {serverError !== null && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>保存失败 · {serverError.code}</AlertTitle>
              <AlertDescription>{serverError.message}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              {mutation.isPending ? '保存中…' : isEdit ? '保存修改' : '创建项目'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
