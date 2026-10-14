import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Copy, Plus, RefreshCw, ChevronDown, Upload } from 'lucide-react'
import type { ResourceCatalog, ResourceItem, ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { BranchSkillUsage } from '@pi-meme/contracts/skills'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { IntegrationHeader } from '@pi-meme/ui/components/integration-header'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { cn } from '@pi-meme/ui/lib/utils'

const scopes = { builtin: '应用自带', host: '此设备', project: '当前项目' }
export function SkillPage({
  client,
  cwd,
  commands,
  skillUsages = [],
  resourceSnapshot,
  onUse,
  onChanged,
}: {
  client: ResourceClient
  cwd?: string
  commands: PiSlashCommand[]
  skillUsages?: BranchSkillUsage[]
  resourceSnapshot?: ResourceSnapshot
  onUse: (command: PiSlashCommand) => void
  onChanged: () => Promise<void>
}) {
  const [catalog, setCatalog] = useState<ResourceCatalog>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [scope, setScope] = useState<'host' | 'project'>('host')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<ResourceItem>()
  const [editor, setEditor] = useState<{ item?: ResourceItem; name: string; content: string }>()
  const [dirty, setDirty] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const load = useCallback(async () => {
    const serial = ++request.current
    const next = await client.catalog(cwd)
    if (request.current === serial) {
      setCatalog(next)
    }
  }, [client, cwd])
  useEffect(() => {
    void load().catch((cause) => setError(`无法读取技能：${String(cause)}`))
    const off = client.onChange(() => void load().catch((cause) => setError(String(cause))))
    return () => {
      request.current++
      off()
    }
  }, [client, load])

  async function action(work: () => Promise<unknown>) {
    if (busy) return false
    setBusy(true)
    setError('')
    try {
      await work()
      await Promise.all([load(), onChanged()])
      return true
    } catch (cause) {
      setError(String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const items = catalog?.items.filter((item) => item.kind === 'skill') ?? []
  const current = items.find((item) => item.id === selected)
  const filtered = items.filter((item) =>
    `${item.name} ${item.displayName ?? ''} ${item.description ?? ''} ${item.owner.name ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const activePolicy = current && (scope === 'host' ? current.hostPolicy : current.projectPolicy)
  const policyEnabled =
    scope === 'host' ? (current?.hostPolicy?.enabled ?? current?.defaultPolicy?.enabled ?? true) : current?.enabled
  const policyInvocation =
    scope === 'host'
      ? (current?.hostPolicy?.invocation ?? current?.defaultPolicy?.invocation ?? 'automatic')
      : current?.invocation
  const command = current && commands.find((entry) => entry.source === 'skill' && entry.resourceId === current.id)
  const currentUsages = skillUsages.filter((usage) => usage.id === current?.id)
  const pinned = current && (resourceSnapshot?.skills ?? []).find((item) => item.id === current.id)
  const pending =
    current &&
    (pinned
      ? pinned.revision !== current.revision ||
        pinned.enabled !== current.enabled ||
        pinned.invocation !== current.invocation
      : resourceSnapshot
        ? current.enabled
        : command && command.resourceRevision !== current.revision)

  async function edit(item?: ResourceItem) {
    setError('')
    if (!item) {
      setEditor({ name: 'my-skill', content: '---\nname: my-skill\ndescription: 描述适用的任务和触发条件。\n---\n\n' })
      setDirty(false)
      return
    }
    try {
      const detail = await client.readSkill(item.id, cwd)
      setEditor({ item: detail.item, name: item.name, content: detail.content })
      setDirty(false)
    } catch (cause) {
      setError(String(cause))
    }
  }

  function state(item: ResourceItem) {
    if (item.diagnostics.length) return '需要处理'
    if (item.shadowedBy) return '存在同名技能'
    if (!item.enabled) return '已停用'
    if (skillUsages.some((usage) => usage.id === item.id && !usage.inherited)) return '已读取'
    if (skillUsages.some((usage) => usage.id === item.id && usage.inherited)) return '继承读取记录'
    return item.invocation === 'manual' ? '仅手动调用' : '已启用'
  }

  return (
    <section aria-label="技能管理" className="space-y-6" aria-busy={busy}>
      <input
        hidden
        ref={uploadRef}
        type="file"
        accept=".md,.zip"
        aria-label="导入技能文件"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          void action(async () => {
            if (file.size > 32 * 1024 * 1024) throw new Error('技能文件不能超过 32 MiB')
            if (file.name.endsWith('.zip')) {
              const bytes = new Uint8Array(await file.arrayBuffer())
              const parts: string[] = []
              for (let offset = 0; offset < bytes.length; offset += 32768)
                parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
              await client.import({ kind: 'skill', archiveBase64: btoa(parts.join('')) }, cwd)
            } else await client.import({ kind: 'skill', content: await file.text() }, cwd)
          })
        }}
      />
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {catalog?.diagnostics.map((message) => (
        <p key={message} className="break-words text-sm text-destructive">
          {message}
        </p>
      ))}
      {current ? (
        <div className="space-y-6">
          <Button variant="ghost" onClick={() => setSelected(undefined)}>
            <ArrowLeft />
            返回技能
          </Button>
          <div>
            <h3 className="text-xl font-semibold">{current.displayName ?? current.name}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              技能 · {scopes[current.scope]} · {state(current)}
            </p>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-7">{current.description || '未提供说明'}</p>
          <dl className="grid gap-4 rounded-2xl border border-border p-5 text-sm">
            {Object.entries({
              ...(current.owner.type === 'app-package' ? { 所属安装包: current.owner.name ?? current.owner.id } : {}),
              版本: current.owner.version ?? current.revision.slice(0, 12),
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
              </div>
            ))}
          </dl>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">文件信息</summary>
            <dl className="mt-3 space-y-3 text-xs">
              {Object.entries({ 文件位置: current.sourcePath, 运行副本: current.path }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="mt-1 break-all font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="text-sm text-muted-foreground">
            {pending
              ? '当前聊天仍使用原版本，任务结束后更新。'
              : command
                ? '可以在当前聊天中选择此技能。'
                : '此技能暂不可用于当前聊天。'}
          </p>
          {currentUsages.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {currentUsages.map((usage, index) => (
                <li key={`${usage.toolCallId ?? usage.messageTimestamp}-${index}`}>
                  {usage.inherited ? '来自上级任务' : usage.source === 'explicit' ? '手动选择' : '已读取'} · 版本{' '}
                  {usage.revision.slice(0, 12)}
                </li>
              ))}
            </ul>
          )}
          {current.diagnostics.map((message) => (
            <p key={message} role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="技能策略范围"
              value={scope}
              onChange={(event) => setScope(event.target.value as 'host' | 'project')}
              className="rounded-lg border border-border bg-background p-2 text-sm"
            >
              {current.scope !== 'project' && <option value="host">设备默认设置</option>}
              {cwd && <option value="project">仅当前项目</option>}
            </select>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(() => client.setPolicy({ id: current.id, scope, cwd, enabled: !policyEnabled }))
              }
            >
              {policyEnabled ? '停用' : '启用'}
            </Button>
            {activePolicy && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void action(() => client.setPolicy({ id: current.id, scope, cwd, reset: true }))}
              >
                {scope === 'project' ? '使用设备默认设置' : '恢复默认设置'}
              </Button>
            )}
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    client.setPolicy({
                      id: current.id,
                      scope,
                      cwd,
                      invocation: policyInvocation === 'manual' ? 'automatic' : 'manual',
                    }),
                  )
                }
              >
                {policyInvocation === 'manual' ? '允许自动调用' : '设为仅手动'}
              </Button>
              <Button
                disabled={!command || !current.enabled || Boolean(current.shadowedBy) || busy || pending}
                onClick={() => command && onUse(command)}
              >
                用于当前聊天
              </Button>
              {current.editable && (
                <Button variant="outline" disabled={busy} onClick={() => void edit(current)}>
                  编辑 SKILL.md
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    client.import(
                      {
                        kind: 'skill',
                        path: current.baseDir,
                        name: `${current.name.split(':').at(-1)}-copy`,
                      },
                      cwd,
                    ),
                  )
                }
              >
                <Copy />
                复制为我的技能
              </Button>
            </>
            {current.scope === 'host' && current.owner.type === 'loose' && (
              <Button variant="outline" disabled={busy} onClick={() => setRemoving(current)}>
                卸载
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <IntegrationHeader
            title="技能"
            description="管理技能，设置设备默认或当前项目的调用方式。"
            query={query}
            onQuery={setQuery}
            searchLabel="搜索技能"
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="重新扫描技能"
                  disabled={busy}
                  onClick={() => void action(() => client.refresh(cwd))}
                >
                  <RefreshCw className={cn(busy && 'animate-spin')} />
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setImportOpen(true)}>
                  从设备目录导入
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="添加技能" disabled={busy}>
                      添加
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void edit()}>
                      <Plus />
                      新建技能
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => uploadRef.current?.click()}>
                      <Upload />
                      导入技能文件
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />
          {!catalog ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取技能…
            </p>
          ) : (
            <ul className="space-y-1 pt-6" aria-label="技能列表">
              {filtered.map((item) => {
                return (
                  <li key={item.id} className="flex min-h-24 items-center gap-4 rounded-xl px-3 hover:bg-secondary/30">
                    <button
                      type="button"
                      aria-label={`查看技能：${item.name}`}
                      onClick={() => {
                        setSelected(item.id)
                        setScope(item.scope === 'project' ? 'project' : 'host')
                      }}
                      className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground">
                        <BookOpen className="size-5" strokeWidth={1.6} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-base font-medium">{item.displayName ?? item.name}</span>
                        <span className="mt-1 block truncate text-sm text-muted-foreground">
                          {item.shortDescription ?? item.description ?? '未提供说明'}
                        </span>
                      </span>
                    </button>
                    <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline" title={state(item)}>
                      {item.owner.type === 'app-package' ? '来自插件' : scopes[item.scope]}
                    </span>
                    <Switch
                      label={`启用技能：${item.displayName ?? item.name}`}
                      checked={item.hostPolicy?.enabled ?? item.defaultPolicy.enabled ?? true}
                      disabled={busy || Boolean(item.diagnostics.length)}
                      onChange={(enabled) =>
                        void action(() => client.setPolicy({ id: item.id, scope: 'host', cwd, enabled }))
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}
          {catalog && !filtered.length && (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              没有匹配的技能。
            </p>
          )}
        </>
      )}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogTitle>导入技能目录</DialogTitle>
          <DialogDescription>
            填写当前连接设备 上含 SKILL.md 的技能目录。远程连接填写远程设备上的路径。
          </DialogDescription>
          <Input aria-label="技能目录路径" value={importPath} onChange={(event) => setImportPath(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !importPath.trim()}
              onClick={() =>
                void action(async () => {
                  await client.import({ kind: 'skill', path: importPath.trim() }, cwd)
                  setImportOpen(false)
                  setImportPath('')
                })
              }
            >
              导入
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !dirty) setEditor(undefined)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogTitle>{editor?.item ? '编辑技能' : '新建技能'}</DialogTitle>
          <DialogDescription>只编辑 SKILL.md。保存后生成新版本，正在进行的任务继续使用原版本。</DialogDescription>
          {!editor?.item && (
            <Input
              aria-label="技能名称"
              placeholder="my-skill"
              value={editor?.name ?? ''}
              onChange={(event) => {
                setEditor(
                  (value) =>
                    value && {
                      ...value,
                      name: event.target.value,
                      content: value.content.replace(/^name:.*$/m, `name: ${event.target.value}`),
                    },
                )
                setDirty(true)
              }}
            />
          )}
          <textarea
            aria-label="SKILL.md 正文"
            className="min-h-80 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm"
            value={editor?.content ?? ''}
            onChange={(event) => {
              setEditor((value) => value && { ...value, content: event.target.value })
              setDirty(true)
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditor(undefined)
                setDirty(false)
              }}
            >
              {dirty ? '丢弃修改' : '取消'}
            </Button>
            <Button
              disabled={busy || !editor || (!editor.item && !editor.name.trim())}
              onClick={() =>
                editor &&
                void action(async () => {
                  await client.saveSkill(
                    {
                      id: editor.item?.id,
                      revision: editor.item?.revision,
                      name: editor.item ? undefined : editor.name.trim(),
                      content: editor.content,
                    },
                    cwd,
                  )
                  setEditor(undefined)
                  setDirty(false)
                })
              }
            >
              保存
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>卸载技能？</DialogTitle>
          <DialogDescription>移除设备上的技能文件；已有聊天记录和正在使用的旧版本保留。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(undefined)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                removing &&
                void action(async () => {
                  await client.remove(removing.id, cwd)
                  setRemoving(undefined)
                  setSelected(undefined)
                })
              }
            >
              卸载
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
