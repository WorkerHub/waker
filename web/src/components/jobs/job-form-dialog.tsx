import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircleIcon, Loader2Icon, SaveIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { TimeZoneField } from '@/components/jobs/timezone-field'
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiError,
  createJob,
  updateJob,
  type CreateJobInput,
  type JobKind,
  type JobPolicies,
  type JobView,
  type ProjectView,
  type UpdateJobInput,
} from '@/lib/api'
import {
  fromDateTimeLocal,
  parsePayloadText,
  prettyJson,
  toDateTimeLocal,
} from '@/lib/format'
import { CONCURRENCY_LABEL, MISFIRE_LABEL } from '@/lib/jobs'
import { browserTimeZone, isValidTimeZone } from '@/lib/timezones'

/**
 * 任务新建 / 编辑表单，字段严格取自 B2 冻结的 `CreateJobInput` / `UpdateJobInput`。
 *
 * 客户端只做「必填 + 契约范围」的即时校验（策略字段上下限与后端一致）；
 * cron 表达式与 IANA 时区的**真假判定仍以后端为准**（CF 方言解析器只有一份，
 * 时区合法性由 `assertTimezone` 终裁；前端只用同机制的 `Intl` 做一次即时预检），
 * 后端返回的 `invalid_cron` / `invalid_timezone` 错误码与 details 原样展示。
 */
const policiesSchema = z.object({
  misfire: z.enum(['fire_once', 'skip', 'fire_all']),
  concurrency: z.enum(['forbid', 'allow']),
  maxRetries: z.number({ error: '请填写 0-100 的整数' }).int({ error: '请填写整数' }).min(0, { error: '不能小于 0' }).max(100, { error: '最大 100' }),
  backoffSeconds: z.number({ error: '请填写 0-86400 的整数' }).int({ error: '请填写整数' }).min(0, { error: '不能小于 0' }).max(86_400, { error: '最大 86400' }),
  timeoutSeconds: z.number({ error: '请填写 1-86400 的整数' }).int({ error: '请填写整数' }).min(1, { error: '至少 1 秒' }).max(86_400, { error: '最大 86400' }),
  jitterSeconds: z.number({ error: '请填写 0-3600 的整数' }).int({ error: '请填写整数' }).min(0, { error: '不能小于 0' }).max(3_600, { error: '最大 3600' }),
})

const jobFormSchema = z
  .object({
    projectId: z.string().min(1, { error: '请选择所属项目' }),
    name: z
      .string()
      .trim()
      .min(1, { error: '请填写任务名' })
      .max(200, { error: '任务名最多 200 字符' }),
    kind: z.enum(['cron', 'one_shot']),
    cron: z.string(),
    runAtLocal: z.string(),
    timezone: z.string().trim().min(1, { error: '请填写 IANA 时区' }),
    payloadText: z.string(),
    policies: policiesSchema,
    enabled: z.boolean(),
  })
  .superRefine((values, context) => {
    if (values.kind === 'cron') {
      const fields = values.cron.trim().split(/\s+/).filter((field) => field !== '')
      if (fields.length === 0) {
        context.addIssue({ code: 'custom', path: ['cron'], message: '请填写 cron 表达式' })
      } else if (fields.length !== 5) {
        context.addIssue({
          code: 'custom',
          path: ['cron'],
          message: 'cron 必须是 5 字段（分 时 日 月 星期）；秒字段、年字段与 @ 宏 CF 不支持',
        })
      }
    } else if (values.runAtLocal === '') {
      context.addIssue({ code: 'custom', path: ['runAtLocal'], message: '请选择执行时刻' })
    } else if (fromDateTimeLocal(values.runAtLocal) === null) {
      context.addIssue({ code: 'custom', path: ['runAtLocal'], message: '执行时刻格式不正确' })
    }

    const payload = parsePayloadText(values.payloadText)
    if (!payload.ok) {
      context.addIssue({
        code: 'custom',
        path: ['payloadText'],
        message: `载荷必须是合法 JSON：${payload.error}`,
      })
    }

    // 即时预检用与后端 `assertTimezone` 同机制的 Intl；非空由 min(1) 单独负责。
    if (values.timezone !== '' && !isValidTimeZone(values.timezone)) {
      context.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: '不是合法的 IANA 时区名',
      })
    }
  })

type JobFormValues = z.infer<typeof jobFormSchema>

const DEFAULT_POLICIES: JobPolicies = {
  misfire: 'fire_once',
  concurrency: 'forbid',
  maxRetries: 0,
  backoffSeconds: 0,
  timeoutSeconds: 30,
  jitterSeconds: 0,
}

function defaultValues(
  mode: 'create' | 'edit',
  job: JobView | undefined,
  projects: ProjectView[],
): JobFormValues {
  if (mode === 'edit' && job !== undefined) {
    return {
      projectId: job.projectId,
      name: job.name,
      kind: job.kind,
      cron: job.cron ?? '',
      runAtLocal: toDateTimeLocal(job.runAt),
      timezone: job.timezone,
      payloadText: prettyJson(job.payload),
      policies: job.policies,
      enabled: job.status === 'active',
    }
  }

  return {
    projectId: projects[0]?.id ?? '',
    name: '',
    kind: 'cron',
    cron: '',
    runAtLocal: '',
    timezone: browserTimeZone(),
    payloadText: '{}',
    policies: DEFAULT_POLICIES,
    enabled: true,
  }
}

