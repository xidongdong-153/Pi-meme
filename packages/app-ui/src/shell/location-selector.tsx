import { useRef, useState } from 'react'
import { ArrowLeft, Globe, Monitor } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { serviceLabel, serviceStatus } from './service-ui'

export function LocationSelector({
  services,
  serviceId,
  disabledReason,
  onSelect,
  onError,
}: {
  services: HostService[]
  serviceId: string
  disabledReason?: string
  onSelect: (id: string, input: SelectWorkspace) => Promise<boolean>
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedService, setSelectedService] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)
  const targetService = services.find((service) => service.id === selectedService)
  const [pending, setPending] = useState<{ service: HostService; input: SelectWorkspace; name: string }>()
  const [busy, setBusy] = useState(false)
  const current = services.find((service) => service.id === serviceId)
  const label = current?.local
    ? '此计算机'
    : current
      ? `远程 · ${serviceLabel(current)}${current.transport === 'ssh' ? ' · SSH' : ''}`
      : '选择工作位置'
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (value) {
            setSelectedService(undefined)
            setQuery('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="工作位置"
            title={disabledReason || label}
            disabled={Boolean(disabledReason)}
            className="flex h-7 min-w-0 max-w-[180px] shrink items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors enabled:hover:bg-secondary/60 enabled:hover:text-foreground data-[state=open]:bg-secondary/60 data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset enabled:cursor-pointer disabled:opacity-50"
          >
            {current?.local ? (
              <Monitor className="size-3.5 shrink-0" />
            ) : (
              <Globe className="size-3.5 shrink-0 text-primary" />
            )}
            <span className="truncate">{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="选择工作位置"
          className="w-80 max-w-[calc(100vw-24px)] space-y-2 rounded-2xl p-2"
        >
          {targetService && (
            <button
              type="button"
              aria-label="返回工作位置服务列表"
              onClick={() => {
                setSelectedService(undefined)
                setQuery('')
                searchRef.current?.focus()
              }}
              className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
            >
              <ArrowLeft className="size-3.5 shrink-0" />
              <span className="truncate">{serviceLabel(targetService)}</span>
            </button>
          )}
          <Input
            ref={searchRef}
            aria-label={targetService ? '搜索工作位置项目' : '搜索工作位置服务'}
            placeholder={targetService ? '搜索项目' : '搜索远程服务'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 text-xs"
          />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {targetService
              ? [
                  { kind: 'standalone' as const, name: '不在项目中工作', cwd: '' },
                  ...targetService.projects.map((project) => ({
                    kind: 'project' as const,
                    cwd: project.cwd,
                    name: project.name,
                  })),
                ]
                  .filter((project) =>
                    `${project.name} ${project.cwd}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                  )
                  .map((project) => (
                    <button
                      key={project.kind === 'project' ? project.cwd : 'standalone'}
                      type="button"
                      disabled={targetService.status !== 'connected'}
                      onClick={() => {
                        setPending({
                          service: targetService,
                          input:
                            project.kind === 'project' ? { kind: 'project', cwd: project.cwd } : { kind: 'standalone' },
                          name: project.name,
                        })
                        setOpen(false)
                      }}
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                    >
                      {project.name}
                    </button>
                  ))
              : services
                  .filter((service) => serviceLabel(service).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
                  .map((service) => (
                    <button
                      key={service.id}
                      type="button"
                      onClick={() => {
                        setSelectedService(service.id)
                        setQuery('')
                        searchRef.current?.focus()
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-secondary"
                    >
                      {service.local ? (
                        <Monitor className="size-3.5 shrink-0" />
                      ) : (
                        <Globe className="size-3.5 shrink-0 text-primary" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{serviceLabel(service)}</span>
                      {service.status !== 'connected' && (
                        <span className="shrink-0 text-muted-foreground">{serviceStatus(service)}</span>
                      )}
                    </button>
                  ))}
          </div>
        </PopoverContent>
      </Popover>
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(value) => {
          if (!value && !busy) setPending(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>切换工作位置</DialogTitle>
          <DialogDescription>
            在{pending?.service.local ? '此计算机' : `远程 ${pending ? serviceLabel(pending.service) : ''}`}的“
            {pending?.name}”中创建新对话，带上文字、图片和输入模式。旧对话继续保留。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setPending(undefined)}>
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (!pending) return
                const target = pending
                setBusy(true)
                void onSelect(target.service.id, target.input)
                  .then(() => setPending(undefined))
                  .catch((cause: unknown) => {
                    onError(String(cause))
                    setPending(undefined)
                  })
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? '切换中' : '确认切换'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
