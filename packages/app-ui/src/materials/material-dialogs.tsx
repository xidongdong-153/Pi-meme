import { useEffect, useState } from 'react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import type { ImageLibrarySource } from '../images/image-library-data'
import type { ImageMaterial } from './material-types'

export type MaterialDialog = { material: ImageMaterial; action: 'info' | 'rename' | 'remove' }

export function MaterialOperationDialog({
  dialog,
  open,
  onOpenChange,
  busy,
  error,
  onSave,
}: {
  dialog?: MaterialDialog
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  error: string
  onSave: (name: string) => void
}) {
  const [name, setName] = useState('')
  useEffect(() => {
    if (dialog) setName(dialog.material.name)
  }, [dialog])
  const image = dialog?.material.image
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[80dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {dialog?.action === 'rename' ? '重命名图像' : dialog?.action === 'remove' ? '从资料空间移除' : '图像信息'}
          </DialogTitle>
          <DialogDescription>
            {dialog?.action === 'remove'
              ? '移除后不再显示在资料空间中，聊天记录和原文件仍会保留。'
              : dialog?.action === 'rename'
                ? '只修改资料空间中的名称，不更改原文件。'
                : dialog?.material.name}
          </DialogDescription>
        </DialogHeader>
        {dialog?.action === 'rename' && (
          <Input
            aria-label="图像名称"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && name.trim()) onSave(name)
            }}
          />
        )}
        {dialog?.action === 'info' && image && (
          <dl className="space-y-4 text-sm">
            {image.origin !== 'uploaded' && (
              <div>
                <dt className="text-muted-foreground">提示词</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words">{image.prompt || '历史记录未保存提示词'}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">来源</dt>
              <dd className="mt-1 break-words">{dialog.material.sourceLabel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{image.origin === 'uploaded' ? '上传时间' : '生成时间'}</dt>
              <dd className="mt-1">{new Date(image.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">格式与尺寸</dt>
              <dd className="mt-1">
                {image.mimeType || 'image/png'} · {image.width} × {image.height}
              </dd>
            </div>
            {image.origin !== 'uploaded' && (
              <div>
                <dt className="text-muted-foreground">模型</dt>
                <dd className="mt-1 break-words">
                  {image.model} · {image.operation === 'edit' ? '编辑' : '生成'}
                </dd>
              </div>
            )}
          </dl>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {dialog?.action !== 'info' && (
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant={dialog?.action === 'remove' ? 'destructive' : 'default'}
              disabled={busy || (dialog?.action === 'rename' && !name.trim())}
              onClick={() => onSave(name)}
            >
              {busy ? '正在保存…' : dialog?.action === 'remove' ? '移除' : '保存'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function MaterialHostDialog({
  open,
  onOpenChange,
  sources,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: ImageLibrarySource[]
  onCreate: (serviceId: string) => void
}) {
  const [target, setTarget] = useState('')
  const connected = sources.filter((source) => source.connected)
  const selected = connected.some((source) => source.id === target) ? target : connected[0]?.id || ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>创建图像</DialogTitle>
          <DialogDescription>选择用于创作的服务。</DialogDescription>
        </DialogHeader>
        <Select value={selected} onValueChange={setTarget}>
          <SelectTrigger aria-label="用于创作的服务">
            <SelectValue placeholder="选择服务" />
          </SelectTrigger>
          <SelectContent>
            {connected.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!connected.length && (
          <p role="alert" className="text-sm text-destructive">
            服务未连接，请先连接服务。
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={!selected}
            onClick={() => {
              onOpenChange(false)
              onCreate(selected)
            }}
          >
            继续
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
