import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Ban, RotateCcw, Search } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import {
  defaultKeybinding,
  formatKeybindingDisplay,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingFromEvent,
  resolveKeybinding,
  SHORTCUT_DEFINITIONS,
  type ShortcutDefinition,
  type ShortcutId,
} from '@pi-meme/contracts/keyboard-shortcuts'
import { cn } from '@pi-meme/ui/lib/utils'
import { useShortcuts } from './shortcut-provider'
import { ShortcutKeycap } from './shortcut-keycap'
import { SHORTCUT_GROUPS, SHORTCUT_META_MAP } from './constants'

export function ShortcutSettings() {
  const { preferences, platform, environment, saving, save, error: globalError } = useShortcuts()
  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [rowError, setRowError] = useState<{ id: ShortcutId; message: string } | null>(null)
  const [resetAllOpen, setResetAllOpen] = useState(false)

  const overrides = preferences.overrides ?? {}
  const hasOverrides = Object.keys(overrides).length > 0

  const search = query.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    return SHORTCUT_GROUPS.map((group) => {
      const items = group.items.filter((item) => {
        const meta = SHORTCUT_META_MAP[item.id]
        const bound = resolveKeybinding(item, overrides, environment)
        const display = bound ? formatKeybindingDisplay(bound, platform) : '未绑定'
        const raw = bound ?? ''
        const text = `${meta.title} ${meta.scope} ${group.label} ${raw} ${display}`.toLowerCase()
        return text.includes(search)
      })
      return { ...group, items }
    }).filter((group) => group.items.length > 0)
  }, [overrides, environment, platform, search])

  const storeBinding = async (
    shortcut: ShortcutDefinition,
    newBinding: string | null,
    mode: 'bind' | 'unbind' | 'reset' = 'bind',
  ) => {
    const next = { ...overrides }
    if (mode === 'reset') {
      delete next[shortcut.id]
    } else if (mode === 'unbind') {
      next[shortcut.id] = null
    } else if (!newBinding || newBinding === defaultKeybinding(shortcut, environment)) {
      delete next[shortcut.id]
    } else {
      next[shortcut.id] = newBinding
    }

    // Conflict check
    const resolvedTarget = resolveKeybinding(shortcut, next, environment)
    if (resolvedTarget !== null) {
      const conflict = SHORTCUT_DEFINITIONS.find(
        (candidate) =>
          candidate.id !== shortcut.id && resolveKeybinding(candidate, next, environment) === resolvedTarget,
      )
      if (conflict) {
        setRowError({
          id: shortcut.id,
          message: `已用于：${SHORTCUT_META_MAP[conflict.id]?.title || conflict.id}`,
        })
        return
      }
    }

    setRowError(null)
    try {
      await save(next)
      setRecordingId(null)
    } catch (cause) {
      setRowError({
        id: shortcut.id,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const handleRecordKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, shortcut: ShortcutDefinition) => {
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      setRecordingId(null)
      setRowError(null)
      return
    }

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
      return
    }

    const nextBinding = keybindingFromEvent(event.nativeEvent, platform)
    if (!nextBinding || !isAllowedKeybinding(nextBinding)) {
      setRowError({ id: shortcut.id, message: '快捷键必须包含修饰键与非修饰键' })
      return
    }

    if (isReservedKeybinding(nextBinding, platform, environment)) {
      setRowError({ id: shortcut.id, message: '该快捷键为系统或浏览器保留，请更换' })
      return
    }

    void storeBinding(shortcut, nextBinding, 'bind')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            自定义当前客户端中的快捷键绑定。设置仅保存在本地设备（
            {environment === 'desktop' ? 'Desktop 应用' : '当前浏览器'}
            ），不影响执行 Host 或其他设备。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasOverrides || saving}
          onClick={() => setResetAllOpen(true)}
          className="gap-1.5 text-xs h-8"
        >
          <RotateCcw className="size-3.5" />
          恢复全部默认
        </Button>
      </div>

      {globalError && (
        <p role="alert" className="text-xs text-destructive">
          {globalError}
        </p>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="搜索快捷键设置"
          placeholder="搜索快捷键"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 rounded-lg border border-border/80 bg-secondary/50 pl-9 pr-3 text-xs focus-visible:bg-secondary/80"
        />
      </div>

      <div className="space-y-6">
        {filteredGroups.length === 0 && (
          <p role="status" className="py-8 text-center text-xs text-muted-foreground">
            没有匹配的快捷键
          </p>
        )}

        {filteredGroups.map((group) => (
          <section key={group.id} aria-label={group.label} className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground select-none">{group.label}</h3>
            <div className="rounded-xl border border-border/70 divide-y divide-border/40 overflow-hidden bg-card/40">
              {group.items.map((shortcut) => {
                const meta = SHORTCUT_META_MAP[shortcut.id]
                const bound = resolveKeybinding(shortcut, overrides, environment)
                const isCustomized = Object.hasOwn(overrides, shortcut.id)
                const isUnbound = isCustomized && overrides[shortcut.id] === null
                const isRecording = recordingId === shortcut.id
                const error = rowError?.id === shortcut.id ? rowError.message : null

                return (
                  <div
                    key={shortcut.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="font-medium text-foreground">{meta.title}</div>
                      <div className="text-[11px] text-muted-foreground/75 mt-0.5">{meta.scope}</div>
                      {error && (
                        <div role="alert" className="text-[11px] text-destructive mt-1">
                          {error}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-shortcut-recording={isRecording ? 'true' : undefined}
                        aria-label={`修改快捷键：${meta.title}`}
                        disabled={saving}
                        onClick={() => {
                          setRowError(null)
                          setRecordingId(shortcut.id)
                        }}
                        onBlur={() => {
                          if (recordingId === shortcut.id) setRecordingId(null)
                        }}
                        onKeyDown={isRecording ? (e) => handleRecordKeyDown(e, shortcut) : undefined}
                        className={cn(
                          'inline-flex min-w-[90px] h-7 items-center justify-center rounded-lg border px-2.5 transition-all outline-none cursor-pointer select-none',
                          isRecording
                            ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/20 animate-pulse'
                            : 'border-border/80 bg-secondary/60 hover:bg-secondary hover:border-border text-foreground',
                        )}
                      >
                        {isRecording ? (
                          <span className="text-[11px] font-medium">请按下快捷键</span>
                        ) : (
                          <ShortcutKeycap binding={bound} platform={platform} />
                        )}
                      </button>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`取消绑定：${meta.title}`}
                            disabled={isUnbound || saving}
                            onClick={() => void storeBinding(shortcut, null, 'unbind')}
                            className="size-7 text-muted-foreground hover:text-foreground"
                          >
                            <Ban className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">取消快捷键</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`恢复默认：${meta.title}`}
                            disabled={!isCustomized || saving}
                            onClick={() => void storeBinding(shortcut, null, 'reset')}
                            className="size-7 text-muted-foreground hover:text-foreground"
                          >
                            <RotateCcw className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">恢复默认</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <Dialog open={resetAllOpen} onOpenChange={setResetAllOpen}>
        <DialogContent>
          <DialogTitle>恢复全部默认快捷键？</DialogTitle>
          <DialogDescription>离开自定义设置后，所有快捷键将还原为系统推荐的默认值。</DialogDescription>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setResetAllOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setRecordingId(null)
                setRowError(null)
                void save({})
                setResetAllOpen(false)
              }}
            >
              确认恢复默认
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