export function JobFormDialog({
  open,
  onOpenChange,
  mode,
  job,
  projects,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  job?: JobView
  projects: ProjectView[]
}) {
  const queryClient = useQueryClient()

  const form = useForm<JobFormValues>({
    resolver: zodResolver(jobFormSchema),
    defaultValues: defaultValues(mode, job, projects),
  })

  // 每次打开都按当前来源（新建 / 某个任务）重置，避免上一轮输入串场。
  useEffect(() => {
    if (!open) return
    form.reset(defaultValues(mode, job, projects))
    // form 实例在组件生命周期内稳定；依赖值变化时才重置。
  }, [open, mode, job, projects, form])

  const mutation = useMutation({
    mutationFn: async (values: JobFormValues): Promise<JobView> => {
      const payloadResult = parsePayloadText(values.payloadText)
      const payload = payloadResult.ok ? payloadResult.value : {}

      if (mode === 'create') {
        const input: CreateJobInput = {
          projectId: values.projectId,
          name: values.name.trim(),
          kind: values.kind,
          timezone: values.timezone.trim(),
          payload: payload as CreateJobInput['payload'],
          policies: values.policies,
          enabled: values.enabled,
          ...(values.kind === 'cron'
            ? { cron: values.cron.trim() }
            : { runAt: fromDateTimeLocal(values.runAtLocal) ?? 0 }),
        }
        return createJob(input)
      }

      if (job === undefined) throw new Error('缺少待编辑的任务')
      const input: UpdateJobInput = {
        jobId: job.id,
        timezone: values.timezone.trim(),
        payload: payload as UpdateJobInput['payload'],
        policies: values.policies,
        enabled: values.enabled,
        ...(values.kind === 'cron'
          ? { cron: values.cron.trim() }
          : { runAt: fromDateTimeLocal(values.runAtLocal) ?? 0 }),
      }
      return updateJob(input)
    },
    onSuccess: async (saved) => {
      toast.success(mode === 'create' ? `任务已创建：${saved.name}` : `任务已更新：${saved.name}`)
      await queryClient.invalidateQueries({ queryKey: ['jobs'] })
      onOpenChange(false)
    },
    // 失败信息直接取自 mutation 状态（下一次提交自动清空），不另设一份 state。

  })

  const kind = useWatch({ control: form.control, name: 'kind' })
  const enabled = useWatch({ control: form.control, name: 'enabled' })
  const isEdit = mode === 'edit'
  const serverError =
    mutation.error === null
      ? null
      : {
          code: mutation.error instanceof ApiError ? mutation.error.code : 'internal',
          message: mutation.error instanceof Error ? mutation.error.message : '保存失败',
        }

  function handleKindChange(next: JobKind) {
    form.setValue('kind', next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑任务' : '新建任务'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '任务名、类型与所属项目由唯一键决定，不可修改；其余调度参数改完立即重算下次执行时刻。'
              : 'cron 任务用 CF 方言 5 字段表达式；one-shot 任务指定一次性执行时刻，执行时可自续。'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="job-project">所属项目</FieldLabel>
                <Controller
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <NativeSelect
                      id="job-project"
                      className="w-full"
                      value={field.value}
                      disabled={isEdit}
                      onChange={(event) => field.onChange(event.target.value)}
                    >
                      <NativeSelectOption value="">选择项目</NativeSelectOption>
                      {projects.map((project) => (
                        <NativeSelectOption key={project.id} value={project.id}>
                          {project.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                />
                <FieldError errors={[form.formState.errors.projectId]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-name">任务名</FieldLabel>
                <Input
                  id="job-name"
                  disabled={isEdit}
                  placeholder="nightly-cleanup"
                  {...form.register('name')}
                />
                <FieldDescription>同项目下唯一，调用方按它定位任务。</FieldDescription>
                <FieldError errors={[form.formState.errors.name]} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="job-kind">类型</FieldLabel>
                <Controller
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <NativeSelect
                      id="job-kind"
                      className="w-full"
                      value={field.value}
                      disabled={isEdit}
                      onChange={(event) => handleKindChange(event.target.value as JobKind)}
                    >
                      <NativeSelectOption value="cron">cron 周期</NativeSelectOption>
                      <NativeSelectOption value="one_shot">one-shot 一次性</NativeSelectOption>
                    </NativeSelect>
                  )}
                />
              </Field>

              <Controller
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <TimeZoneField
                    id="job-timezone"
                    value={field.value}
                    onChange={field.onChange}
                    error={form.formState.errors.timezone}
                  />
                )}
              />
            </div>

            {kind === 'cron' ? (
              <Field>
                <FieldLabel htmlFor="job-cron">cron 表达式</FieldLabel>
                <Input
                  id="job-cron"
                  placeholder="0 3 * * *"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  {...form.register('cron')}
                />
                <FieldDescription>
                  CF Cron Triggers 方言：5 字段（分 时 日 月 星期），星期 1=周日…7=周六，
                  支持 `friL` / `LW` / `MON#1` 等扩展；秒/年字段、`?`、`@` 宏会被拒绝。
                </FieldDescription>
                <FieldError errors={[form.formState.errors.cron]} />
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="job-run-at">执行时刻</FieldLabel>
                <Input
                  id="job-run-at"
                  type="datetime-local"
                  {...form.register('runAtLocal')}
                />
                <FieldDescription>
                  按本地时间选择，提交时换算成 epoch 毫秒；执行回调可返回 nextRunAt 自续同一任务。
                </FieldDescription>
                <FieldError errors={[form.formState.errors.runAtLocal]} />
              </Field>
            )}
          </FieldGroup>

          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">执行策略</span>
              <span className="text-xs text-muted-foreground">
                建模时定死的六个字段，未设置的取平台默认值（补跑一次 / 禁止并发 / 超时 30 秒）。
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="job-misfire">错过窗口（misfirePolicy）</FieldLabel>
                <Controller
                  control={form.control}
                  name="policies.misfire"
                  render={({ field }) => (
                    <NativeSelect
                      id="job-misfire"
                      className="w-full"
                      value={field.value}
                      onChange={(event) => field.onChange(event.target.value)}
                    >
                      <NativeSelectOption value="fire_once">
                        {`fire_once · ${MISFIRE_LABEL.fire_once}`}
                      </NativeSelectOption>
                      <NativeSelectOption value="skip">
                        {`skip · ${MISFIRE_LABEL.skip}`}
                      </NativeSelectOption>
                      <NativeSelectOption value="fire_all">
                        {`fire_all · ${MISFIRE_LABEL.fire_all}`}
                      </NativeSelectOption>
                    </NativeSelect>
                  )}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-concurrency">并发策略（concurrencyPolicy）</FieldLabel>
                <Controller
                  control={form.control}
                  name="policies.concurrency"
                  render={({ field }) => (
                    <NativeSelect
                      id="job-concurrency"
                      className="w-full"
                      value={field.value}
                      onChange={(event) => field.onChange(event.target.value)}
                    >
                      <NativeSelectOption value="forbid">
                        {`forbid · ${CONCURRENCY_LABEL.forbid}`}
                      </NativeSelectOption>
                      <NativeSelectOption value="allow">
                        {`allow · ${CONCURRENCY_LABEL.allow}`}
                      </NativeSelectOption>
                    </NativeSelect>
                  )}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-max-retries">最大重试次数</FieldLabel>
                <Input
                  id="job-max-retries"
                  type="number"
                  min={0}
                  max={100}
                  {...form.register('policies.maxRetries', { valueAsNumber: true })}
                />
                <FieldError errors={[form.formState.errors.policies?.maxRetries]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-backoff">退避基数（秒）</FieldLabel>
                <Input
                  id="job-backoff"
                  type="number"
                  min={0}
                  max={86400}
                  {...form.register('policies.backoffSeconds', { valueAsNumber: true })}
                />
                <FieldDescription>第 n 次重试等待 backoff × 2^(n-1)。</FieldDescription>
                <FieldError errors={[form.formState.errors.policies?.backoffSeconds]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-timeout">超时（秒）</FieldLabel>
                <Input
                  id="job-timeout"
                  type="number"
                  min={1}
                  max={86400}
                  {...form.register('policies.timeoutSeconds', { valueAsNumber: true })}
                />
                <FieldError errors={[form.formState.errors.policies?.timeoutSeconds]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="job-jitter">抖动上限（秒）</FieldLabel>
                <Input
                  id="job-jitter"
                  type="number"
                  min={0}
                  max={3600}
                  {...form.register('policies.jitterSeconds', { valueAsNumber: true })}
                />
                <FieldDescription>同分钟任务按任务 id 哈希打散，防惊群。</FieldDescription>
                <FieldError errors={[form.formState.errors.policies?.jitterSeconds]} />
              </Field>
            </div>
          </div>

          <Field>
            <FieldLabel htmlFor="job-payload">载荷（payload，JSON）</FieldLabel>
            <Textarea
              id="job-payload"
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              {...form.register('payloadText')}
            />
            <FieldDescription>随回调原样下发给下游，平台不解析内容。</FieldDescription>
            <FieldError errors={[form.formState.errors.payloadText]} />
          </Field>

          <Field orientation="horizontal">
            <Switch
              id="job-enabled"
              checked={enabled === true}
              onCheckedChange={(checked) => form.setValue('enabled', checked)}
            />
            <FieldLabel htmlFor="job-enabled">
              {isEdit ? '启用（关闭＝暂停，不参与调度）' : '创建后立即启用'}
            </FieldLabel>
          </Field>

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
            <Button type="submit" disabled={mutation.isPending || projects.length === 0}>
              {mutation.isPending ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              {mutation.isPending ? '保存中…' : isEdit ? '保存修改' : '创建任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
