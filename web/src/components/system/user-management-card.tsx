import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon, ShieldCheckIcon, Trash2Icon, UserRoundCogIcon } from 'lucide-react'
import { useState } from 'react'

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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  deleteUser,
  describeAuthError,
  listUsers,
  updateUser,
  type UserView,
} from '@/lib/auth-api'
import { formatDateTime } from '@/lib/format'
import { useMe } from '@/hooks/use-me'

/**
 * 系统管理 → 用户管理（SPEC §4.3，仅 admin）。
 *
 * 能力：列表、升/降级（admin ↔ viewer）、启用/禁用、删除。
 *
 * **防自锁**：最后一个（启用中的）admin 不可降级 / 禁用 / 删除 —— 后端 `forbidden` 强制，
 * 这里把对应按钮禁用并给出原因，让「点不动」是显式的而不是一个 403 弹窗。
 *
 * 权限不靠隐藏：viewer 就算拿到页面源码，写请求也只会得到后端 403（`viewerWriteGuard`）。
 */
export function UserManagementCard() {
  const queryClient = useQueryClient()
  const meQuery = useMe()
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers, retry: false })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<UserView | null>(null)

  const users = usersQuery.data ?? []
  const activeAdminCount = users.filter((user) => user.role === 'admin' && user.isActive).length
  const selfId = meQuery.data?.user.id

  async function run(target: UserView, action: () => Promise<unknown>) {
    setBusyId(target.id)
    setError(null)
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      // 改到自己身上（降级 / 禁用）时，用户视图要跟着刷新，否则导航还按旧角色显示。
      if (target.id === selfId) await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (caught) {
      setError(describeAuthError(caught))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRoundCogIcon className="size-4" />
          用户管理
          <Badge variant="outline">仅管理员</Badge>
        </CardTitle>
        <CardDescription>
          角色两级：管理员可读写全部管理面，只读账号只能 GET + 管自己的设置。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error !== null && (
          <Alert variant="destructive">
            <ShieldCheckIcon />
            <AlertTitle>操作没有完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {usersQuery.isPending ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>上次登录</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                const lastActiveAdmin = user.role === 'admin' && user.isActive && activeAdminCount <= 1
                const busy = busyId === user.id
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">
                          {user.displayName}
                          {user.id === selfId && (
                            <span className="ml-1 text-xs text-muted-foreground">（我）</span>
                          )}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                        {user.role === 'admin' ? '管理员' : '只读'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.isActive ? 'outline' : 'destructive'}>
                        {user.isActive ? '启用' : '已禁用'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(user.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || (lastActiveAdmin && user.role === 'admin')}
                          title={lastActiveAdmin ? '最后一个管理员不能被降级（会锁死管理面）' : undefined}
                          onClick={() =>
                            void run(user, () =>
                              updateUser(user.id, { role: user.role === 'admin' ? 'viewer' : 'admin' }),
                            )
                          }
                        >
                          {busy ? <Loader2Icon className="animate-spin" /> : null}
                          {user.role === 'admin' ? '降为只读' : '升为管理员'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || (lastActiveAdmin && user.isActive)}
                          title={lastActiveAdmin ? '最后一个管理员不能被禁用（会锁死管理面）' : undefined}
                          onClick={() => void run(user, () => updateUser(user.id, { isActive: !user.isActive }))}
                        >
                          {user.isActive ? '禁用' : '启用'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || lastActiveAdmin}
                          title={lastActiveAdmin ? '最后一个管理员不能被删除（会锁死管理面）' : undefined}
                          onClick={() => setDeleting(user)}
                        >
                          <Trash2Icon />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        共 {users.length} 个用户，其中启用中的管理员 {activeAdminCount} 个；最后一个管理员不可降级 / 禁用 / 删除。
      </CardFooter>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除用户 {deleting?.email}？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后该账号立即失效（其会话在下一次请求时被后端拒绝），无法恢复。任务与项目数据不归属用户，不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId !== null}
              onClick={() => {
                if (deleting === null) return
                const target = deleting
                setDeleting(null)
                void run(target, () => deleteUser(target.id))
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
