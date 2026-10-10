import { useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Cpu,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'

const groups = [
  {
    label: '偏好设置',
    sections: [
      { id: 'general', label: '常规', icon: Settings, description: '查看当前 Host 的 Pi 运行时。' },
      { id: 'profile', label: '个人资料', icon: UserRound, description: '查看 Token 用量与活动记录。' },
      { id: 'appearance', label: '外观', icon: Palette, description: '调整主题、颜色、字体和界面效果。' },
      { id: 'personalization', label: '个性化', icon: SlidersHorizontal, description: '配置 Pi 指令与访问权限。' },
    ],
  },
  {
    label: 'Agent',
    sections: [
      { id: 'models', label: '模型', icon: Cpu, description: '管理服务商、接口和模型参数。' },
      { id: 'mcp', label: 'MCP', icon: Settings, description: '管理 Host MCP 服务和连接诊断。' },
      { id: 'access', label: '访问权限', icon: ShieldCheck, description: '设置新会话默认的文件访问权限。' },
      { id: 'subagents', label: 'SubAgent', icon: UsersRound, description: '管理 Host SubAgent 定义和启用状态。' },
      { id: 'tools', label: '工具执行', icon: Settings, description: '配置 Agent 的 codemode 工具调用。' },
      { id: 'extensions', label: '扩展', icon: Settings, description: '管理 Host 资源目录中的扩展。' },
    ],
  },
  {
    label: '集成',
    sections: [
      { id: 'host', label: 'Host 连接', icon: Server, description: '查看当前连接，或连接其他 Host。' },
      { id: 'plugins', label: '插件', icon: Puzzle, description: '管理当前 Host 已安装的插件。' },
      { id: 'skills', label: '技能', icon: BookOpen, description: '查看当前项目中 Pi 已加载的技能。' },
      { id: 'plugin-settings', label: '插件设置', icon: Settings, description: '查看插件提供的设置。' },
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
  const [sectionId, setSectionId] = useState<SettingsSection>('general')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<(() => void) | null>(null)
  const section = sections.find((entry) => entry.id === sectionId)!
  const catalog = sectionId === 'plugins' || sectionId === 'skills'

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
        <aside className="appearance-sidebar w-48 shrink-0 overflow-y-auto border-r border-border bg-card/50 px-3 py-7 sm:w-64">
          <h1 className="px-3 text-xl font-semibold">设置</h1>
          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input
              aria-label="搜索设置"
              placeholder="搜索设置"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 rounded-full border-0 bg-secondary/70 pl-9"
            />
          </div>
          <nav aria-label="设置分类" className="mt-6 space-y-6">
            {groups.map((group) => {
              const matches = group.sections.filter((entry) =>
                `${entry.label} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()),
              )
              return matches.length ? (
                <section key={group.label} aria-label={group.label}>
                  <h2 className="mb-2 px-3 text-xs font-medium text-muted-foreground">{group.label}</h2>
                  <div className="space-y-1">
                    {matches.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        aria-current={sectionId === id ? 'page' : undefined}
                        aria-controls="settings-content"
                        disabled={saving}
                        onClick={() => navigate(id)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                          sectionId === id
                            ? 'bg-secondary font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4 shrink-0" />
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null
            })}
          </nav>
        </aside>
        <div id="settings-content" className="min-w-0 flex-1 overflow-y-auto px-6 py-10 lg:px-12 lg:py-14">
          <div className={cn('mx-auto space-y-8', catalog ? 'max-w-6xl' : 'max-w-3xl')}>
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">{section.label}</h2>
              <p className="mt-3 text-sm text-muted-foreground">{section.description}</p>
            </div>
            {renderContent(sectionId, navigate)}
          </div>
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
