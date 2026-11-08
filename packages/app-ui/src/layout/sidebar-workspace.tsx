import type { ComponentProps, ReactNode } from 'react'
import { PageHeader, PageHeaderNavigation, PageHeaderSidebar } from './page-header'
import type { SidebarFlyoutControl } from './sidebar-flyout'
import type { SidebarLayout } from './use-sidebar-layout'
import { SidebarToggle, useSidebarContainer, useWorkspaceSidebar, WorkspaceSidebar } from './workspace-sidebar'

/** 列表/分类与正文共用的页面壳；业务页面不再处理侧栏宽度、断点或浮层。 */
export function SidebarWorkspace({
  visible = true,
  label,
  sidebarLabel,
  layout,
  navigation,
  rail,
  sidebar,
  children,
}: {
  visible?: boolean
  label: string
  sidebarLabel: string
  layout: SidebarLayout
  navigation: ComponentProps<typeof PageHeaderNavigation>
  rail: (flyout: SidebarFlyoutControl | undefined) => ReactNode
  sidebar: ReactNode
  children: ReactNode
}) {
  const { container, width } = useSidebarContainer()
  const state = useWorkspaceSidebar({ layout, containerWidth: width, visible })
  return (
    <section
      aria-label={label}
      data-pane-sidebar={state.open ? 'open' : 'closed'}
      data-motion={state.directMotion ? 'direct' : 'slide'}
      data-overscroll={state.pane.overscroll ? 'sidebar' : undefined}
      style={state.style}
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      <PageHeader>
        <PageHeaderSidebar open={state.open}>
          <PageHeaderNavigation {...navigation} />
          <SidebarToggle sidebar={state} />
        </PageHeaderSidebar>
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {rail(state.flyout.control)}
        <div ref={container} className="content-frame relative bg-background">
          <WorkspaceSidebar sidebar={state} label={sidebarLabel}>
            {sidebar}
          </WorkspaceSidebar>
          {children}
        </div>
      </div>
    </section>
  )
}
