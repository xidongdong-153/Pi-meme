import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, CodeXml, Copy, Plus, Puzzle, RefreshCw, Search, Upload } from 'lucide-react'
import type {
  ResourceCatalog,
  ResourceImportInput,
  ResourceItem,
  ResourceKind,
  ResourceSnapshot,
} from '@pi-meme/contracts/resources'
import type { BranchSkillUsage } from '@pi-meme/contracts/skills'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'

const kinds = { skill: '技能', extension: 'Pi 扩展', 'app-plugin': '应用插件' }
const scopes = { builtin: '应用自带', host: '此设备', project: '当前项目' }
const icons = { skill: BookOpen, extension: CodeXml, 'app-plugin': Puzzle }
const maxUploadBytes = 32 * 1024 * 1024

async function encodeFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(binary)
}

export function ResourceCenter({
  client,
  plugins,
  initialKind = 'all',
  cwd,
  commands,
  skillUsages = [],
  resourceSnapshot,
  onUse,
  onChanged,
  renderPluginSettings,
}: {
  client: ResourceClient
  plugins: PluginClient
  initialKind?: ResourceKind | 'all'
  cwd?: string
  commands: PiSlashCommand[]
  skillUsages?: BranchSkillUsage[]
  resourceSnapshot?: ResourceSnapshot
  onUse: (command: PiSlashCommand) => void
  onChanged: () => Promise<void>
  renderPluginSettings?: (id: string) => React.ReactNode
}) {
  const [appPlugins, setAppPlugins] = useState<UiPluginDescriptor[]>([])
  const [catalog, setCatalog] = useState<ResourceCatalog>()
  const [kind, setKind] = useState(initialKind)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [scope, setScope] = useState<'host' | 'project'>('host')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [removing, setRemoving] = useState<ResourceItem>()
  const [editor, setEditor] = useState<{ item?: ResourceItem; name: string; content: string }>()
  const [dirty, setDirty] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const directoryRef = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<{ id: string; revision: string } | undefined>(undefined)
  const request = useRef(0)
  const load = useCallback(async () => {
    const serial = ++request.current
    const [next, descriptors] = await Promise.all([client.catalog(cwd), plugins.list()])
    if (request.current === serial) {
      setCatalog(next)
      setAppPlugins(descriptors)
    }
  }, [client, cwd, plugins])
  useEffect(() => {
    void load().catch((cause) => setError(`无法读取资源：${String(cause)}`))
    const off = client.onChange(() => void load().catch((cause) => setError(String(cause))))
    directoryRef.current?.setAttribute('webkitdirectory', '')
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

  async function upload(files: FileList | null, directory = false) {
    if (!files?.length) return
    const replace = uploadTarget.current
    uploadTarget.current = undefined
    await action(async () => {
      const list = Array.from(files)
      if (list.reduce((size, file) => size + file.size, 0) > maxUploadBytes) throw new Error('上传内容不能超过 32 MiB')
      const first = list[0]!
      if (!directory && first.name.endsWith('.pim')) {
        if (replace) throw new Error('请选择与当前技能或扩展相同类型的文件')
        await plugins.installPackage(await encodeFile(first))
        return
      }
      let input: ResourceImportInput
      if (directory) {
        input = {
          files: await Promise.all(
            list.map(async (file) => ({
              path: file.webkitRelativePath.split('/').slice(1).join('/'),
              content: await encodeFile(file),
              encoding: 'base64' as const,
            })),
          ),
        }
      } else if (first.name.endsWith('.zip')) input = { archiveBase64: await encodeFile(first) }
      else if (/\.(?:ts|js|mjs)$/.test(first.name))
        input = {
          kind: 'extension',
          name: first.name.replace(/\.(?:ts|js|mjs)$/, ''),
          files: [{ path: first.name, content: await first.text() }],
        }
      else input = { kind: 'skill', content: await first.text() }
      await client.import({ ...input, ...(replace ? { replace } : {}) }, cwd)
    })
    if (uploadRef.current) uploadRef.current.value = ''
    if (directoryRef.current) directoryRef.current.value = ''
  }

  const items = catalog?.items ?? []
  const current = items.find((item) => item.id === selected)
  const filtered = items.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      `${item.name} ${item.displayName ?? ''} ${item.description ?? ''} ${item.owner.name ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  const extensionCommands =
    (current && commands.filter((entry) => entry.source === 'extension' && entry.sourceInfo.path === current.path)) ||
    []
  const included =
    (current && items.filter((item) => item.owner.id === current.owner.id && item.id !== current.id)) || []
  const activePolicy = current && (scope === 'host' ? current.hostPolicy : current.projectPolicy)
  const policyEnabled =
    scope === 'host' ? (current?.hostPolicy?.enabled ?? current?.defaultPolicy?.enabled ?? true) : current?.enabled
  const policyInvocation =
    scope === 'host'
      ? (current?.hostPolicy?.invocation ?? current?.defaultPolicy?.invocation ?? 'automatic')
      : current?.invocation
  const command = current && commands.find((entry) => entry.source === 'skill' && entry.resourceId === current.id)
  const currentUsages = skillUsages.filter((usage) => usage.id === current?.id)
  const pinned =
    current &&
    [
      ...(resourceSnapshot?.skills ?? []),
      ...(resourceSnapshot?.extensions ?? []),
      ...(resourceSnapshot?.appPlugins ?? []),
    ].find((item) => item.id === current.id)
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
    const plugin = item.kind === 'app-plugin' && appPlugins.find((entry) => entry.id === item.owner.id)
    if (plugin && plugin.status === 'failed') return '启用失败'
    if (plugin && plugin.status === 'pending') return '待生效'
    if (item.diagnostics.length) return '需要处理'
    if (item.shadowedBy) return '存在同名技能'
    if (!item.enabled) return '已停用'
    if (skillUsages.some((usage) => usage.id === item.id && !usage.inherited)) return '已读取'
    if (skillUsages.some((usage) => usage.id === item.id && usage.inherited)) return '继承读取记录'
    return item.kind === 'skill' && item.invocation === 'manual' ? '仅手动调用' : '已启用'
  }

  return (
    <section aria-label="资源中心" className="space-y-6" aria-busy={busy}>
      <input
        ref={uploadRef}
        hidden
        type="file"
        accept=".pim,.zip,.md,.ts,.js,.mjs"
        onChange={(event) => void upload(event.target.files)}
      />
      <input
        ref={directoryRef}
        hidden
        type="file"
        multiple
        onChange={(event) => void upload(event.target.files, true)}
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
            返回资源
          </Button>
          <div>
            <h3 className="text-xl font-semibold">{current.displayName ?? current.name}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {kinds[current.kind]} · {scopes[current.scope]} · {state(current)}
            </p>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-7">{current.description || '未提供说明'}</p>
          <dl className="grid gap-4 rounded-2xl border border-border p-5 text-sm">
            {Object.entries({
              ...(current.owner.type === 'pi-package' || current.owner.type === 'app-package'
                ? { 所属安装包: current.owner.name ?? current.owner.id }
                : {}),
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
          {included.length > 0 && (
            <p className="text-sm text-muted-foreground">
              包含内容：{included.map((item) => `${kinds[item.kind]} ${item.displayName ?? item.name}`).join('、')}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {pending
              ? '当前聊天仍使用原版本，任务结束后更新。'
              : command
                ? '可以在当前聊天中选择此技能。'
                : current.kind === 'skill'
                  ? '此技能暂不可用于当前聊天。'
                  : current.kind === 'app-plugin'
                    ? '应用插件可直接访问当前设备。聊天工具仍受当前权限设置限制。'
                    : 'Pi 扩展需要完全访问权限；执行脚本时仍遵守当前聊天的权限设置。'}
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
          {current.kind === 'app-plugin' && appPlugins.find((plugin) => plugin.id === current.owner.id)?.error && (
            <p role="alert" className="text-sm text-destructive">
              {appPlugins.find((plugin) => plugin.id === current.owner.id)?.error}
            </p>
          )}
          {current.diagnostics.map((message) => (
            <p key={message} role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="资源策略范围"
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
                void action(() =>
                  current.kind === 'app-plugin' && scope === 'host'
                    ? appPlugins.find((plugin) => plugin.id === current.owner.id)?.enabled
                      ? plugins.disable(current.owner.id)
                      : plugins.enable(current.owner.id)
                    : client.setPolicy({ id: current.id, scope, cwd, enabled: !policyEnabled }),
                )
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
            {extensionCommands.map((entry) => (
              <Button
                key={entry.name}
                variant="outline"
                disabled={busy || !current.enabled}
                onClick={() => onUse(entry)}
              >
                插入 /{entry.name}
              </Button>
            ))}
            {current.kind === 'skill' && (
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
            )}
            {current.scope === 'host' &&
              (current.owner.type === 'loose' ||
                current.owner.type === 'pi-package' ||
                current.kind === 'app-plugin') && (
                <>
                  {current.kind !== 'app-plugin' && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          uploadTarget.current = { id: current.id, revision: current.revision }
                          uploadRef.current?.click()
                        }}
                      >
                        更新{current.owner.type === 'pi-package' ? '安装包' : '文件'}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          uploadTarget.current = { id: current.id, revision: current.revision }
                          directoryRef.current?.click()
                        }}
                      >
                        更新{current.owner.type === 'pi-package' ? '安装包' : ''}文件夹
                      </Button>
                    </>
                  )}
                  <Button variant="outline" disabled={busy} onClick={() => setRemoving(current)}>
                    卸载{current.owner.type === 'pi-package' ? '安装包' : ''}
                  </Button>
                </>
              )}
          </div>
          {current.kind === 'app-plugin' && renderPluginSettings?.(current.owner.id)}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative mr-auto w-full max-w-sm">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="搜索资源"
                placeholder="搜索技能与扩展"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="重新扫描资源"
              disabled={busy}
              onClick={() => void action(() => client.refresh(cwd))}
            >
              <RefreshCw className={cn(busy && 'animate-spin')} />
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void edit()}>
              <Plus />
              新建技能
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                uploadTarget.current = undefined
                uploadRef.current?.click()
              }}
            >
              <Upload />
              上传文件
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                uploadTarget.current = undefined
                directoryRef.current?.click()
              }}
            >
              上传文件夹
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setImportOpen(true)}>
              从设备文件夹导入
            </Button>
          </div>
          <div className="flex flex-wrap gap-1" aria-label="资源类型">
            {(['all', 'skill', 'extension', 'app-plugin'] as const).map((value) => (
              <Button
                key={value}
                variant={kind === value ? 'secondary' : 'ghost'}
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {value === 'all' ? '全部' : kinds[value]}
              </Button>
            ))}
          </div>
          {!catalog ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取技能与扩展…
            </p>
          ) : (
            <ul className="grid gap-2 lg:grid-cols-2" aria-label="技能与扩展">
              {filtered.map((item) => {
                const Icon = icons[item.kind]
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-label={`查看资源：${item.name}`}
                      onClick={() => {
                        setSelected(item.id)
                        setScope(item.scope === 'project' ? 'project' : 'host')
                      }}
                      className="flex min-h-24 w-full items-center gap-4 rounded-2xl border border-border p-4 text-left hover:bg-secondary/50"
                    >
                      {item.kind === 'app-plugin' &&
                      appPlugins.find((plugin) => plugin.id === item.owner.id)?.iconUrl ? (
                        <img
                          src={appPlugins.find((plugin) => plugin.id === item.owner.id)!.iconUrl}
                          alt=""
                          className="size-6 shrink-0 object-contain"
                        />
                      ) : (
                        <Icon className="size-6 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{item.displayName ?? item.name}</span>
                        <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {item.shortDescription ?? item.description ?? '未提供说明'}
                        </span>
                        <span className="mt-2 block text-xs text-muted-foreground">
                          {kinds[item.kind]} · {scopes[item.scope]} · {state(item)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {catalog && !filtered.length && (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              没有匹配的资源。
            </p>
          )}
        </>
      )}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogTitle>从设备文件夹导入</DialogTitle>
          <DialogDescription>
            输入当前连接设备上的技能或扩展文件夹路径。远程连接时，请填写远程设备上的路径。
          </DialogDescription>
          <Input
            aria-label="技能或扩展文件夹"
            value={sourcePath}
            onChange={(event) => setSourcePath(event.target.value)}
            placeholder="/absolute/path/to/resource"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !sourcePath.trim()}
              onClick={() =>
                void action(async () => {
                  await client.import({ path: sourcePath.trim() }, cwd)
                  setImportOpen(false)
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
          <DialogTitle>卸载资源？</DialogTitle>
          <DialogDescription>
            同一安装包中的内容会一起移除。聊天记录、旧版本和插件数据保留，正在进行的任务结束后生效。
          </DialogDescription>
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
                  if (removing.kind === 'app-plugin') await plugins.remove(removing.owner.id)
                  else await client.remove(removing.id, cwd)
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
