import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircleIcon,
  CheckIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { IssuedSecretDialog, type IssuedSecret } from '@/components/issued-secret-dialog'
import { PageHeader } from '@/components/page-header'
import { ProjectFormDialog } from '@/components/projects/project-form-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiError,
  listProjects,
  rotateProjectToken,
  rotateSigningKey,
  type CreateProjectResult,
  type ProjectView,
} from '@/lib/api'
import { formatDateTime } from '@/lib/format'

type RotateTarget = { project: ProjectView; kind: 'token' | 'signing-key' }

/**
 * 项目管理页（F1）。
 *
 * 凭据规则（B4 冻结契约）：
 *   - 项目令牌只存 `sha256` 哈希，页面只显示前 16 位指纹（`tokenFingerprint`）；
 *   - signing key 明文只存平台侧密文，页面只显示指纹（`signingKey.fingerprint`）；
 *   - 发放 / 轮换的应答里带一次明文 → 用「只展示一次」对话框展示后从内存丢弃。
 * 页面从不请求、也从不保存任何明文凭据。
 */
export function ProjectsPage() {
  const queryClient = useQueryClient()
  const [formState, setFormState] = useState<{ open: boolean; project?: ProjectView }>({ open: false })
  const [issued, setIssued] = useState<{
    title: string
    description: string
    secrets: IssuedSecret[]
  } | null>(null)
  const [rotateTarget, setRotateTarget] = useState<RotateTarget | null>(null)

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projects = projectsQuery.data ?? []

  const rotateMutation = useMutation({
    mutationFn: async (target: RotateTarget) =>
      target.kind === 'token'
        ? { kind: 'token' as const, result: await rotateProjectToken(target.project.id) }
        : { kind: 'signing-key' as const, result: await rotateSigningKey(target.project.id) },
    onSuccess: async (payload) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (payload.kind === 'token') {
        setIssued({
          title: '新的项目令牌',
          description: `「${payload.result.project.name}」的旧令牌已立即失效。`,
          secrets: [
            {
              label: '项目令牌（token）',
              value: payload.result.token,
              hint: '用于注册 API：`Authorization: Bearer <项目令牌>`',
            },
          ],
        })
      } else {
        setIssued({
          title: '新的 signing key',
          description: `「${payload.result.project.name}」的旧 signing key 已立即撤销，下游验签需同步更新。`,
          secrets: [
            {
              label: 'signing key',
              value: payload.result.signingKey.secret,
              hint: '仅用于下游验签，平台侧只保存密文与指纹。',
            },
          ],
        })
      }
    },
    onError: (error) => toast.error(describeError(error, '轮换失败')),
  })

  function handleCreated(result: CreateProjectResult) {
    setIssued({
      title: '项目已创建，凭据只展示这一次',
      description: `「${result.project.name}」的项目令牌与 signing key 已生成，两把凭据相互独立、可分别轮换。`,
      secrets: [
        {
          label: '项目令牌（token）',
          value: result.token,
          hint: 'CI 注册任务时用：`Authorization: Bearer <项目令牌>`',
        },
        {
          label: 'signing key',
          value: result.signingKey.secret,
          hint: `算法 ${result.signingKey.algorithm} · 下游用它验签回调`,
        },
      ],
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="项目管理"
        description="接入单元：每个项目两条独立凭据（项目令牌用于注册 API，signing key 用于回调验签），可分别轮换。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['projects'] })}
            >
              <RefreshCwIcon />
              刷新
            </Button>
            <Button size="sm" onClick={() => setFormState({ open: true })}>
              <PlusIcon />
              新建项目
            </Button>
          </>
        }
      />

      {projectsQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>项目列表加载失败</AlertTitle>
          <AlertDescription>
            {describeError(projectsQuery.error, '请稍后重试')}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void projectsQuery.refetch()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {projectsQuery.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-52 w-full rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanbanIcon />
            </EmptyMedia>
            <EmptyTitle>还没有项目</EmptyTitle>
            <EmptyDescription>
              建一个项目即可拿到项目令牌（注册 API）与 signing key（回调验签）。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setFormState({ open: true })}>
              <PlusIcon />
              新建项目
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={() => setFormState({ open: true, project })}
              onRotate={(kind) => setRotateTarget({ project, kind })}
            />
          ))}
        </div>
      )}

      <ProjectFormDialog
        open={formState.open}
        onOpenChange={(open) => setFormState((state) => ({ ...state, open }))}
        project={formState.project}
        onCreated={handleCreated}
      />

      {issued !== null && (
        <IssuedSecretDialog
          title={issued.title}
          description={issued.description}
          secrets={issued.secrets}
          onClose={() => setIssued(null)}
        />
      )}

      <AlertDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rotateTarget?.kind === 'token' ? '轮换项目令牌？' : '轮换 signing key？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {rotateTarget?.kind === 'token'
                ? '旧项目令牌会立即失效，仍在用旧令牌的 CI / 注册调用会 401，需要同步换成新令牌。'
                : '旧 signing key 会立即撤销，下游必须用新 key 验签，否则回调验签全部失败。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rotateTarget !== null) rotateMutation.mutate(rotateTarget)
                setRotateTarget(null)
              }}
            >
              确认轮换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ProjectCard({
  project,
  onEdit,
  onRotate,
}: {
  project: ProjectView
  onEdit: () => void
  onRotate: (kind: 'token' | 'signing-key') => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              {project.name}
              <Badge variant={project.status === 'active' ? 'default' : 'destructive'}>
                {project.status === 'active' ? '启用' : '已吊销'}
              </Badge>
            </CardTitle>
            <CardDescription className="font-mono text-xs break-all">
              {project.callbackUrl}
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="编辑项目" onClick={onEdit}>
            <PencilIcon />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="grid gap-3 sm:grid-cols-2">
        <CredentialBlock
          icon={<KeyRoundIcon className="size-4" />}
          title="项目令牌"
          fingerprint={project.tokenFingerprint}
          empty="尚未发放"
          metas={[
            `发放 ${formatDateTime(project.tokenCreatedAt)}`,
            project.tokenRotatedAt === null ? null : `轮换 ${formatDateTime(project.tokenRotatedAt)}`,
          ]}
          onRotate={() => onRotate('token')}
        />
        <CredentialBlock
          icon={<ShieldCheckIcon className="size-4" />}
          title="signing key"
          fingerprint={project.signingKey?.fingerprint ?? null}
          empty="尚未发放"
          metas={[
            project.signingKey === null ? null : project.signingKey.algorithm,
            project.signingKey === null ? null : `生成 ${formatDateTime(project.signingKey.createdAt)}`,
            project.signingKey?.rotatedAt == null
              ? null
              : `轮换 ${formatDateTime(project.signingKey.rotatedAt)}`,
          ]}
          onRotate={() => onRotate('signing-key')}
        />
      </CardContent>

      <CardFooter className="justify-between text-xs text-muted-foreground">
        <span>创建于 {formatDateTime(project.createdAt)}</span>
        <span className="inline-flex items-center gap-1">
          <CheckIcon className="size-3" />
          明文不落库，仅保留指纹
        </span>
      </CardFooter>
    </Card>
  )
}

function CredentialBlock({
  icon,
  title,
  fingerprint,
  empty,
  metas,
  onRotate,
}: {
  icon: React.ReactNode
  title: string
  fingerprint: string | null
  empty: string
  metas: Array<string | null>
  onRotate: () => void
}) {
  const details = metas.filter((meta): meta is string => meta !== null)

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </span>
        <Button variant="outline" size="xs" onClick={onRotate}>
          <RotateCwIcon />
          {fingerprint === null ? '发放' : '轮换'}
        </Button>
      </div>
      <code className="font-mono text-xs break-all text-muted-foreground">
        {fingerprint === null ? empty : `指纹 ${fingerprint}`}
      </code>
      {details.length > 0 && (
        <span className="text-xs text-muted-foreground">{details.join(' · ')}</span>
      )}
    </div>
  )
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return fallback
}
