import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Upload, X } from 'lucide-react'
import type { ImageLibraryItem } from '@pi-meme/contracts/image-library'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import type { ImageLibrarySource } from '../images/image-library-data'

type UploadJob = {
  id: string
  file: File
  key: string
  state: 'queued' | 'uploading' | 'success' | 'error' | 'cancelled'
  loaded: number
  error?: string
}
type UploadTarget = { hostId?: string; supported: boolean; error?: string }

export function MaterialUploadDialog({
  open,
  onOpenChange,
  sources,
  initialServiceId,
  droppedFiles,
  onUploaded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: ImageLibrarySource[]
  initialServiceId?: string
  droppedFiles?: File[]
  onUploaded: (item: ImageLibraryItem, source: ImageLibrarySource) => void
}) {
  const [target, setTarget] = useState('')
  const [targets, setTargets] = useState<Record<string, UploadTarget>>({})
  const [checking, setChecking] = useState(false)
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const [running, setRunning] = useState(false)
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const sourceRef = useRef(sources)
  sourceRef.current = sources
  const sourceKey = sources.map((source) => `${source.id}:${source.connected}`).join('|')
  const droppedRef = useRef<File[] | undefined>(undefined)

  function addFiles(files: File[]) {
    setJobs((previous) => [
      ...previous,
      ...files.map((file): UploadJob => {
        const type = file.type.toLowerCase()
        const error = !file.size
          ? '文件为空'
          : file.size > 8 * 1024 * 1024
            ? '单张图片不能超过 8 MiB'
            : (type && !['image/png', 'image/jpeg', 'image/webp'].includes(type)) ||
                (!type && !/\.(?:png|jpe?g|webp)$/i.test(file.name))
              ? '只支持 PNG、JPEG 和 WebP'
              : undefined
        return {
          id: crypto.randomUUID(),
          file,
          key: crypto.randomUUID(),
          state: error ? 'error' : 'queued',
          loaded: 0,
          error,
        }
      }),
    ])
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setChecking(true)
    setTarget(
      (current) => initialServiceId || current || sourceRef.current.find((source) => source.connected)?.id || '',
    )
    void Promise.all(
      sourceRef.current.map(async (source) => {
        if (!source.connected) return [source.id, { supported: false, error: '服务未连接' }] as const
        try {
          const caps = await source.host.capabilities()
          return [
            source.id,
            {
              hostId: caps.hostId,
              supported: caps.features.includes('image-library-upload') && Boolean(source.host.imageLibrary?.upload),
              error: caps.features.includes('image-library-upload')
                ? undefined
                : '当前服务版本不支持上传图片，请升级服务',
            },
          ] as const
        } catch (cause) {
          return [
            source.id,
            { supported: false, error: cause instanceof Error ? cause.message : '无法读取服务能力' },
          ] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) {
        setTargets(Object.fromEntries(entries))
        setChecking(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, sourceKey, initialServiceId])

  useEffect(() => {
    if (open && droppedFiles && droppedRef.current !== droppedFiles) {
      droppedRef.current = droppedFiles
      addFiles(droppedFiles)
    }
  }, [open, droppedFiles])

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort()
    },
    [],
  )

  async function start(selected: UploadJob[]) {
    if (busy.current || !targets[target]?.supported || checking) return
    const source = sourceRef.current.find((value) => value.id === target)
    if (!source?.connected || !source.host.imageLibrary?.upload) return
    const upload = source.host.imageLibrary.upload
    const expectedHost = targets[target].hostId
    busy.current = true
    setRunning(true)
    try {
      for (const job of selected) {
        const controller = new AbortController()
        controllers.current.set(job.id, controller)
        setJobs((current) =>
          current.map((value) =>
            value.id === job.id ? { ...value, state: 'uploading', loaded: 0, error: undefined } : value,
          ),
        )
        try {
          const caps = await source.host.capabilities()
          if (caps.hostId !== expectedHost) throw new Error('目标服务已改变，请重新选择')
          const item = await upload({
            name: job.file.name,
            data: job.file,
            idempotencyKey: job.key,
            signal: controller.signal,
            onProgress: (loaded) =>
              setJobs((current) => current.map((value) => (value.id === job.id ? { ...value, loaded } : value))),
          })
          if (item.hostId !== expectedHost) throw new Error('上传结果所属服务不匹配')
          setJobs((current) =>
            current.map((value) =>
              value.id === job.id ? { ...value, state: 'success', loaded: job.file.size } : value,
            ),
          )
          onUploaded(item, source)
        } catch (cause) {
          setJobs((current) =>
            current.map((value) =>
              value.id === job.id
                ? {
                    ...value,
                    state: controller.signal.aborted ? 'cancelled' : 'error',
                    error: controller.signal.aborted
                      ? '已取消'
                      : cause instanceof Error
                        ? cause.message
                        : '上传失败，请重试',
                  }
                : value,
            ),
          )
        } finally {
          controllers.current.delete(job.id)
        }
      }
    } finally {
      busy.current = false
      setRunning(false)
    }
  }

  const targetState = targets[target]
  const queued = jobs.filter((job) => job.state === 'queued')
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy.current) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>上传图片</DialogTitle>
          <DialogDescription>PNG、JPEG、WebP，单张不超过 8 MiB。</DialogDescription>
        </DialogHeader>
        <Select
          value={target}
          onValueChange={setTarget}
          disabled={running || jobs.some((job) => job.state === 'success')}
        >
          <SelectTrigger aria-label="图片保存到哪个服务">
            <SelectValue placeholder="选择服务" />
          </SelectTrigger>
          <SelectContent>
            {sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.label}
                {source.connected ? '' : ' · 未连接'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {checking ? (
          <p role="status" className="text-xs text-muted-foreground">
            正在检查服务…
          </p>
        ) : targetState?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {targetState.error}
          </p>
        ) : null}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          aria-label="选择要上传的图片"
          onChange={(event) => {
            addFiles(Array.from(event.target.files || []))
            event.target.value = ''
          }}
        />
        <Button
          variant="outline"
          disabled={running || checking || !targetState?.supported}
          className="h-24 border-dashed"
          onClick={() => input.current?.click()}
        >
          <Upload className="size-4" />
          选择图片
        </Button>
        {jobs.length > 0 && (
          <ul className="max-h-64 space-y-2 overflow-y-auto" aria-label="图片上传进度">
            {jobs.map((job) => (
              <li key={job.id} className="rounded-lg border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  {job.state === 'success' ? (
                    <Check className="size-4 shrink-0 text-emerald-500" />
                  ) : job.state === 'uploading' ? (
                    <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Upload className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{job.file.name}</span>
                  {job.state === 'uploading' ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`取消上传${job.file.name}`}
                      onClick={() => controllers.current.get(job.id)?.abort()}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : job.state === 'error' || job.state === 'cancelled' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={running || job.file.size === 0 || job.file.size > 8 * 1024 * 1024}
                      onClick={() => void start([job])}
                    >
                      重试
                    </Button>
                  ) : job.state === 'queued' ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除待上传图片${job.file.name}`}
                      disabled={running}
                      onClick={() => setJobs((current) => current.filter((value) => value.id !== job.id))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                {job.state === 'uploading' && (
                  <div
                    className="mt-2 h-1 overflow-hidden rounded-full bg-secondary"
                    role="progressbar"
                    aria-label={job.file.name}
                    aria-valuemin={0}
                    aria-valuemax={job.file.size}
                    aria-valuenow={Math.min(job.loaded, job.file.size)}
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (job.loaded / job.file.size) * 100)}%` }}
                    />
                  </div>
                )}
                {job.error && (
                  <p role="alert" className="mt-1 break-words text-xs text-destructive">
                    {job.error}
                  </p>
                )}
                {job.state === 'uploading' && job.loaded >= job.file.size && (
                  <p role="status" className="mt-1 text-xs text-muted-foreground">
                    正在保存到资料空间…
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={running}
            onClick={() => {
              setJobs([])
              onOpenChange(false)
            }}
          >
            完成
          </Button>
          <Button
            disabled={running || checking || !targetState?.supported || queued.length === 0}
            onClick={() => void start(queued)}
          >
            {running ? '正在上传…' : '开始上传'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
