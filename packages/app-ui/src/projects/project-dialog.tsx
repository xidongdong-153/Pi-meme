import { useRef, useState } from 'react'
import { Folder, FolderPlus, Loader2, X } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'

export function ProjectDialog({
  pickDirectory,
  onCreate,
  onDismiss,
}: {
  pickDirectory: () => Promise<string | null>
  onCreate: (input: { cwd: string; name?: string }) => Promise<void>
  onDismiss: () => void
}) {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const closed = useRef(false)

  function dismiss() {
    if (saving || choosing) return
    closed.current = true
    onDismiss()
  }

  async function choose() {
    if (lock.current) return
    lock.current = true
    setChoosing(true)
    setError('')
    try {
      const selected = await pickDirectory()
      if (selected && !closed.current) setCwd(selected)
    } catch (cause) {
      if (!closed.current) setError(`无法选择目录：${String(cause)}`)
    } finally {
      lock.current = false
      if (!closed.current) setChoosing(false)
    }
  }

  async function submit() {
    if (lock.current || !cwd) return
    const nextName = name.trim()
    lock.current = true
    setSaving(true)
    setError('')
    try {
      await onCreate({ cwd, ...(nextName ? { name: nextName } : {}) })
      closed.current = true
      onDismiss()
    } catch (cause) {
      setError(`无法创建项目：${String(cause)}`)
    } finally {
      lock.current = false
      if (!closed.current) setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg gap-5 rounded-2xl p-6 sm:p-7">
        <DialogHeader>
          <DialogTitle className="text-xl">创建项目</DialogTitle>
          <DialogDescription className="sr-only">填写项目名称（可选），并选择项目的源文件夹。</DialogDescription>
        </DialogHeader>
        <form
          id="create-project"
          className="min-h-0 space-y-4 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="relative">
            <Folder
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-muted-foreground"
            />
            <Input
              aria-label="项目名称"
              placeholder="项目名称"
              autoFocus
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              className="h-11 rounded-xl pl-10"
            />
          </div>
          <div className="space-y-2">
            <p id="project-directory-label" className="text-sm font-medium">
              源文件夹
            </p>
            <div aria-labelledby="project-directory-label" className="rounded-xl border border-border p-4">
              {cwd ? (
                <div className="flex min-w-0 items-center gap-3">
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 break-all text-sm select-text">{cwd}</p>
                  <button
                    type="button"
                    aria-label="移除源文件夹"
                    disabled={saving || choosing}
                    onClick={() => setCwd('')}
                    className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <p className="pt-3 text-center text-sm text-muted-foreground">添加项目的源文件夹</p>
              )}
              <div className="flex justify-center pb-2 pt-4">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={saving || choosing}
                  onClick={() => void choose()}
                  className="rounded-full"
                >
                  {choosing ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
                  {choosing ? '正在选择…' : cwd ? '更换文件夹' : '添加文件夹'}
                </Button>
              </div>
            </div>
          </div>
          {error && (
            <p role="alert" className="whitespace-pre-wrap break-all text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter className="gap-2 pt-1">
          <Button variant="ghost" disabled={saving || choosing} onClick={dismiss}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-project"
            disabled={saving || choosing || !cwd}
            className="rounded-full px-5"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? '正在创建…' : '创建项目'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
