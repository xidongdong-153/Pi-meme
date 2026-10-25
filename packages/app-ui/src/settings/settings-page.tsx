import { Suspense, useState, type ReactNode } from 'react'
import {
  Globe,
  BookOpen,
  ChartNoAxesCombined,
  Circle,
  Info,
  Keyboard,
  Network,
  Palette,
  Plug,
  ScrollText,
  Search,
  Server,
  Settings,
  Sparkles,
  User,
  Users,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@pi-meme/ui/components/ui/dialog'
import { FadeContent } from '@pi-meme/ui/components/fade-content'
import { cn } from '@pi-meme/ui/lib/utils'
import { PageHeader, PageHeaderNavigation } from '../layout/page-header'
import { SettingsSkeleton } from './settings-skeleton'

function PluginSettingsIcon({ className, strokeWidth }: { className?: string; strokeWidth?: number }) {
  return (
    <span className={cn('relative', className)} aria-hidden="true">
      <Circle className="size-full" strokeWidth={strokeWidth} />
      <Plug className="absolute inset-[18.75%] size-[62.5%] -rotate-45" strokeWidth={strokeWidth} />
    </span>
  )
}

const groups = [
  {
    label: '个人',
    sections: [
      {
        id: 'general',
        label: '常规',
        icon: Settings,
        description: '设置输入预测、上下文用量显示、默认访问权限、应用存储目录和缓存清理。',
      },
      {
        id: 'shortcuts',
        label: '快捷键',
        icon: Keyboard,
        description: '查看和修改当前客户端的键盘快捷键。',
      },
      {
        id: 'account',
        label: '个人资料',
        icon: User,
        description: '查看并管理个人账户信息与显示偏好。',
      },
      { id: 'appearance', label: '外观', icon: Palette, description: '调整主题、字号和界面效果。' },
      { id: 'profile', label: '用量', icon: ChartNoAxesCombined, description: '查看 Token 用量与活动记录。' },
    ],
  },
  {
    label: 'Agent',
    sections: [
      { id: 'models', label: '模型', icon: Sparkles, description: '连接服务商并选择默认模型。' },
      { id: 'subagents', label: '子代理', icon: Users, description: '设置子代理默认使用的模型和思考强度。' },
      { id: 'instructions', label: '指令', icon: ScrollText, description: '编辑用户指令和系统提示词。' },
      { id: 'skills', label: '技能', icon: BookOpen, description: '导入、创建和编辑技能，设置设备或项目的调用方式。' },
      {
        id: 'plugins',
        label: '插件',
        icon: PluginSettingsIcon,
        description: '安装和更新 App 插件，查看能力并启停或卸载。',
      },
      { id: 'mcp', label: 'MCP', icon: Network, description: '管理 MCP 服务和授权。' },
    ],
  },
  {
    label: '系统',
    sections: [
      {
        id: 'browser',
        label: '浏览器',
        icon: Globe,
        description: '管理此电脑的内置浏览器、网页批注、下载和网站权限。',
      },
      { id: 'host', label: '远程', icon: Server, description: '管理 HTTPS 和 SSH 远程连接，查看状态或暂停 SSH 通道。' },
      { id: 'about', label: '关于', icon: Info, description: '查看当前执行服务的 Pi 运行时。' },
    ],
  },
] as const
type Section = (typeof groups)[number]['sections'][number]
export type SettingsSection = Section['id']
const sections = groups.flatMap<Section>((group) => group.sections)

export function SettingsPage({
  renderContent,
  renderRail,
  dirty,
  saving,
  initialSection = 'general',
  nativeWindow = false,
  onDiscard,
  onDismiss,
  onProjects,
  onPlugins,
  onHome,
  dismissLabel = '返回聊天',
}: {
  renderContent: (section: SettingsSection, navigate: (section: SettingsSection) => void) => ReactNode
  renderRail?: (
    onDismiss: () => void,
    navigate: (section: SettingsSection) => void,
    onProjects?: () => void,
    onPlugins?: () => void,
  ) => ReactNode
  dirty: boolean
  saving: boolean
  initialSection?: SettingsSection
  /** Desktop 隐藏标题栏需要让出交通灯；Web 不留这段间距。 */
  nativeWindow?: boolean
  onDiscard: () => void
  onDismiss: () => void
  onProjects?: () => void
  onPlugins?: () => void
  onHome?: () => void
  dismissLabel?: string
}) {
  const [sectionId, setSectionId] = useState<SettingsSection>(initialSection)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<(() => void) | null>(null)
  const section = sections.find((entry) => entry.id === sectionId)!
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
    <section
      aria-label="设置页面"
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      <PageHeader>
        <PageHeaderNavigation
          nativeWindow={nativeWindow}
          back={{ label: dismissLabel, onClick: () => leave(onDismiss), disabled: saving, autoFocus: true }}
        />
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderRail?.(
          () => leave(onHome ?? onDismiss),
          navigate,
          onProjects ? () => leave(onProjects) : undefined,
          onPlugins ? () => leave(onPlugins) : undefined,
        )}
        <div className="content-frame bg-background">
          <aside className="appearance-sidebar settings-sidebar w-52 shrink-0 overflow-y-auto border-r border-border bg-card/40 px-2.5 py-4 sm:w-64 sm:py-5">
            <h1 className="px-2.5 text-base font-semibold tracking-tight text-foreground">设置</h1>
            <div className="relative mt-3">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground"
                strokeWidth={1.8}
              />
              <Input
                aria-label="搜索设置"
                placeholder="搜索设置"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 rounded-full border-0 bg-secondary/60 pl-8 pr-2.5 text-xs transition-colors duration-200 focus-visible:bg-secondary"
              />
            </div>
            <nav aria-label="设置分类" className="mt-4 space-y-4">
              {visibleGroups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <h2 className="mb-1 px-2.5 text-[11px] font-medium text-muted-foreground/60 select-none">
                    {group.label}
                  </h2>
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
                          'settings-nav-item flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                          sectionId === id
                            ? 'bg-secondary font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
                        )}
                      >
                        <span className="settings-nav-icon flex size-4 shrink-0 items-center justify-center">
                          <Icon aria-hidden="true" className="size-3.5 sm:size-4" strokeWidth={1.8} />
                        </span>
                        <span className="truncate">{label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {visibleGroups.length === 0 && (
                <p role="status" className="px-2.5 text-xs text-muted-foreground">
                  没有匹配的设置
                </p>
              )}
            </nav>
          </aside>
          <div
            id="settings-content"
            className="theme-workspace min-w-0 flex-1 overflow-y-auto bg-background px-6 py-8 sm:px-8 lg:px-12 lg:py-12"
          >
            <FadeContent key={sectionId} className="mx-auto max-w-3xl space-y-8">
              <div>
                <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{section.label}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{section.description}</p>
              </div>
              <Suspense fallback={<SettingsSkeleton section={sectionId} />}>
                {renderContent(sectionId, navigate)}
              </Suspense>
            </FadeContent>
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
