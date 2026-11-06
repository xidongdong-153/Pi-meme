import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, FileText, RefreshCw } from 'lucide-react'
import type { ModelsBridge, SettingsBridge } from '@pi-meme/contracts/desktop'
import type { InstructionFile, InstructionKind, InstructionsSnapshot } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { SettingsCard, SettingsGroup, settingsControlClassName } from '@pi-meme/ui/components/settings'

const titles: Record<InstructionKind, { title: string; description: string; file: string }> = {
  agents: { title: '用户指令', description: '配置语言、回复风格与长期工作约定。', file: 'AGENTS.md' },
  system: { title: '系统提示词', description: '替换 Pi 默认系统提示词，项目同名文件优先。', file: 'SYSTEM.md' },
  'append-system': {
    title: '追加系统指令',
    description: '在 Pi 默认系统提示词之后添加指令。',
    file: 'APPEND_SYSTEM.md',
  },
}

const groups: { label: string; kinds: InstructionKind[] }[] = [
  { label: '用户', kinds: ['agents'] },
  { label: '系统', kinds: ['system', 'append-system'] },
]

function fileName(filePath: string, fallback: string) {
  return filePath.split(/[/\\]/).pop() || fallback
}

export function InstructionSettings({
  bridge,
  cwd,
  busy,
  onDirty,
  onSaving,
}: {
  bridge: Pick<SettingsBridge, 'getInstructions' | 'saveInstruction'> & Pick<ModelsBridge, 'reconnectModels'>
  cwd: string
  busy: boolean
  onDirty: (dirty: boolean) => void
  onSaving: (saving: boolean) => void
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
    <div className="space-y-6" aria-busy={saving}>
      {error && (
        <div role="alert" className="space-y-2 rounded-xl bg-destructive/10 p-4 text-xs text-destructive">
          <p>{error}</p>
          <Button
            className={settingsControlClassName}
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
        <div role="alert" className="space-y-3 rounded-xl bg-destructive/10 p-4 text-xs text-destructive">
          <p>{reloadError}</p>
          <Button
            className={settingsControlClassName}
            variant="outline"
            size="sm"
            disabled={saving || busy}
            onClick={() => void retryReload()}
          >
            <RefreshCw />
            重新加载
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {selected && base ? (
        <section aria-label="指令编辑器" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              className={settingsControlClassName}
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
                  className={settingsControlClassName}
                  variant="secondary"
                  disabled={saving}
                  onClick={() => (dirty ? setConfirmation('discard') : setSelected(null))}
                >
                  取消
                </Button>
                <Button
                  className={settingsControlClassName}
                  disabled={!dirty || busy || saving}
                  onClick={() => void save()}
                >
                  {saving ? '正在保存…' : '保存'}
                </Button>
              </div>
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground">
              {titles[selected.kind].title}
              {selected.project ? ' · 项目' : ''}
            </h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {titles[selected.kind].description}
              {selected.project ? ' 项目文件只读。' : ' 保存时要求所有会话空闲。'}
            </p>
          </div>
          {entry?.project && !selected.project && (
            <p className="text-[11px] text-muted-foreground">
              {selected.kind === 'agents' ? '用户指令与项目指令共同生效。' : '项目已有同名指令，优先使用项目配置。'}
            </p>
          )}
          <Textarea
            aria-label="指令正文"
            value={draft}
            readOnly={selected.project}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-80 resize-y rounded-xl border-border/70 bg-card/40 px-4 py-3 font-mono text-sm leading-7 shadow-none select-text"
          />
          {!selected.project && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                保存空文本会保留空文件。移除文件后按 Pi 原有规则选择指令。
              </p>
              <Button
                variant="ghost"
                className={`${settingsControlClassName} text-destructive`}
                disabled={!base.exists || busy || saving}
                onClick={() => setConfirmation('remove')}
              >
                移除此文件
              </Button>
            </div>
          )}
          {busy && !selected.project && (
            <p role="status" className="text-xs text-muted-foreground">
              有会话正在运行，请等会话结束或停止后再保存。
            </p>
          )}
        </section>
      ) : (
        <>
          {groups.map((group) => (
            <SettingsGroup key={group.label} title={group.label}>
              <SettingsCard>
                {group.kinds.map((kind) => {
                  const item = snapshot?.entries.find((entry) => entry.kind === kind)
                  return (
                    <div key={kind} className="px-4 py-3">
                      <button
                        type="button"
                        aria-label={`编辑指令：${kind}`}
                        disabled={!item}
                        onClick={() => item && edit(kind, false, item.host)}
                        className="flex w-full items-center gap-3 rounded-sm text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-2">
                            <span className="font-medium">{titles[kind].title}</span>
                            <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                              <CrossfadeText>
                                {item ? fileName(item.host.path, titles[kind].file) : titles[kind].file}
                              </CrossfadeText>
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {titles[kind].description}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          <CrossfadeText
                            reserve={['正在读取…', '已配置', '未配置', '读取失败']}
                            className="text-right"
                            textClassName="whitespace-nowrap"
                          >
                            {item ? (item.host.exists ? '已配置' : '未配置') : error ? '读取失败' : '正在读取…'}
                          </CrossfadeText>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                      <RevealContent ready={Boolean(item?.project)}>
                        {item?.project && (
                          <div className="ml-7 mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span>{item.effective === 'combined' ? '同时加载项目指令' : '当前使用项目指令'}</span>
                            <Button
                              className={settingsControlClassName}
                              size="xs"
                              variant="ghost"
                              onClick={() => edit(item.kind, true, item.project!)}
                            >
                              查看项目文件
                            </Button>
                          </div>
                        )}
                      </RevealContent>
                    </div>
                  )
                })}
              </SettingsCard>
            </SettingsGroup>
          ))}
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
            {confirmation === 'remove' ? '仅删除此用户指令，项目指令不受影响。' : '当前修改不会保存。'}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button className={settingsControlClassName} variant="outline" onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              className={settingsControlClassName}
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
