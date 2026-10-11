import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { Copy, FolderOpen, MoreHorizontal, Pencil, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'
import type { DesktopBridge, ProjectApp, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { PiProjectGroup, PiSessionSummary } from '@pi-meme/contracts/sessions'
import * as Context from '@pi-meme/ui/components/ui/context-menu'
import * as Dropdown from '@pi-meme/ui/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { formatSessionTitle } from './session-title'

export type MenuTarget = { kind: 'project'; project: PiProjectGroup } | { kind: 'session'; session: PiSessionSummary }
export type SidebarMenuBridge = Pick<
  DesktopBridge,
  | 'getProjectApps'
  | 'openProject'
  | 'renameProject'
  | 'previewProjectDeletion'
  | 'removeProject'
  | 'renameSession'
  | 'deleteSession'
>

type MenuState = {
  pinnedPaths: string[]
  apps: ProjectApp[]
  loadApps: () => void
  onNewSession: (cwd: string) => void
  onTogglePin: (path: string) => void
  rename: (target: MenuTarget) => void
  remove: (target: MenuTarget) => void
  open: (app: ProjectApp['id'], cwd: string) => void
  copy: (cwd: string) => void
  /** 由菜单项打开重命名/删除对话框时置位，用来阻止菜单把焦点抢回触发按钮。 */
  dialogOpening: { current: boolean }
}
const Menus = createContext<MenuState | null>(null)
function useMenus() {
  const value = useContext(Menus)
  if (!value) throw new Error('侧栏菜单缺少操作上下文')
  return value
}

export function SidebarMenus({
  children,
  bridge,
  pinnedPaths,
  onNewSession,
  onTogglePin,
  onChanged,
  onDeleted,
  canOpenProject = true,
}: {
  canOpenProject?: boolean
  children: ReactNode
  bridge: SidebarMenuBridge
  pinnedPaths: string[]
  onNewSession: (cwd: string) => void
  onTogglePin: (path: string) => void
  onChanged: () => Promise<void>
  onDeleted: (result: WorkspaceDeletionResult) => Promise<void>
}) {
  const [apps, setApps] = useState<ProjectApp[]>(canOpenProject ? [{ id: 'finder', name: 'Finder' }] : [])
  const appsLoading = useRef(false)
  const [action, setAction] = useState<{ kind: 'rename' | 'delete'; target: MenuTarget } | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<{ paths: string[]; warnings: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const dialogOpening = useRef(false)
  const prepare = (kind: 'rename' | 'delete', target: MenuTarget) => {
    dialogOpening.current = true
    setError('')
    setPreview(null)
    setName(target.kind === 'project' ? target.project.name : formatSessionTitle(target.session))
    setAction({ kind, target })
    if (kind === 'delete' && target.kind === 'project') {
      setBusy(true)
      lock.current = true
      void bridge
        .previewProjectDeletion(target.project.cwd)
        .then(setPreview)
        .catch((cause) => setError(String(cause)))
        .finally(() => {
          lock.current = false
          setBusy(false)
        })
    }
  }
  const report = (work: Promise<unknown>) => {
    setNotice('')
    void work.catch((cause) => setNotice(String(cause)))
  }
  const submit = async () => {
    if (!action || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    const target = action.target
    try {
      if (action.kind === 'rename') {
        const next = name.replace(/[\r\n]+/g, ' ').trim()
        if (!next) throw new Error('名称不能为空')
        if (target.kind === 'project') await bridge.renameProject(target.project.cwd, next)
        else await bridge.renameSession(target.session.path, next)
        await onChanged()
      } else {
        const result =
          target.kind === 'project'
            ? await bridge.removeProject(target.project.cwd, preview!.paths)
            : await bridge.deleteSession(target.session.path)
        await onDeleted(result)
        if (result.warnings?.length) setNotice(result.warnings.join('\n'))
        if (result.errors.length)
          throw new Error(`已删除 ${result.deletedPaths.length} 个会话。${result.errors.join('\n')}`)
      }
      setAction(null)
    } catch (cause) {
      setError(String(cause))
      if (action.kind === 'delete' && target.kind === 'project') {
        setPreview(null)
        try {
          setPreview(await bridge.previewProjectDeletion(target.project.cwd))
        } catch (refreshCause) {
          setError(`${String(cause)}\n${String(refreshCause)}`)
        }
      }
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const value: MenuState = {
    pinnedPaths,
    dialogOpening,
    apps,
    onNewSession,
    onTogglePin,
    loadApps: () => {
      if (!canOpenProject) return
      if (appsLoading.current) return
      appsLoading.current = true
      void bridge
        .getProjectApps()
        .then(setApps)
        .catch((cause) => {
          appsLoading.current = false
          setNotice(String(cause))
        })
    },
    rename: (target) => prepare('rename', target),
    remove: (target) => prepare('delete', target),
    open: (app, cwd) => report(bridge.openProject(app, cwd)),
    copy: (cwd) => report(navigator.clipboard.writeText(cwd)),
  }
  const isRename = action?.kind === 'rename'
  const project = action?.target.kind === 'project' ? action.target.project : undefined
  return (
    <Menus.Provider value={value}>
      {children}
      {notice && (
        <div
          role="alert"
          className="fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border border-border bg-card px-3 py-2 text-xs text-destructive whitespace-pre-wrap break-all"
        >
          {notice}
        </div>
      )}
      <Dialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open && !lock.current) setAction(null)
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            if (isRename) {
              event.preventDefault()
              input.current?.focus()
              input.current?.select()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isRename
                ? project
                  ? '编辑项目名称'
                  : '重命名会话'
                : project
                  ? '移除项目并删除全部会话'
                  : '永久删除会话'}
            </DialogTitle>
            <DialogDescription>
              {isRename
                ? project
                  ? '仅修改显示名称，磁盘目录不变。'
                  : '修改此会话的显示名称。'
                : project
                  ? `将永久删除 ${preview?.paths.length ?? '…'} 个会话，并移除项目。项目目录、代码和附件文件保留。此操作无法撤销。`
                  : '将永久删除此会话及其全部消息分支。此操作无法撤销。'}
            </DialogDescription>
          </DialogHeader>
          {project && <p className="text-xs text-muted-foreground break-all">{project.cwd}</p>}
          {isRename ? (
            <form
              id="sidebar-rename"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <Input
                ref={input}
                aria-label="名称"
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </form>
          ) : (
            action?.target.kind === 'session' && (
              <p className="text-sm break-words">{formatSessionTitle(action.target.session)}</p>
            )
          )}
          {preview?.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground break-all">
              {warning}
            </p>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive whitespace-pre-wrap break-all">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              取消
            </Button>
            <Button
              variant={isRename ? 'default' : 'destructive'}
              disabled={busy || (isRename ? !name.trim() : Boolean(project && !preview))}
              onClick={() => void submit()}
            >
              {busy ? '处理中…' : isRename ? '保存' : '永久删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Menus.Provider>
  )
}

function MenuItems({ target, kind }: { target: MenuTarget; kind: 'context' | 'dropdown' }) {
  const menus = useMenus()
  const Item = kind === 'context' ? Context.ContextMenuItem : Dropdown.DropdownMenuItem
  const Separator = kind === 'context' ? Context.ContextMenuSeparator : Dropdown.DropdownMenuSeparator
  const Sub = kind === 'context' ? Context.ContextMenuSub : Dropdown.DropdownMenuSub
  const SubTrigger = kind === 'context' ? Context.ContextMenuSubTrigger : Dropdown.DropdownMenuSubTrigger
  const SubContent = kind === 'context' ? Context.ContextMenuSubContent : Dropdown.DropdownMenuSubContent
  const path = target.kind === 'project' ? target.project.cwd : target.session.path
  const pinned = menus.pinnedPaths.includes(path)
  const running =
    target.kind === 'project' ? target.project.sessions.some((session) => session.running) : target.session.running
  return (
    <>
      {target.kind === 'project' && (
        <Item onSelect={() => menus.onNewSession(target.project.cwd)}>
          <SquarePen />
          新建会话
        </Item>
      )}
      {target.kind === 'session' && (
        <Item onSelect={() => menus.rename(target)}>
          <Pencil />
          重命名
        </Item>
      )}
      <Item onSelect={() => menus.onTogglePin(path)}>
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? '取消置顶' : '置顶'}
      </Item>
      {target.kind === 'project' && (
        <>
          <Item onSelect={() => menus.rename(target)}>
            <Pencil />
            编辑名称
          </Item>
          <Sub>
            <SubTrigger>
              <FolderOpen />
              在…中打开
            </SubTrigger>
            <SubContent>
              {menus.apps.map((app) => (
                <Item key={app.id} onSelect={() => menus.open(app.id, target.project.cwd)}>
                  {app.name}
                </Item>
              ))}
            </SubContent>
          </Sub>
          <Item onSelect={() => menus.copy(target.project.cwd)}>
            <Copy />
            复制项目路径
          </Item>
        </>
      )}
      <Separator />
      <Item
        disabled={running}
        title={running ? '请先停止任务' : undefined}
        className="text-destructive"
        onSelect={() => menus.remove(target)}
      >
        <Trash2 />
        {target.kind === 'project' ? '移除项目并删除全部会话' : '永久删除'}
      </Item>
      {running && <div className="px-2.5 py-1 text-xs text-muted-foreground">请先停止任务</div>}
    </>
  )
}

export function SidebarRowMenu({ target, children }: { target: MenuTarget; children: ReactNode }) {
  const menus = useMenus()
  return (
    <Context.ContextMenu
      onOpenChange={(open) => {
        if (open && target.kind === 'project') menus.loadApps()
      }}
    >
      <Context.ContextMenuTrigger asChild>{children}</Context.ContextMenuTrigger>
      <Context.ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (menus.dialogOpening.current) {
            menus.dialogOpening.current = false
            event.preventDefault()
          }
        }}
      >
        <MenuItems target={target} kind="context" />
      </Context.ContextMenuContent>
    </Context.ContextMenu>
  )
}
export function SidebarMoreMenu({ target }: { target: MenuTarget }) {
  const menus = useMenus()
  const name = target.kind === 'project' ? target.project.name : formatSessionTitle(target.session)
  return (
    <Dropdown.DropdownMenu
      onOpenChange={(open) => {
        if (open && target.kind === 'project') menus.loadApps()
      }}
    >
      <Dropdown.DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`更多操作：${name}`}
          onClick={(event) => event.stopPropagation()}
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-opacity duration-200 ease-out opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </Dropdown.DropdownMenuTrigger>
      <Dropdown.DropdownMenuContent
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(event) => {
          if (menus.dialogOpening.current) {
            menus.dialogOpening.current = false
            event.preventDefault()
          }
        }}
      >
        <MenuItems target={target} kind="dropdown" />
      </Dropdown.DropdownMenuContent>
    </Dropdown.DropdownMenu>
  )
}
