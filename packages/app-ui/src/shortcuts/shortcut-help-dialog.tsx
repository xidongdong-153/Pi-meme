import { useMemo, useRef, useState } from 'react'
import { Search, Settings } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Button } from '@pi-meme/ui/components/ui/button'
import { formatKeybindingDisplay } from '@pi-meme/contracts/keyboard-shortcuts'
import { useShortcuts } from './shortcut-provider'
import { ShortcutKeycap } from './shortcut-keycap'
import { READONLY_EDITING_SHORTCUTS, SHORTCUT_GROUPS, SHORTCUT_META_MAP } from './constants'

export function ShortcutHelpDialog({
  open,
  onOpenChange,
  onEdit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit?: () => void
}) {
  const { binding, platform } = useShortcuts()
  const [query, setQuery] = useState('')
  const composing = useRef(false)
  const pendingEdit = useRef(false)

  const search = query.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    return SHORTCUT_GROUPS.map((group) => {
      const items = group.items.filter((item) => {
        const meta = SHORTCUT_META_MAP[item.id]
        const bound = binding(item.id)
        const display = bound ? formatKeybindingDisplay(bound, platform) : '未绑定'
        const raw = bound ?? ''
        const text = `${meta.title} ${meta.scope} ${group.label} ${raw} ${display}`.toLowerCase()
        return text.includes(search)
      })
      return { ...group, items }
    }).filter((group) => group.items.length > 0)
  }, [binding, platform, search])

  const filteredEditing = useMemo(() => {
    return READONLY_EDITING_SHORTCUTS.filter((item) => {
      const display = item.keybinding.includes('Mod')
        ? formatKeybindingDisplay(item.keybinding, platform)
        : item.keybinding
      const text = `${item.title} ${item.description} 输入与编辑 ${item.keybinding} ${display}`.toLowerCase()
      return text.includes(search)
    })
  }, [platform, search])

  const hasResults = filteredGroups.length > 0 || filteredEditing.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-w-[680px] w-[calc(100vw-2rem)] max-h-[min(80vh,40rem)] flex-col gap-0 p-0 overflow-hidden"
        onEscapeKeyDown={(event) => {
          if (composing.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (pendingEdit.current) {
            pendingEdit.current = false
            event.preventDefault()
            onEdit?.()
          }
        }}
      >
        <DialogHeader className="p-4 pb-3 border-b border-border/60">
          <DialogTitle className="text-base font-semibold">键盘快捷键</DialogTitle>
          <div className="relative mt-2.5">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="搜索快捷键"
              placeholder="搜索快捷键"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
              className="h-9 rounded-lg border border-border/80 bg-secondary/50 pl-9 pr-3 text-xs focus-visible:bg-secondary/80"
              autoFocus
            />
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6">
          {!hasResults && (
            <p role="status" className="py-8 text-center text-xs text-muted-foreground">
              没有匹配的快捷键
            </p>
          )}

          {filteredGroups.map((group) => (
            <section key={group.id} aria-label={group.label} className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground select-none">{group.label}</h3>
              <div className="rounded-lg border border-border/60 divide-y divide-border/40 overflow-hidden bg-card/30">
                {group.items.map((item) => {
                  const meta = SHORTCUT_META_MAP[item.id]
                  const bound = binding(item.id)
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between px-3.5 py-2.5 text-xs hover:bg-secondary/40 transition-colors"
                    >
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="font-medium text-foreground">{meta.title}</div>
                        <div className="text-[11px] text-muted-foreground/75 mt-0.5">{meta.scope}</div>
                      </div>
                      <ShortcutKeycap binding={bound} platform={platform} />
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

          {filteredEditing.length > 0 && (
            <section aria-label="输入与编辑" className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground select-none">输入与编辑</h3>
              <div className="rounded-lg border border-border/60 divide-y divide-border/40 overflow-hidden bg-card/30">
                {filteredEditing.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between px-3.5 py-2.5 text-xs hover:bg-secondary/40 transition-colors"
                  >
                    <div className="min-w-0 flex-1 pr-3">
                      <div className="font-medium text-foreground">{item.title}</div>
                      <div className="text-[11px] text-muted-foreground/75 mt-0.5">{item.description}</div>
                    </div>
                    <ShortcutKeycap
                      binding={item.keybinding.includes('Mod') ? item.keybinding : item.keybinding}
                      platform={platform}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {onEdit && (
          <div className="flex items-center justify-between border-t border-border/60 bg-muted/20 px-5 py-3">
            <span className="text-xs text-muted-foreground">在设置中可自定义按键组合</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                pendingEdit.current = true
                onOpenChange(false)
              }}
              className="gap-1.5 text-xs"
            >
              <Settings className="size-3.5" />
              编辑快捷键
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
