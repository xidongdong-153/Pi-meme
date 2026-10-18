import { useEffect, useRef, useState } from 'react'
import { Check, Settings } from 'lucide-react'
import type { GitBridge, GitEnvironment } from '@pi-meme/contracts/desktop'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

export function GitMenu({
  bridge,
  sessionKey,
  refreshToken,
  disabledReason,
  onSwitch,
  onCreateBranch,
  onCreateWorktree,
}: {
  bridge: GitBridge
  sessionKey?: string
  refreshToken: number
  disabledReason?: string
  onSwitch: (branch: string) => Promise<boolean>
  onCreateBranch: (name: string, base: string) => Promise<boolean>
  onCreateWorktree: (base: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [environment, setEnvironment] = useState<GitEnvironment | null>(null)
  const [error, setError] = useState('')
  const [notRepository, setNotRepository] = useState(false)
  const [query, setQuery] = useState('')
  const [create, setCreate] = useState<'branch' | 'worktree'>()
  const [branchName, setBranchName] = useState('codex/')
  const [base, setBase] = useState('HEAD')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousKey = useRef(sessionKey)
  useEffect(() => {
    let current = true
    if (previousKey.current !== sessionKey) {
      previousKey.current = sessionKey
      setEnvironment(null)
      setError('')
      setNotRepository(false)
      setOpen(false)
      setCreate(undefined)
      setQuery('')
    }
    if (!sessionKey) return
    void bridge
      .getGitEnvironment(sessionKey)
      .then((value) => {
        if (current) {
          setEnvironment(value)
          setError('')
          setNotRepository(!value.root)
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          const message = String(cause).replace(/^Error:\s*/, '')
          const outsideRepository = message.includes('当前目录不是 Git 仓库')
          setNotRepository(outsideRepository)
          setError(
            outsideRepository
              ? ''
              : /不支持|未知|不存在|unsupported|unknown/i.test(message)
                ? '当前远程服务尚不支持 Git 工作位置操作'
                : message,
          )
        }
      })
    return () => {
      current = false
    }
  }, [bridge, sessionKey, refreshToken, open])
  const branches =
    environment?.branches.filter((branch) => branch.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? []
  const unavailable =
    disabledReason || (notRepository ? '当前项目未使用 Git' : !environment ? error || '正在读取 Git 状态' : '')
  async function run(action: () => Promise<boolean>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      setOpen(false)
      setCreate(undefined)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  function startCreate(kind: 'branch' | 'worktree') {
    setOpen(false)
    setBase('HEAD')
    setBranchName('codex/')
    setError('')
    setCreate(kind)
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Git 分支与工作树"
            title={unavailable || environment?.branch || '分离 HEAD'}
            disabled={Boolean(disabledReason)}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors enabled:hover:bg-secondary/60 enabled:hover:text-foreground data-[state=open]:bg-secondary/60 data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset enabled:cursor-pointer disabled:opacity-50"
          >
            <Settings className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          aria-label="Git 工作位置"
          className="w-72 max-w-[calc(100vw-24px)] space-y-2 rounded-2xl p-2"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            searchRef.current?.focus()
          }}
        >
          {notRepository ? (
            <div role="status" className="space-y-1 px-2 py-1">
              <p className="text-xs text-foreground/85">当前项目未使用 Git</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                可以正常对话。分支和 Worktree 功能需要 Git 仓库。
              </p>
            </div>
          ) : unavailable ? (
            <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
              {unavailable}
            </p>
          ) : (
            <>
              <p className="px-2 text-xs text-muted-foreground">
                {environment?.dirty ? '工作区有未提交改动，切分支前需处理这些改动。' : '工作区干净。'}
                {!environment?.headSha && ' 仓库还没有提交，暂时不能创建分支或工作树。'}
              </p>
              <Input
                ref={searchRef}
                aria-label="搜索 Git 分支"
                placeholder="搜索分支"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 text-xs"
              />
              <div className="max-h-52 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Git 分支">
                {branches.map((branch) => (
                  <button
                    key={branch.ref}
                    type="button"
                    role="option"
                    aria-selected={branch.current}
                    title={branch.occupiedBy ? `已被工作树占用：${branch.occupiedBy}` : branch.ref}
                    disabled={busy || Boolean(branch.occupiedBy) || environment?.dirty || !environment?.headSha}
                    onClick={() => void run(() => onSwitch(branch.ref))}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                  >
                    <span className="truncate">
                      {branch.name}
                      {branch.kind === 'remote' ? ' · 远程' : branch.occupiedBy ? ' · 已占用' : ''}
                    </span>
                    {branch.current && <Check className="size-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
              <div className="border-t border-border pt-1">
                <button
                  type="button"
                  disabled={busy || !environment?.headSha || environment?.dirty}
                  onClick={() => startCreate('branch')}
                  className="block w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-secondary disabled:opacity-50"
                >
                  新建分支…
                </button>
                <button
                  type="button"
                  disabled={busy || !environment?.headSha}
                  onClick={() => startCreate('worktree')}
                  className="block w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-secondary disabled:opacity-50"
                >
                  新建 Worktree…
                </button>
              </div>
            </>
          )}
          {error && environment && (
            <p role="alert" className="break-words px-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={Boolean(create)}
        onOpenChange={(value) => {
          if (!value && !busy) setCreate(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>{create === 'worktree' ? '新建 Worktree' : '新建分支'}</DialogTitle>
          <DialogDescription>
            {create === 'worktree'
              ? '从所选提交创建分离 HEAD 的工作树，不带入未提交改动。创建后在原项目中新建对话，带上文字、图片和输入模式。'
              : '从所选提交创建并切换分支，在当前项目中新建对话，保留草稿。'}
          </DialogDescription>
          {create === 'branch' && (
            <label className="block space-y-2 text-sm">
              分支名称
              <Input
                autoFocus
                aria-label="新分支名称"
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
              />
            </label>
          )}
          <label className="block space-y-2 text-sm">
            起点
            <Select value={base} onValueChange={setBase}>
              <SelectTrigger
                autoFocus={create === 'worktree'}
                aria-label="Git 起点"
                className="rounded-lg bg-background"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                <SelectItem value="HEAD">
                  当前提交{environment?.headSha ? ` · ${environment.headSha.slice(0, 7)}` : ''}
                </SelectItem>
                {environment?.branches.map((branch) => (
                  <SelectItem key={branch.ref} value={branch.ref}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setCreate(undefined)}>
              取消
            </Button>
            <Button
              disabled={
                busy ||
                !environment?.headSha ||
                Boolean(disabledReason) ||
                (create === 'branch' && (!branchName.trim() || environment?.dirty))
              }
              onClick={() =>
                void run(() =>
                  create === 'worktree' ? onCreateWorktree(base) : onCreateBranch(branchName.trim(), base),
                )
              }
            >
              {busy ? '创建中' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
