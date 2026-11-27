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
  X,
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

export const SETTINGS_GROUPS = [
  {
    label: '个人',
    sections: [
      {
        id: 'general',
        label: '常规',
        icon: Settings,
        description:
          '设置任务进度、输入预测、上下文用量显示、默认访问权限、应用存储目录和缓存清理，从本地 Pi 迁移配置。',
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
      { id: 'about', label: '关于', icon: Info, description: '查看 Pi meme 和 Pi 运行时版本，检查应用更新。' },
    ],
  },
] as const

type Section = (typeof SETTINGS_GROUPS)[number]['sections'][number]
export type SettingsSection = Section['id']
const sections = SETTINGS_GROUPS.flatMap<Section>((group) => group.sections)

const MOBILE_HIDDEN_SECTIONS: ReadonlySet<SettingsSection> = new Set(['shortcuts', 'computer'])

export function isMobileSettingsSectionAvailable(sectionId: SettingsSection, showBrowser = false): boolean {
  if (MOBILE_HIDDEN_SECTIONS.has(sectionId)) return false
  if (sectionId === 'browser' && !showBrowser) return false
  return true
}

export function resolveMobileSettingsSection(sectionId: SettingsSection, showBrowser = false): SettingsSection {
  return isMobileSettingsSectionAvailable(sectionId, showBrowser) ? sectionId : 'general'
}

export function getSettingsSection(sectionId: SettingsSection): Section {
  return sections.find((entry) => entry.id === sectionId) ?? sections[0]!
}

type SettingsNavigationProps = {
  sectionId: SettingsSection
  saving: boolean
  onNavigate: (section: SettingsSection) => void
}

export function SettingsDirectory({
  sectionId,
  saving,
  onNavigate,
  mobile = false,
  showBrowser = true,
  className,
}: SettingsNavigationProps & {
  mobile?: boolean
  showBrowser?: boolean
  className?: string
}) {
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const visibleGroups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((entry) => {
      if (mobile && !isMobileSettingsSectionAvailable(entry.id, showBrowser)) return false
      return `${entry.label} ${entry.description} ${entry.id}`.toLowerCase().includes(search)
    }),
  })).filter((group) => group.sections.length > 0)

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className={cn('shrink-0', mobile ? 'px-3 pt-1 pb-2.5' : 'px-3 pt-2 pb-2')}>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            aria-label="搜索设置"
            placeholder="搜索设置"
            autoFocus={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={cn(
              'rounded-full border-foreground/15 bg-transparent pl-8.5 shadow-none focus-visible:border-foreground/35 focus-visible:ring-0',
              mobile ? 'h-9 pr-8 text-base' : 'h-9 text-xs',
            )}
          />
          {mobile && query && (
            <button
              type="button"
              aria-label="清空设置搜索"
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground active:bg-secondary active:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <nav
        aria-label="设置分类"
        className={cn(
          'min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
          mobile ? 'px-2 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]' : 'px-2.5 pt-1 pb-5',
        )}
      >
        {visibleGroups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className={cn('mb-1.5 text-xs font-medium text-muted-foreground', mobile ? 'px-3' : 'px-2.5')}>
              {group.label}
            </h3>
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
                    'settings-nav-item flex w-full items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
                    mobile ? 'min-h-[42px] rounded-xl px-3 py-2 text-[14px]' : 'h-8 rounded-lg px-2.5 text-[13px]',
                    sectionId === id
                      ? 'bg-foreground/9 font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground active:bg-foreground/8',
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
          <p role="status" className="px-3 text-xs text-muted-foreground">
            没有匹配的设置
          </p>
        )}
      </nav>
    </div>
  )
}

function SettingsNavigation({ sectionId, saving, onNavigate }: SettingsNavigationProps) {
  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-b border-border/70 bg-secondary/45 pt-[env(safe-area-inset-top)] sm:pt-0 @min-[660px]/settings:w-[clamp(11.5rem,22cqw,14.5rem)] @min-[660px]/settings:border-r @min-[660px]/settings:border-b-0">
      <div className="flex shrink-0 items-center gap-4 px-4 py-3 pr-14 @min-[660px]/settings:block @min-[660px]/settings:px-3 @min-[660px]/settings:pt-4 @min-[660px]/settings:pb-1">
        <DialogTitle className="shrink-0 whitespace-nowrap text-base font-semibold @min-[660px]/settings:px-1.5">
          设置
        </DialogTitle>
        <div className="min-w-0 flex-1 @min-[660px]/settings:hidden">
          <Select value={sectionId} onValueChange={(value) => onNavigate(value as SettingsSection)} disabled={saving}>
            <SelectTrigger aria-label="设置分类" className="h-8 bg-transparent text-xs shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" align="start">
              {SETTINGS_GROUPS.map((group) => (
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
      <div className="hidden min-h-0 flex-1 flex-col @min-[660px]/settings:flex">
        <SettingsDirectory sectionId={sectionId} saving={saving} onNavigate={onNavigate} />
      </div>
    </aside>
  )
}

function SettingsPanel({
  sectionId,
  hideSectionTitle = false,
  renderContent,
}: {
  sectionId: SettingsSection
  hideSectionTitle?: boolean
  renderContent: (section: SettingsSection) => ReactNode
}) {
  const section = getSettingsSection(sectionId)
  return (
    <section
      id="settings-content"
      aria-labelledby="settings-section-title"
      tabIndex={-1}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-[clamp(1rem,3.8cqw,3rem)] py-[clamp(1.25rem,3.5dvh,2.5rem)] pb-[max(clamp(1.25rem,3.5dvh,2.5rem),env(safe-area-inset-bottom))] outline-none [scrollbar-gutter:stable]"
    >
      <div className="mx-auto max-w-[44rem] space-y-7">
        {!hideSectionTitle && (
          <h2 id="settings-section-title" className="pr-10 text-xl font-semibold tracking-tight sm:text-2xl">
            {section.label}
          </h2>
        )}
        <div className="min-w-0 space-y-6 text-xs">{renderContent(sectionId)}</div>
      </div>
    </section>
  )
}

export function SettingsDialog({
  open,
  sectionId,
  saving,
  hideSectionTitle = false,
  onNavigate,
  onDismiss,
  onReturnFocus,
  renderContent,
}: SettingsNavigationProps & {
  open: boolean
  hideSectionTitle?: boolean
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
          <SettingsPanel
            key={sectionId}
            sectionId={sectionId}
            hideSectionTitle={hideSectionTitle}
            renderContent={renderContent}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
