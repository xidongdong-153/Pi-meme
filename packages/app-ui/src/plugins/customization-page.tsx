import { useState, type ReactNode } from 'react'
import { BookOpen, Puzzle } from 'lucide-react'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { isReservedPluginId } from '@pi-meme/plugin-sdk/reserved'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { cn } from '@pi-meme/ui/lib/utils'
import { SidebarWorkspace } from '../layout/sidebar-workspace'
import type { SidebarFlyoutControl } from '../layout/sidebar-flyout'
import type { SidebarLayout } from '../layout/use-sidebar-layout'
import { PluginIcon } from '../settings/plugin-page'

export function CustomizationPage({
  plugins,
  nativeWindow,
  rail,
  sidebarLayout,
  onDismiss,
  renderContent,
}: {
  plugins: UiPluginDescriptor[]
  nativeWindow: boolean
  rail: (flyout: SidebarFlyoutControl | undefined) => ReactNode
  sidebarLayout: SidebarLayout
  onDismiss: () => void
  renderContent: (
    section: 'plugins' | 'skills',
    selection: { id?: string; onChange: (id?: string) => void },
  ) => ReactNode
}) {
  const [section, setSection] = useState<'plugins' | 'skills'>('plugins')
  const [selectedPlugin, setSelectedPlugin] = useState<string>()
  const installed = plugins.filter((plugin) => !plugin.builtin && !isReservedPluginId(plugin.id))

  const sidebar = (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-5">
      <h2 className="px-2.5 text-base font-semibold tracking-tight">自定义</h2>
      <nav aria-label="自定义分类" className="mt-5 space-y-1">
        {(
          [
            { id: 'plugins', label: '插件', icon: Puzzle },
            { id: 'skills', label: '技能', icon: BookOpen },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id && !selectedPlugin ? 'page' : undefined}
            aria-controls="customization-content"
            onClick={() => {
              setSection(id)
              setSelectedPlugin(undefined)
            }}
            className={cn(
              'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              section === id && !selectedPlugin
                ? 'bg-secondary font-medium'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>
      <section aria-label="已安装插件" className="mt-7">
        <h3 className="mb-2 px-2.5 text-xs font-medium text-muted-foreground">已安装</h3>
        <div className="space-y-0.5">
          {installed.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              aria-label={`打开插件：${plugin.display?.name ?? plugin.id}`}
              aria-current={section === 'plugins' && selectedPlugin === plugin.id ? 'page' : undefined}
              aria-controls="customization-content"
              onClick={() => {
                setSection('plugins')
                setSelectedPlugin(plugin.id)
              }}
              className={cn(
                'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                section === 'plugins' && selectedPlugin === plugin.id && 'bg-secondary',
              )}
            >
              <PluginIcon plugin={plugin} compact className="size-4 rounded-sm" />
              <span className="truncate">{plugin.display?.name ?? plugin.id}</span>
            </button>
          ))}
          {!installed.length && (
            <p className="px-2.5 text-xs text-muted-foreground">
              <CrossfadeText>暂无已安装插件</CrossfadeText>
            </p>
          )}
        </div>
      </section>
    </div>
  )
  return (
    <SidebarWorkspace
      label="插件与技能页面"
      sidebarLabel="插件与技能导航"
      layout={sidebarLayout}
      navigation={{ nativeWindow, back: { label: '返回聊天', onClick: onDismiss } }}
      rail={rail}
      sidebar={sidebar}
    >
      <div
        id="customization-content"
        className="theme-workspace min-w-0 flex-1 overflow-y-auto bg-background px-6 py-8 sm:px-8 lg:px-12 lg:py-12"
      >
        <div className="mx-auto max-w-6xl">
          {renderContent(section, { id: selectedPlugin, onChange: setSelectedPlugin })}
        </div>
      </div>
    </SidebarWorkspace>
  )
}
