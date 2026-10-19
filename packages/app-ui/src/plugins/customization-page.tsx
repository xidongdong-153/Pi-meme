import { Suspense, useState, type ReactNode } from 'react'
import { BookOpen, Puzzle } from 'lucide-react'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { isReservedPluginId } from '@pi-meme/plugin-sdk/reserved'
import { cn } from '@pi-meme/ui/lib/utils'
import { PageHeader, PageHeaderNavigation } from '../layout/page-header'
import { PluginIcon } from '../settings/plugin-page'
import { SettingsSkeleton } from '../settings/settings-skeleton'

export function CustomizationPage({
  plugins,
  nativeWindow,
  rail,
  onDismiss,
  renderContent,
}: {
  plugins: UiPluginDescriptor[]
  nativeWindow: boolean
  rail: ReactNode
  onDismiss: () => void
  renderContent: (
    section: 'plugins' | 'skills',
    selection: { id?: string; onChange: (id?: string) => void },
  ) => ReactNode
}) {
  const [section, setSection] = useState<'plugins' | 'skills'>('plugins')
  const [selectedPlugin, setSelectedPlugin] = useState<string>()
  const installed = plugins.filter((plugin) => !plugin.builtin && !isReservedPluginId(plugin.id))

  return (
    <section
      aria-label="插件与技能页面"
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      <PageHeader>
        <PageHeaderNavigation nativeWindow={nativeWindow} back={{ label: '返回聊天', onClick: onDismiss }} />
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {rail}
        <div className="content-frame bg-background">
          <aside className="appearance-sidebar w-44 shrink-0 overflow-y-auto border-r border-border bg-card/40 px-2.5 py-5 sm:w-64">
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
                {!installed.length && <p className="px-2.5 text-xs text-muted-foreground">暂无已安装插件</p>}
              </div>
            </section>
          </aside>
          <div
            id="customization-content"
            className="theme-workspace min-w-0 flex-1 overflow-y-auto bg-background px-6 py-8 sm:px-8 lg:px-12 lg:py-12"
          >
            <div className="mx-auto max-w-6xl">
              <Suspense fallback={<SettingsSkeleton section={section} />}>
                {renderContent(section, { id: selectedPlugin, onChange: setSelectedPlugin })}
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
