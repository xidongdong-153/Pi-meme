import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, FileText, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ModelsBridge, SettingsBridge } from '@pi-meme/contracts/desktop'
import type { InstructionFile, InstructionKind, InstructionsSnapshot } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'

const titles: Record<InstructionKind, { title: string; description: string }> = {
  agents: { title: 'Pi 指令', description: '配置语言、回复风格与长期工作约定。' },
  'append-system': { title: '追加系统指令', description: '在 Pi 默认系统提示词之后添加指令。' },
  system: { title: '系统提示词', description: '替换 Pi 默认系统提示词，项目同名文件优先。' },
}

export function PersonalizationSettings({
  bridge,
  cwd,
  busy,
  onDirty,
  onSaving,
  onAccess,
  advanced = false,
}: {
  bridge: Pick<SettingsBridge, 'getInstructions' | 'saveInstruction'> & Pick<ModelsBridge, 'reconnectModels'>
  cwd: string
  busy: boolean
  onDirty: (dirty: boolean) => void
  onSaving: (saving: boolean) => void
  advanced?: boolean
  onAccess: () => void
}) {
  const [snapshot, setSnapshot] = useState<InstructionsSnapshot | null>(null)
  const [selected, setSelected] = useState<{ kind: InstructionKind; project: boolean } | null>(null)
  const [base, setBase] = useState<InstructionFile | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [reloadError, setReloadError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<'discard' | 'remove' | 'refresh' | null>(null)
  const mounted = useRef(false)
  const dirty = Boolean(selected && !selected.project && base && draft !== base.content)

  useEffect(() => {
    mounted.current = true
    let active = true
    void bridge
      .getInstructions()
      .then((next) => {
        if (active) setSnapshot(next)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [bridge, cwd])
  useEffect(() => {
    onDirty(dirty)
    return () => onDirty(false)
  }, [dirty, onDirty])

  function edit(kind: InstructionKind, project: boolean, file: InstructionFile) {
    setSelected({ kind, project })
    setBase(file)
    setDraft(file.content)
    setError('')
    setNotice('')
  }

  async function refresh() {
    setError('')
    try {
      const next = await bridge.getInstructions()
      if (!mounted.current) return
      setSnapshot(next)
      const entry = next.entries.find((item) => item.kind === selected?.kind)
      const file = selected?.project ? entry?.project : entry?.host
      if (selected && file) edit(selected.kind, selected.project, file)
      else setSelected(null)
    } catch (cause) {
      if (mounted.current) setError(String(cause))
    }
  }

  async function save(remove = false) {
    if (!selected || selected.project || !base || saving || busy) return
    setSaving(true)
    onSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await bridge.saveInstruction({
        kind: selected.kind,
        content: remove ? null : draft,
        revision: base.revision,
      })
      if (!mounted.current) return
      setSnapshot(result.snapshot)
      setReloadError(result.reloadError ?? '')
      const file = result.snapshot.entries.find((entry) => entry.kind === selected.kind)!.host
      setBase(file)
      setDraft(file.content)
      if (remove) setSelected(null)
      setNotice(result.reloadError ? '' : '已保存并重新加载指令。')
    } catch (cause) {
      if (mounted.current) setError(String(cause))
    } finally {
      setSaving(false)
      onSaving(false)
    }
  }

  async function retryReload() {
    setSaving(true)
    onSaving(true)
    try {
      await bridge.reconnectModels()
      setReloadError('')
      setNotice('已重新加载指令。')
    } catch (cause) {
      setReloadError(`指令已保存，重载失败：${String(cause)}`)
    } finally {
      setSaving(false)
      onSaving(false)
    }
  }

  const entry = snapshot?.entries.find((item) => item.kind === selected?.kind)
  return (
    <div className="space-y-8" aria-busy={saving}>
      {error && (
        <div role="alert" className="space-y-2 rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => (dirty ? setConfirmation('refresh') : void refresh())}
          >
            重新读取
          </Button>
        </div>
      )}
      {reloadError && (
        <div role="alert" className="space-y-3 rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          <p>{reloadError}</p>
          <Button variant="outline" size="sm" disabled={saving || busy} onClick={() => void retryReload()}>
            <RefreshCw />
            重新加载
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {selected && base ? (
        <section aria-label="指令编辑器" className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => (dirty ? setConfirmation('discard') : setSelected(null))}
            >
              <ArrowLeft />
              返回
            </Button>
            {!selected.project && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={saving}
                  onClick={() => (dirty ? setConfirmation('discard') : setSelected(null))}
                >
                  取消
                </Button>
                <Button disabled={!dirty || busy || saving} onClick={() => void save()}>
                  {saving ? '正在保存…' : '保存'}
                </Button>
              </div>
            )}
          </div>
          <div>
            <h3 className="text-2xl font-semibold">
              {titles[selected.kind].title}
              {selected.project ? ' · 项目' : ''}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {titles[selected.kind].description}
              {selected.project ? ' 项目文件只读。' : ' 保存时要求所有会话空闲。'}
            </p>
            <p className="mt-3 break-all font-mono text-xs text-muted-foreground">{base.path}</p>
          </div>
          {entry?.project && !selected.project && (
            <p className="text-sm text-muted-foreground">
              {selected.kind === 'agents'
                ? 'Host 指令与项目指令共同加载。'
                : '当前项目使用项目同名文件，此 Host 配置不会替换项目指令。'}
            </p>
          )}
          <Textarea
            aria-label="指令正文"
            value={draft}
            readOnly={selected.project}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-80 resize-y rounded-2xl bg-card p-5 font-mono text-sm leading-7 select-text"
          />
          {!selected.project && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                保存空文本会保留空文件。移除文件后按 Pi 原有规则选择指令。
              </p>
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={!base.exists || busy || saving}
                onClick={() => setConfirmation('remove')}
              >
                移除此文件
              </Button>
            </div>
          )}
          {busy && !selected.project && (
            <p role="status" className="text-sm text-muted-foreground">
              有会话正在运行，请等会话结束或停止后再保存。
            </p>
          )}
        </section>
      ) : (
        <>
          {!advanced && (
            <section className="space-y-4">
              <h3 className="text-sm font-medium">访问权限</h3>
              <button
                type="button"
                aria-label="默认访问权限"
                onClick={onAccess}
                className="flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:bg-secondary/60"
              >
                <ShieldCheck className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">默认访问权限</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    设置新会话的只读、工作区写入或完全访问权限。
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </section>
          )}
          <section className="space-y-4">
            <h3 className="text-sm font-medium">{advanced ? '高级指令' : '自定义指令'}</h3>
            {!snapshot && !error && (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取指令…
              </p>
            )}
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {snapshot?.entries
                .filter((item) => (advanced ? item.kind !== 'agents' : item.kind === 'agents'))
                .map((item) => (
                  <div key={item.kind} className="p-5">
                    <button
                      type="button"
                      aria-label={`编辑指令：${item.kind}`}
                      onClick={() => edit(item.kind, false, item.host)}
                      className="flex w-full items-center gap-4 text-left"
                    >
                      <FileText className="size-5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{titles[item.kind].title}</span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          {titles[item.kind].description}
                        </span>
                        <span className="mt-2 block break-all font-mono text-xs text-muted-foreground">
                          {item.host.path}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.host.exists ? '已配置' : '未配置'}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                    {item.project && (
                      <div className="ml-9 mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>{item.effective === 'combined' ? '同时加载项目指令' : '当前使用项目指令'}</span>
                        <Button size="xs" variant="ghost" onClick={() => edit(item.kind, true, item.project!)}>
                          查看项目文件
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </section>
        </>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <DialogContent>
          <DialogTitle>{confirmation === 'remove' ? '移除此指令文件？' : '丢弃未保存的指令？'}</DialogTitle>
          <DialogDescription>
            {confirmation === 'remove'
              ? '只移除当前 Host 的文件，项目文件保持不变；其他适用的指令仍会加载。'
              : '当前修改不会保存。'}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const action = confirmation
                setConfirmation(null)
                if (action === 'remove') void save(true)
                else if (action === 'refresh') void refresh()
                else {
                  setDraft(base?.content ?? '')
                  setSelected(null)
                }
              }}
            >
              {confirmation === 'remove' ? '移除文件' : '丢弃修改'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
