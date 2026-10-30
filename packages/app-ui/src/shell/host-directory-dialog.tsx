import { useEffect, useRef, useState } from 'react'
import type { HostDirectory } from '@pi-meme/contracts/host'
import { Folder, ArrowUp } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'

export function HostDirectoryDialog({
  load,
  onSelect,
}: {
  load: (path?: string) => Promise<HostDirectory>
  onSelect: (path: string | null) => void
}) {
  const [directory, setDirectory] = useState<HostDirectory>()
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(0)

  async function navigate(target?: string) {
    const id = ++request.current
    setLoading(true)
    setError('')
    try {
      const next = await load(target)
      if (request.current !== id) return
      setDirectory(next)
      setPath(next.path)
    } catch (cause) {
      if (request.current === id) setError(String(cause))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }

  useEffect(() => {
    void navigate()
    return () => {
      request.current++
    }
  }, [load])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onSelect(null)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>选择项目目录</DialogTitle>
          <DialogDescription className="sr-only">在当前连接的设备上选择文件夹。</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate(path)
          }}
        >
          <Input aria-label="目录路径" value={path} onChange={(event) => setPath(event.target.value)} />
          <Button type="submit" variant="outline" disabled={loading}>
            打开
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="max-h-80 min-h-36 overflow-auto rounded-md border border-border p-1" aria-busy={loading}>
          {directory?.parent && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-sm hover:bg-secondary"
              onClick={() => void navigate(directory.parent!)}
            >
              <ArrowUp className="size-4" />
              上一级
            </button>
          )}
          {directory?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-secondary"
              onClick={() => void navigate(entry.path)}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              {entry.name}
            </button>
          ))}
          {directory && !directory.entries.length && (
            <p className="px-2 py-4 text-sm text-muted-foreground">没有子目录</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onSelect(null)}>
            取消
          </Button>
          <Button disabled={!directory || loading} onClick={() => onSelect(directory!.path)}>
            选择当前目录
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
