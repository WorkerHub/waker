/**
 * 页脚：展示构建期的 `git describe` 版本号（WorkerHub 通用方案要求）。
 * 版本号由 `vite.config.ts` 的 `define` 注入，运行期不读 git、不发额外请求。
 */
export function VersionFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-4 text-xs text-muted-foreground">
        <span>waker · 全舰队统一调度平台</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{__APP_VERSION__}</span>
        <span className="ml-auto">单人自托管 · 任务时间以 epoch 毫秒存储</span>
      </div>
    </footer>
  )
}
