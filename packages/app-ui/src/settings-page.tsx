import { useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  ChartNoAxesCombined,
  Info,
  Network,
  Palette,
  Puzzle,
  ScrollText,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import { FadeContent } from '@pi-meme/ui/components/fade-content'
import { cn } from '@pi-meme/ui/lib/utils'

const groups = [
  {
    label: '个人',
    sections: [
      { id: 'appearance', label: '外观', icon: Palette, description: '调整主题、字号和界面效果。' },
      {
        id: 'personalization',
        label: '偏好',
        icon: SlidersHorizontal,
        description: '设置新会话的默认访问权限。',
      },
      { id: 'profile', label: '用量', icon: ChartNoAxesCombined, description: '查看 Token 用量与活动记录。' },
    ],
  },
  {
    label: 'Agent',
    sections: [
      { id: 'models', label: '模型', icon: Sparkles, description: '连接服务商并选择默认模型。' },
      { id: 'instructions', label: '指令', icon: ScrollText, description: '编辑用户指令和系统提示词。' },
      { id: 'skills', label: '技能', icon: BookOpen, description: '导入、创建和编辑技能，设置设备或项目的调用方式。' },
      { id: 'plugins', label: '插件', icon: Puzzle, description: '安装和更新 App 插件，查看能力并启停或卸载。' },
      { id: 'mcp', label: 'MCP', icon: Network, description: '管理 MCP 服务和授权。' },
    ],
  },
  {
    label: '系统',
    sections: [
      { id: 'host', label: '远程', icon: Server, description: '添加、重试或移除远程服务。' },
      { id: 'general', label: '关于', icon: Info, description: '查看当前执行服务的 Pi 运行时。' },
    ],
  },
] as const
type Section = (typeof groups)[number]['sections'][number]
export type SettingsSection = Section['id']
const sections = groups.flatMap<Section>((group) => group.sections)

export function SettingsPage({
  renderContent,
  dirty,
  saving,
  onDiscard,
  onDismiss,
}: {
  renderContent: (section: SettingsSection, navigate: (section: SettingsSection) => void) => ReactNode
  dirty: boolean
  saving: boolean
  onDiscard: () => void
  onDismiss: () => void
}) {
  const [sectionId, setSectionId] = useState<SettingsSection>('models')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<(() => void) | null>(null)
  const section = sections.find((entry) => entry.id === sectionId)!
  const catalog = sectionId === 'plugins' || sectionId === 'skills' || sectionId === 'mcp'
  const search = query.trim().toLowerCase()
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((entry) =>
        `${entry.label} ${entry.description} ${entry.id}`.toLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.sections.length > 0)

  function leave(action: () => void) {
    if (saving) return
    if (dirty) setPending(() => action)
    else action()
  }

  function navigate(id: SettingsSection) {
    if (id !== sectionId) leave(() => setSectionId(id))
  }

  return (
    <section aria-label="设置页面" className="flex min-h-0 flex-1 flex-col">
      <header className="window-drag flex h-10 shrink-0 items-center border-b border-border/70 pl-24 pr-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => leave(onDismiss)}
          disabled={saving}
          autoFocus
          className="no-drag text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          返回聊天
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="appearance-sidebar settings-sidebar w-48 shrink-0 overflow-y-auto border-r border-border bg-card/50 px-3 py-7 sm:w-64">
          <h1 className="px-3 text-xl font-semibold">设置</h1>
          <div className="relative mt-5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-3 size-4 text-muted-foreground"
              strokeWidth={1.7}
            />
            <Input
              aria-label="搜索设置"
              placeholder="搜索设置"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 rounded-full border-0 bg-secondary/70 pl-10 transition-colors duration-200 focus-visible:bg-secondary"
            />
          </div>
          <nav aria-label="设置分类" className="mt-6 space-y-6">
            {visibleGroups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="mb-2 px-3 text-xs font-medium text-muted-foreground/75">{group.label}</h2>
                <div className="space-y-0.5">
                  {group.sections.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      aria-current={sectionId === id ? 'page' : undefined}
                      aria-controls="settings-content"
                      disabled={saving}
                      onClick={() => navigate(id)}
                      className={cn(
                        'settings-nav-item flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                        sectionId === id
                          ? 'bg-secondary font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    >
                      <span className="settings-nav-icon flex size-5 shrink-0 items-center justify-center">
                        <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.7} />
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {visibleGroups.length === 0 && (
              <p role="status" className="px-3 text-sm text-muted-foreground">
                没有匹配的设置
              </p>
            )}
          </nav>
        </aside>
        <div id="settings-content" className="min-w-0 flex-1 overflow-y-auto px-6 py-10 lg:px-12 lg:py-14">
          <FadeContent key={sectionId} className={cn('mx-auto space-y-8', catalog ? 'max-w-6xl' : 'max-w-3xl')}>
            {!catalog && (
              <div>
                <h2 className="text-3xl font-semibold tracking-tight">{section.label}</h2>
                <p className="mt-3 text-sm text-muted-foreground">{section.description}</p>
              </div>
            )}
            {renderContent(sectionId, navigate)}
          </FadeContent>
        </div>
      </div>
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <DialogContent>
          <DialogTitle>丢弃未保存的指令？</DialogTitle>
          <DialogDescription>离开后，当前修改不会保存。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPending(null)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                onDiscard()
                pending?.()
                setPending(null)
              }}
            >
              丢弃修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
