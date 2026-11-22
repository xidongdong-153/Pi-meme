import { useState, type ReactNode } from 'react'
import {
  Globe,
  Monitor,
  BookOpen,
  ChartNoAxesCombined,
  Circle,
  Info,
  Image,
  Keyboard,
  Network,
  Brain,
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
import { Input } from '@pi-meme/ui/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@pi-meme/ui/components/ui/select'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { cn } from '@pi-meme/ui/lib/utils'

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
        description: '设置任务进度、输入预测、上下文用量显示、默认访问权限、应用存储目录和缓存清理。',
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
      { id: 'appearance', label: '外观', icon: Palette, description: '调整完整视图、主题、字号和界面效果。' },
      { id: 'profile', label: '用量', icon: ChartNoAxesCombined, description: '查看 Token 用量与活动记录。' },
    ],
  },
  {
    label: 'Agent',
    sections: [
      { id: 'models', label: '模型', icon: Sparkles, description: '连接服务商并选择默认模型。' },
      { id: 'image-generation', label: '图片生成', icon: Image, description: '配置生成和编辑图片使用的服务与模型。' },
      { id: 'subagents', label: '子代理', icon: Users, description: '设置子代理默认使用的模型和思考强度。' },
      { id: 'instructions', label: '指令', icon: ScrollText, description: '编辑用户指令和系统提示词。' },
      { id: 'memory', label: '记忆', icon: Brain, description: '启停记忆与自动学习，管理项目和通用记忆。' },
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
      { id: 'computer', label: '电脑操控', icon: Monitor, description: '管理此电脑的应用访问与系统权限。' },
      { id: 'host', label: '远程', icon: Server, description: '管理 HTTPS 和 SSH 远程连接，查看状态或暂停 SSH 通道。' },
      { id: 'about', label: '关于', icon: Info, description: '查看当前执行服务的 Pi 运行时。' },
    ],
  },
] as const
type Section = (typeof groups)[number]['sections'][number]
export type SettingsSection = Section['id']
const sections = groups.flatMap<Section>((group) => group.sections)

type SettingsNavigationProps = {
  sectionId: SettingsSection
  saving: boolean
  onNavigate: (section: SettingsSection) => void
}

function SettingsNavigation({ sectionId, saving, onNavigate }: SettingsNavigationProps) {
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((entry) =>
        `${entry.label} ${entry.description} ${entry.id}`.toLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.sections.length > 0)

  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-b border-border/70 bg-secondary/45 pt-[env(safe-area-inset-top)] sm:pt-0 @min-[660px]/settings:w-[clamp(11.5rem,22cqw,14.5rem)] @min-[660px]/settings:border-r @min-[660px]/settings:border-b-0">
      <div className="flex shrink-0 items-center gap-4 px-4 py-3 pr-14 @min-[660px]/settings:block @min-[660px]/settings:px-3 @min-[660px]/settings:pt-4 @min-[660px]/settings:pb-2">
        <DialogTitle className="shrink-0 whitespace-nowrap text-base font-semibold @min-[660px]/settings:px-1.5">
          设置
        </DialogTitle>
        <div className="relative mt-3 hidden @min-[660px]/settings:block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            aria-label="搜索设置"
            placeholder="搜索设置"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 rounded-full border-foreground/15 bg-transparent pl-8.5 text-xs shadow-none focus-visible:border-foreground/35 focus-visible:ring-0"
          />
        </div>
        <div className="min-w-0 flex-1 @min-[660px]/settings:hidden">
          <Select value={sectionId} onValueChange={(value) => onNavigate(value as SettingsSection)} disabled={saving}>
            <SelectTrigger aria-label="设置分类" className="h-8 bg-transparent text-xs shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" align="start">
              {groups.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.sections.map(({ id, label }) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <nav
        aria-label="设置分类"
        className="hidden min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-2.5 pt-3 pb-5 [scrollbar-gutter:stable] @min-[660px]/settings:block"
      >
        {visibleGroups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="mb-1.5 px-2.5 text-xs font-medium text-muted-foreground">{group.label}</h3>
            <div className="space-y-0.5">
              {group.sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-current={sectionId === id ? 'page' : undefined}
                  aria-controls="settings-content"
                  disabled={saving}
                  onClick={() => onNavigate(id)}
                  className={cn(
                    'settings-nav-item flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
                    sectionId === id
                      ? 'bg-foreground/9 font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden="true" className="settings-nav-icon size-4 shrink-0" strokeWidth={1.65} />
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
  )
}

function SettingsPanel({
  sectionId,
  renderContent,
}: {
  sectionId: SettingsSection
  renderContent: (section: SettingsSection) => ReactNode
}) {
  const section = sections.find((entry) => entry.id === sectionId)!
  return (
    <section
      id="settings-content"
      aria-labelledby="settings-section-title"
      tabIndex={-1}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-[clamp(1rem,3.8cqw,3rem)] py-[clamp(1.25rem,3.5dvh,2.5rem)] pb-[max(clamp(1.25rem,3.5dvh,2.5rem),env(safe-area-inset-bottom))] outline-none [scrollbar-gutter:stable]"
    >
      <div className="mx-auto max-w-[44rem] space-y-7">
        <h2 id="settings-section-title" className="pr-10 text-xl font-semibold tracking-tight sm:text-2xl">
          {section.label}
        </h2>
        <div className="min-w-0 space-y-6 text-xs">{renderContent(sectionId)}</div>
      </div>
    </section>
  )
}

export function SettingsDialog({
  open,
  sectionId,
  saving,
  onNavigate,
  onDismiss,
  onReturnFocus,
  renderContent,
}: SettingsNavigationProps & {
  open: boolean
  onDismiss: () => void
  onReturnFocus: () => void
  renderContent: (section: SettingsSection) => ReactNode
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        overlayClassName="bg-black/45 backdrop-blur-[3px]"
        className="no-drag @container/settings block h-dvh max-h-none w-dvw max-w-none gap-0 rounded-none border-0 bg-popover p-0 text-popover-foreground shadow-2xl sm:h-[min(calc(100dvh-2rem),clamp(32rem,84dvh,52rem))] sm:w-[min(calc(100vw-2rem),clamp(45rem,84vw,68rem))] sm:rounded-2xl sm:border sm:border-border/70"
        closeButtonProps={{
          'aria-label': '关闭设置',
          disabled: saving,
          className:
            'right-2.5 top-[max(0.625rem,env(safe-area-inset-top))] grid size-8 place-items-center rounded-full text-muted-foreground opacity-100 hover:bg-foreground/5 hover:text-foreground disabled:opacity-40 sm:right-3.5 sm:top-3.5',
        }}
        onEscapeKeyDown={(event) => {
          if (
            event.isComposing ||
            (event.target instanceof Element && event.target.closest('[data-shortcut-recording]'))
          )
            event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onReturnFocus()
        }}
      >
        <div className="flex size-full min-h-0 min-w-0 flex-col @min-[660px]/settings:flex-row">
          <SettingsNavigation sectionId={sectionId} saving={saving} onNavigate={onNavigate} />
          <SettingsPanel key={sectionId} sectionId={sectionId} renderContent={renderContent} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
